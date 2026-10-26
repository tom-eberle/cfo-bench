import { basename } from 'node:path';
import { z } from 'zod';
import { ComptaError, ExitCode, usageError } from '../output/errors.js';
import { analyzeDocumentText, type DocumentFacts, extractPdfText } from '../pdf/extract.js';
import { mimeType } from '../plan/attachments.js';
import { type DateRange, inRange } from '../util/dates.js';
import { includesLoose } from '../util/text.js';
import { type Cache, DAY } from './cache.js';
import type { ApiClient } from './client.js';
import { isActive, normalizeAccount, normalizeCategory, normalizeOperation } from './normalize.js';
import {
  type Account,
  type Attachment,
  type Category,
  type Operation,
  type RawCategory,
  type RawFiscalYear,
  type RawLine,
  type RawPurchaseInvoice,
  type RawTransaction,
  type RawVatReturnSummary,
  rawBankAccountSchema,
  rawCategorySchema,
  rawFiscalYearSchema,
  rawPurchaseInvoiceSchema,
  rawTransactionSchema,
  rawVatReturnSchema,
  rawVatReturnSummarySchema,
} from './schemas.js';

export const PAGE_SIZE = 40;

/** Cache key of the category list (the cache root carries the API origin, company and schema version). */
export const CATEGORIES_KEY = 'categories.json';

/** The category ids a transaction's lines reference. */
export function categoryIds(raw: Pick<RawTransaction, 'lines'>): number[] {
  return raw.lines.flatMap((l) => (l.category_id == null ? [] : [l.category_id]));
}

/**
 * VAT return statuses: the API's (`filed`, `to_file`, `upcoming`) and the CLI's
 * normalized names for them, which its JSON output keeps.
 */
export const VAT_RETURN_STATUSES = {
  filed: 'completed',
  to_file: 'ready_to_complete',
  upcoming: 'upcoming',
} as const;
export type VatReturnStatus = (typeof VAT_RETURN_STATUSES)[keyof typeof VAT_RETURN_STATUSES];
export type VatReturnSummary = RawVatReturnSummary & { status: VatReturnStatus };

/** The return's type as the CLI prints it, e.g. `CA3-2026` (form family and vintage). */
export function returnType(d: Pick<RawVatReturnSummary, 'return_type' | 'form_year'>): string {
  return d.form_year ? `${d.return_type}-${d.form_year}` : d.return_type;
}

/** Any VAT return: monthly/quarterly CA3, annual CA12 (simplified regime), or tax family `vat`. */
export function isVatReturn(d: Pick<RawVatReturnSummary, 'return_type' | 'tax'>): boolean {
  return /^(CA3|CA12|3310|3517)/i.test(d.return_type) || !!d.tax?.startsWith('vat');
}

/** CA3 box keys of the API, as the CLI's box names (`08_tax` → `08:VAT`); others unchanged. */
const BOX_NAMES: Record<string, string> = {
  '08_tax': '08:VAT',
  '9B_tax': '9B:VAT',
  '09_tax': '09:VAT',
  A3_eu: 'A3:01',
  A3_non_eu: 'A3:02',
  '20_domestic': '20:A',
  '20_eu_reverse_charge': '20:B',
  '20_non_eu_reverse_charge': '20:C',
};

/** A return's boxes keyed by the CLI's box names. */
export function boxesByName(
  boxes: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!boxes) return null;
  return Object.fromEntries(Object.entries(boxes).map(([k, v]) => [BOX_NAMES[k] ?? k, v]));
}

/** Answers "why must this date not be edited?" (null when it may be). */
export interface PeriodGuard {
  reason(date: string): string | null;
}

export type ValidationStatus = 'all' | 'validated' | 'unvalidated';

export interface OperationFilter extends DateRange {
  status?: ValidationStatus;
  search?: string;
  direction?: 'expense' | 'income';
  category?: number;
  missingReceipt?: boolean;
  /** Stop after this many matches (newest first). Omit for everything. */
  limit?: number;
}

export interface OperationRecord {
  raw: RawTransaction;
  op: Operation;
}

/** The fields a transaction update may send (API: PATCH …/transactions/{id}). */
export interface TransactionPatch {
  note?: string | null;
  validated?: boolean;
  /** The full list of lines (it replaces them all). */
  lines?: RawLine[];
}

/** Strip the local `{opId}_` prefix: Compta displays the uploaded filename. */
export function uploadName(file: string): string {
  return basename(file).replace(/^\d+_/, '');
}

function parseOrDrift<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new ComptaError(
    'API_SHAPE',
    `Unexpected ${what} shape from Compta (${issue?.path.join('.') || 'root'}: ${issue?.message})`,
    { exitCode: ExitCode.network, hint: 'the API may have changed; run: compta doctor' },
  );
}

function matchesFilter(op: Operation, f: OperationFilter): boolean {
  if (!inRange(op.date, f)) return false;
  if (f.direction && op.direction !== f.direction) return false;
  if (f.missingReceipt && op.attachments.length > 0) return false;
  if (
    f.category !== undefined &&
    !op.breakdowns.some((b) => !b.isCounterpart && (b.category?.id ?? -1) === f.category)
  )
    return false;
  if (f.search && !includesLoose(`${op.wording} ${op.memo ?? ''}`, f.search)) return false;
  return true;
}

/** Company-scoped access to the Compta API, returning normalized data. */
export class Compta {
  private accountNames?: Promise<Map<string, string>>;
  private categoryList?: Promise<RawCategory[]>;
  /** The category list was read from the API (not the cache) in this process. */
  private categoriesFresh = false;

  constructor(
    readonly client: ApiClient,
    readonly company: string,
    private readonly cache: Cache,
  ) {}

  private path(suffix = ''): string {
    return `/v1/companies/${this.company}${suffix}`;
  }

  transactionPath(id: string): string {
    if (!/^\d+$/.test(id)) throw usageError(`Operation ids are numeric, got "${id}"`);
    return this.path(`/transactions/${id}`);
  }

  private normalize(
    raw: RawTransaction,
    categories: ReadonlyMap<number, RawCategory>,
    accounts?: ReadonlyMap<string, string>,
  ): Operation {
    return normalizeOperation(raw, {
      company: this.company,
      apiBase: this.client.baseUrl,
      accounts,
      categories,
    });
  }

  // ── transactions ────────────────────────────────────────────────────

  async transactionsPage(validated: boolean, offset: number): Promise<RawTransaction[]> {
    const query = `limit=${PAGE_SIZE}&offset=${offset}&validated=${validated}`;
    const page = await this.client.get(this.path(`/transactions?${query}`));
    return parseOrDrift(z.array(rawTransactionSchema), page, 'transactions list');
  }

  /**
   * Fetch operations newest-first. The API returns each list (validated /
   * unvalidated) sorted by date descending, so paging stops as soon as a page
   * ends before `from`, or once `limit` matches are certain.
   */
  async listOperations(filter: OperationFilter = {}): Promise<OperationRecord[]> {
    const status = filter.status ?? 'all';
    const lists = status === 'all' ? [true, false] : [status === 'validated'];
    const [accounts, categories] = await Promise.all([this.accountNameMap(), this.categoryMap()]);
    const shared = { categories };
    const streams = await Promise.all(
      lists.map((validated) => this.collect(validated, filter, accounts, shared)),
    );
    const merged = new Map<string, OperationRecord>();
    for (const record of streams.flat()) merged.set(record.op.id, record);
    const sorted = [...merged.values()].sort(
      (a, b) => b.op.date.localeCompare(a.op.date) || Number(b.op.id) - Number(a.op.id),
    );
    return filter.limit === undefined ? sorted : sorted.slice(0, filter.limit);
  }

  private async collect(
    validated: boolean,
    filter: OperationFilter,
    accounts: Map<string, string>,
    shared: { categories: Map<number, RawCategory> },
  ): Promise<OperationRecord[]> {
    const out: OperationRecord[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await this.transactionsPage(validated, offset);
      const ids = page.flatMap(categoryIds);
      if (ids.some((id) => !shared.categories.has(id)))
        shared.categories = await this.categoryMap(ids);
      const categories = shared.categories;
      let sorted = true;
      for (let i = 0; i < page.length; i++) {
        const raw = page[i]!;
        if (i > 0 && raw.date > page[i - 1]!.date) sorted = false;
        if (!isActive(raw)) continue;
        const op = this.normalize(raw, categories, accounts);
        if (matchesFilter(op, filter)) out.push({ raw, op });
      }
      if (page.length < PAGE_SIZE) break;
      const oldest = page.at(-1)?.date ?? '';
      if (sorted && filter.from && oldest < filter.from) break;
      if (sorted && filter.limit !== undefined && out.length >= filter.limit) break;
    }
    return out;
  }

  async getRaw(id: string): Promise<RawTransaction> {
    return parseOrDrift(
      rawTransactionSchema,
      await this.client.get(this.transactionPath(id)),
      'transaction',
    );
  }

  async getOperation(id: string): Promise<OperationRecord> {
    const raw = await this.getRaw(id);
    const [accounts, categories] = await Promise.all([
      this.accountNameMap(),
      this.categoryMap(categoryIds(raw)),
    ]);
    return { raw, op: this.normalize(raw, categories, accounts) };
  }

  /** Normalize a raw transaction read through this company (e.g. after a write). */
  async operationOf(raw: RawTransaction): Promise<Operation> {
    return this.normalize(raw, await this.categoryMap(categoryIds(raw)));
  }

  /**
   * Update a transaction (note, validation flag and/or the full list of lines),
   * then return its re-read state.
   */
  async updateTransaction(id: string, patch: TransactionPatch): Promise<RawTransaction> {
    await this.client.patch(this.transactionPath(id), patch);
    return this.getRaw(id);
  }

  /** Upload documents already read and validated by the caller (see plan/attachments). */
  async attachFiles(opId: string, files: { bytes: Uint8Array; name: string }[]): Promise<void> {
    const form = new FormData();
    for (const file of files)
      form.append(
        'file',
        new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: mimeType(file.name) }),
        file.name,
      );
    await this.client.post(`${this.transactionPath(opId)}/attachments`, form);
  }

  /** Attach a document that already exists in the company (attached elsewhere, or detached). */
  async linkDocument(opId: string, documentId: string): Promise<void> {
    if (!/^\d+$/.test(documentId))
      throw usageError(`Document ids are numeric, got "${documentId}"`);
    await this.client.post(`${this.transactionPath(opId)}/attachments/existing`, {
      document_id: Number(documentId),
    });
  }

  async detachAttachment(opId: string, attachmentId: string): Promise<void> {
    if (!/^\d+$/.test(attachmentId))
      throw usageError(`Attachment ids are numeric, got "${attachmentId}"`);
    await this.client.delete(`${this.transactionPath(opId)}/attachments/${attachmentId}`);
  }

  // ── reference data ──────────────────────────────────────────────────

  async accounts(): Promise<{ raw: unknown; data: Account[] }> {
    const raw = await this.client.get(this.path('/bank-accounts'));
    const parsed = parseOrDrift(z.array(rawBankAccountSchema), raw, 'bank accounts');
    return { raw, data: parsed.map(normalizeAccount) };
  }

  private accountNameMap(): Promise<Map<string, string>> {
    this.accountNames ??= this.accounts().then(
      ({ data }) => new Map(data.map((a) => [a.id, a.name])),
      () => new Map(),
    );
    return this.accountNames;
  }

  /**
   * Full category list, cached for 24 h; read once per process (concurrent callers share it).
   * The cache is scoped by API origin, company and cache schema version (`cacheRoot`).
   */
  rawCategories(): Promise<RawCategory[]> {
    this.categoryList ??= (async () => {
      const cached = await this.cache.getJson<unknown>(CATEGORIES_KEY, DAY);
      if (cached !== undefined) {
        const parsed = z.array(rawCategorySchema).safeParse(cached);
        if (parsed.success) return parsed.data;
      }
      return this.fetchCategories();
    })();
    return this.categoryList;
  }

  private async fetchCategories(): Promise<RawCategory[]> {
    const raw = await this.client.get(this.path('/categories?view=full'));
    const parsed = parseOrDrift(z.array(rawCategorySchema), raw, 'categories');
    this.categoriesFresh = true;
    await this.cache.setJson(CATEGORIES_KEY, raw);
    return parsed;
  }

  /**
   * Every category by id (raw): lines name their category through it. When a cached list
   * lacks one of `ids` (categories referenced by the data at hand), the list is read again
   * from the API, once per process: the taxonomy changed since it was cached.
   */
  async categoryMap(ids: Iterable<number> = []): Promise<Map<number, RawCategory>> {
    const map = new Map((await this.rawCategories()).map((c) => [c.id, c]));
    if (this.categoriesFresh || [...ids].every((id) => map.has(id))) return map;
    this.categoryList = this.fetchCategories();
    return new Map((await this.categoryList).map((c) => [c.id, c]));
  }

  /** Categories a user can pick (not hidden, assignable). */
  async categories(): Promise<Category[]> {
    const raw = await this.rawCategories();
    return raw.filter((c) => !c.hidden && c.assignable !== false).map(normalizeCategory);
  }

  async categoryIndex(): Promise<Map<number, Category>> {
    return new Map((await this.rawCategories()).map((c) => [c.id, normalizeCategory(c)]));
  }

  /** The platform's reading of a supplier invoice; cached once the extraction is done. */
  async purchaseInvoice(id: string): Promise<RawPurchaseInvoice> {
    const key = `purchase-invoices/${id}.json`;
    const cached = await this.cache.getJson<unknown>(key, DAY);
    const raw =
      cached ?? (await this.client.get(this.path(`/purchase-invoices/${encodeURIComponent(id)}`)));
    const parsed = parseOrDrift(rawPurchaseInvoiceSchema, raw, 'purchase invoice');
    if (cached === undefined && parsed.extraction_status === 'done')
      await this.cache.setJson(key, raw);
    return parsed;
  }

  async downloadAttachment(att: Attachment): Promise<Uint8Array> {
    const path =
      att.downloadPath ??
      (att.vendorInvoiceId
        ? (await this.purchaseInvoice(att.vendorInvoiceId)).file?.download_url
        : null);
    if (!path?.startsWith('/'))
      throw new ComptaError('FILE_MISSING', `Attachment ${att.id} has no downloadable file`, {
        exitCode: ExitCode.notFound,
      });
    return this.client.download(path);
  }

  /** Extracted text of a PDF attachment; file contents are immutable, so cached forever. */
  async attachmentText(att: Attachment): Promise<string | null> {
    const isPdf = att.mimeType === 'application/pdf' || /\.pdf$/i.test(att.filename);
    if (!isPdf || !att.fileId) return null;
    const key = `pdf-text/${att.fileId}.txt`;
    const cached = await this.cache.getText(key);
    if (cached !== undefined) return cached;
    let text: string;
    try {
      text = await extractPdfText(await this.downloadAttachment(att));
    } catch {
      return null; // not cached: a failed download or parse is retried next time
    }
    await this.cache.setText(key, text);
    return text;
  }

  async attachmentFacts(att: Attachment): Promise<DocumentFacts | null> {
    const text = await this.attachmentText(att);
    return text ? analyzeDocumentText(text) : null;
  }

  async fiscalYears(): Promise<RawFiscalYear[]> {
    return parseOrDrift(
      z.array(rawFiscalYearSchema),
      await this.client.get(this.path('/fiscal-years')),
      'fiscal years',
    );
  }

  /**
   * VAT return summaries in every status: `filed`, and the open ones (`to_file`,
   * `upcoming`; Compta computes draft figures for these too). Dismissed returns
   * are left out.
   */
  async vatReturns(): Promise<VatReturnSummary[]> {
    const lists = await Promise.all(
      (Object.keys(VAT_RETURN_STATUSES) as (keyof typeof VAT_RETURN_STATUSES)[]).map(
        async (status) => {
          const raw = await this.client.get(
            this.path(`/vat-returns?status=${status}&limit=200&offset=0`),
          );
          return parseOrDrift(z.array(rawVatReturnSummarySchema), raw, 'VAT returns').map((d) => ({
            ...d,
            status: VAT_RETURN_STATUSES[status],
          }));
        },
      ),
    );
    return lists.flat().filter((d) => !d.dismissed);
  }

  /**
   * Which dates must not be edited without --allow-filed-periods: months covered
   * by a filed CA3 (editing them desynchronizes the ledger from the return) and
   * closed fiscal years.
   */
  async periodGuard(): Promise<PeriodGuard> {
    const [returns, years] = await Promise.all([this.vatReturns(), this.fiscalYears()]);
    const filed = returns.filter((d) => d.status === 'completed' && isVatReturn(d));
    const closed = years.filter((y) => y.closed);
    return {
      reason(date: string) {
        const d = filed.find(
          (x) => date >= x.period_start.slice(0, 10) && date <= x.period_end.slice(0, 10),
        );
        if (d) return `its VAT return (${d.title ?? d.period_start.slice(0, 7)}) is already filed`;
        const y = closed.find(
          (x) => date >= x.start_date.slice(0, 10) && date <= x.end_date.slice(0, 10),
        );
        if (y)
          return `its accounting year (${y.start_date.slice(0, 10)} → ${y.end_date.slice(0, 10)}) is closed`;
        return null;
      },
    };
  }

  async vatReturn(id: string): Promise<z.infer<typeof rawVatReturnSchema>> {
    return parseOrDrift(
      rawVatReturnSchema,
      await this.client.get(this.path(`/vat-returns/${id}`)),
      'VAT return',
    );
  }
}
