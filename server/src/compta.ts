/**
 * FakeCompta: an in-memory implementation of the Compta API (server/API.md), loaded from a
 * scenario file. Originally adapted from the CLI's test fake (cli/test/helpers/fake-api.ts, MIT,
 * see cli/LICENSE), generalised to load any scenario and to serve real HTTP.
 *
 * The request handler is `handle(Request) → Response` (Web Fetch types), so it is testable
 * without sockets. Request bodies are fully read before any state is touched; everything after
 * that is synchronous, so concurrent requests never interleave inside one state change and the
 * before/after snapshots in the write log are exact.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ca3Boxes } from './ca3.ts';
import { AUTH_PREFIX, type TransactionSnapshot, WriteLog, digestBody } from './log.ts';
import {
  type Attachment,
  type Category,
  type Document,
  EXEMPTION_REASONS,
  type Json,
  type Line,
  type LoadedScenario,
  type Scenario,
  type StoredFile,
  TREATMENTS,
  type Tax,
  type Transaction,
  type Treatment,
  VAT_RETURN_STATUSES,
  type VatReturnRecord,
  exemptionPolicy,
  mimeFromName,
  sha256,
} from './scenario.ts';

/** A request body, read once and decoded by content type. */
type Body =
  | { kind: 'none' }
  | { kind: 'json'; value: unknown }
  | { kind: 'form'; value: Record<string, string> }
  | {
      kind: 'multipart';
      fields: Record<string, string>;
      files: { field: string; name: string; mimeType: string; bytes: Uint8Array }[];
    };

interface Upload {
  seq: number;
  transaction_id: number;
  attachment_id: number;
  document_id: number;
  file_key: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
}

interface StorageFetch {
  ts: string;
  file_key: string;
  status: number;
  /** Must stay false: clients never send credentials to the storage origin. */
  had_credentials: boolean;
}

export interface FakeComptaOptions {
  log?: WriteLog;
  /**
   * Origin of the signed-storage redirects, e.g. https://127.0.0.1:<apiPort>. It must differ
   * from the API origin clients use (https://localhost:<apiPort>), as a storage bucket differs
   * from the API host. Default: https://127.0.0.1.
   */
  storageOrigin?: string;
}

export const FILE_URL = /^\/v1\/files\/([^/]+)\/download$/;
const STORAGE_PREFIX = '/storage/';
const TRANSACTION_PATH = /^\/v1\/companies\/[^/]+\/transactions\/(\d+)(?:\/|$)/;

/** The `error.code` of every error response, so the write log can record it synchronously. */
const errorCodes = new WeakMap<Response, string>();

/** An error in the envelope of API.md §3. */
export function apiError(
  status: number,
  code: string,
  message: string,
  details: Json = {},
  headers?: Record<string, string>,
): Response {
  const response = Response.json({ error: { code, message, details } }, { status, headers });
  errorCodes.set(response, code);
  return response;
}

export function errorCodeOf(response: Response): string | null {
  return errorCodes.get(response) ?? null;
}

const notFound = () => apiError(404, 'NOT_FOUND', 'Not found');
const forbidden = () => apiError(403, 'FORBIDDEN', 'Forbidden');

function isObject(x: unknown): x is Json {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Round to cents: Math.round(x×100)/100 (API.md §6.2 `round2`). */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export class FakeCompta {
  readonly log: WriteLog;
  scenario!: Scenario;
  scenarioPath = '';
  transactions = new Map<string, Transaction>();
  /** Validated transactions that cannot be reopened (scenario flag `frozen`). */
  frozen = new Set<string>();
  categories = new Map<number, Category>();
  /** Every downloadable file by key: the scenario's, then uploads. Never exposed by the API. */
  files = new Map<string, StoredFile>();
  uploads: Upload[] = [];
  /**
   * Every document of the company by id (scenario attachments, then uploads), kept independently
   * of attachment relations: detaching a document does not delete it.
   */
  documents = new Map<string, Document>();
  storageFetches: StorageFetch[] = [];
  unauthorizedResponses = 0;
  remoteLogouts = 0;
  private storageOrigin?: string;
  private readonly signingKey = randomBytes(32);
  private nextAttachmentId = 0;
  private nextDocumentId = 0;
  private nextFileId = 0;

  constructor(loaded: LoadedScenario, options: FakeComptaOptions = {}) {
    this.log = options.log ?? new WriteLog();
    this.storageOrigin = options.storageOrigin;
    this.load(loaded);
  }

  setStorageOrigin(origin: string): void {
    this.storageOrigin = origin;
  }

  /** Replace all state with a fresh copy of the scenario (the log is reset by the caller). */
  load({ scenario, path, files }: LoadedScenario): void {
    this.scenario = structuredClone(scenario);
    this.scenarioPath = path;
    this.transactions.clear();
    this.frozen.clear();
    this.categories = new Map(this.scenario.categories.map((c) => [c.id, c]));
    for (const stored of this.scenario.transactions) {
      // `frozen` is a scenario flag, never served.
      const { frozen, ...tx } = stored;
      if (frozen) this.frozen.add(String(tx.id));
      // Lines in their canonical key order, so identical states compare equal in the log.
      tx.lines = tx.lines.map((l) => {
        const line = canonicalLine(l, l.tax?.deductible);
        if (typeof l.tax?.deductible !== 'number') line.tax.deductible = this.deductible(line);
        return line;
      });
      this.transactions.set(String(tx.id), tx as Transaction);
    }
    this.files = new Map(files);
    this.uploads = [];
    this.documents = new Map();
    for (const tx of this.transactions.values())
      for (const a of tx.attachments)
        if (!this.documents.has(String(a.document.id)))
          this.documents.set(String(a.document.id), structuredClone(a.document));
    this.storageFetches = [];
    this.unauthorizedResponses = 0;
    this.remoteLogouts = 0;
    const atts = [...this.transactions.values()].flatMap((tx) => tx.attachments);
    const above = (ids: unknown[], floor: number) =>
      Math.max(floor, ...ids.map(Number).filter(Number.isFinite)) + 1;
    this.nextAttachmentId = above(
      atts.map((a) => a.id),
      9_000_000,
    );
    this.nextDocumentId = above(
      atts.map((a) => a.document.id),
      8_000_000,
    );
    this.nextFileId = above(
      atts.map((a) => a.document.file?.id),
      7_000_000,
    );
  }

  get companyId(): string {
    return String(this.scenario.company.id);
  }

  // ── entry point (request order: API.md §1) ─────────────────────────

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname: path, searchParams: query } = url;
    const method = req.method.toUpperCase();
    // 1. Signed storage: no token, never logged.
    if (path.startsWith(STORAGE_PREFIX)) return this.storage(req, url);

    // 2. Read and decode the body; a malformed body is refused before authentication.
    let body: Body = { kind: 'none' };
    let malformed = false;
    try {
      body = await readBody(req);
    } catch {
      malformed = true; // still logged below
    }
    // Synchronous from here on.
    const auth = path.startsWith(AUTH_PREFIX);
    const logged = (method !== 'GET' && method !== 'HEAD') || auth;
    const opId = path.match(TRANSACTION_PATH)?.[1] ?? null;
    const before = logged && opId ? this.snapshot(opId) : null;
    const response = malformed
      ? apiError(400, 'INVALID_JSON', 'Malformed request body')
      : this.dispatch(method, path, query, req.headers, body);
    if (response.status === 401) this.unauthorizedResponses++;
    if (logged) {
      const after = opId ? this.snapshot(opId) : null;
      this.log.add({
        kind: auth ? 'auth' : 'write',
        method,
        path,
        query: Object.fromEntries(query),
        opId,
        status: response.status,
        accepted: response.status >= 200 && response.status < 300,
        errorCode: errorCodeOf(response),
        force: query.get('override_lock') === 'true',
        body: bodyDigest(path, body),
        before,
        after,
        changed: JSON.stringify(before) !== JSON.stringify(after),
      });
    }
    return response;
  }

  private dispatch(
    method: string,
    path: string,
    query: URLSearchParams,
    headers: Headers,
    body: Body,
  ): Response {
    // 3. Login steps. No valid password exists in the benchmark, so every step fails. Agents
    // never need to log in (the token is pre-provisioned); attempts are logged as `auth` records.
    if (method === 'POST' && path.startsWith(AUTH_PREFIX) && path !== '/v1/auth/logout')
      return path === '/v1/auth/login'
        ? apiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password')
        : unauthenticated();
    // 4. Bearer token: the whole header value must match.
    if (headers.get('authorization') !== `Bearer ${this.scenario.api_token}`) return unauthenticated();
    // 5. Routing.
    return this.route(method, path, query, body);
  }

  private route(method: string, path: string, query: URLSearchParams, body: Body): Response {
    if (method === 'GET' && path === '/v1/me') return Response.json(this.user());
    if (method === 'POST' && path === '/v1/auth/logout') {
      // The token stays valid, so one stray `logout --remote` does not end a run; it is counted
      // and logged.
      this.remoteLogouts++;
      return new Response(null, { status: 204 });
    }
    const file = path.match(FILE_URL);
    if (method === 'GET' && file) return this.download(decodeURIComponent(file[1]!));

    const scoped = path.match(/^\/v1\/companies\/([^/]+)(\/.*)?$/);
    if (!scoped || scoped[1] !== this.companyId) return notFound();
    const sub = scoped[2] ?? '';

    if (method === 'GET') {
      if (sub === '/bank-accounts') return Response.json(this.scenario.bank_accounts);
      if (sub === '/categories') return Response.json(this.categoryList(query));
      if (sub === '/fiscal-years') return Response.json(this.scenario.fiscal_years);
      if (sub === '/vat-returns') return this.listVatReturns(query);
      const vr = sub.match(/^\/vat-returns\/([^/]+)$/);
      if (vr) {
        const r = this.scenario.vat_returns.find((x) => String(x.summary.id) === vr[1]);
        if (!r) return notFound();
        const { summary, boxes } = this.vatReturnNow(r);
        return Response.json({ ...summary, boxes });
      }
      const pi = sub.match(/^\/purchase-invoices\/([^/]+)$/);
      if (pi) {
        const invoice = this.scenario.purchase_invoices[decodeURIComponent(pi[1]!)];
        return invoice ? Response.json(invoice) : notFound();
      }
      if (sub === '/transactions') return Response.json(this.list(query));
      const one = sub.match(/^\/transactions\/(\d+)$/);
      if (one) {
        const tx = this.transactions.get(one[1]!);
        return tx ? Response.json(tx) : notFound();
      }
      return notFound();
    }

    const one = sub.match(/^\/transactions\/(\d+)$/);
    if (method === 'PATCH' && one) return this.update(one[1]!, body, query.get('override_lock') === 'true');
    const upload = sub.match(/^\/transactions\/(\d+)\/attachments$/);
    if (method === 'POST' && upload) return this.upload(upload[1]!, body);
    const existing = sub.match(/^\/transactions\/(\d+)\/attachments\/existing$/);
    if (method === 'POST' && existing) return this.attachExisting(existing[1]!, body);
    const att = sub.match(/^\/transactions\/(\d+)\/attachments\/(\d+)$/);
    if (method === 'DELETE' && att) {
      const tx = this.transactions.get(att[1]!);
      if (!tx) return notFound();
      // Idempotent: 204 whether or not the attachment existed. The document stays in the company.
      tx.attachments = tx.attachments.filter((a) => String(a.id) !== att[2]);
      return new Response(null, { status: 204 });
    }
    return notFound();
  }

  // ── reads ──────────────────────────────────────────────────────────

  private user(): Json {
    const c = this.scenario.company;
    const companies = (this.scenario.user.companies as Json[] | undefined) ?? [
      { id: c.id, legal_name: c.legal_name, trade_name: c.trade_name },
    ];
    return { ...this.scenario.user, companies, company: c };
  }

  /**
   * Without view=full, ids only. The scenario-only keys are never served; `exemptions` is derived
   * (§5 Category).
   */
  private categoryList(query: URLSearchParams): Json[] {
    if (query.get('view') !== 'full') return this.scenario.categories.map((c) => ({ id: c.id }));
    return this.scenario.categories.map((category) => {
      const { deductible_share: _s, exemption_required: _r, ...served } = category;
      return { ...served, exemptions: exemptionPolicy(category) };
    });
  }

  /** `status` is required; summaries come without it, in scenario order, paged. */
  private listVatReturns(query: URLSearchParams): Response {
    const status = query.get('status');
    if (!VAT_RETURN_STATUSES.includes(status as VatReturnRecord['status']))
      return apiError(400, 'INVALID_PARAMETER', `status must be one of: ${VAT_RETURN_STATUSES.join(', ')}`, {
        parameter: 'status',
        allowed: [...VAT_RETURN_STATUSES],
      });
    const offset = nonNegative(query.get('offset'), 0);
    const limit = nonNegative(query.get('limit'), Number.POSITIVE_INFINITY);
    return Response.json(
      this.scenario.vat_returns
        .filter((r) => r.status === status)
        .slice(offset, offset + limit)
        .map((r) => this.vatReturnNow(r).summary),
    );
  }

  /**
   * A VAT return as served now (API.md §6.6). Filed returns are frozen. Other CA3 returns with
   * boxes are recomputed from the period's current transactions, box 22 from the latest filed
   * CA3 before them, and their `net_amount` follows (box 28, else minus box 27).
   */
  vatReturnNow(r: VatReturnRecord): VatReturnRecord {
    if (r.status === 'filed' || !isCa3(r) || !r.boxes) return r;
    const start = String(r.summary.period_start).slice(0, 10);
    const end = String(r.summary.period_end).slice(0, 10);
    const txs = [...this.transactions.values()].filter(
      (tx) => tx.date.slice(0, 10) >= start && tx.date.slice(0, 10) <= end,
    );
    const lastFiled = this.scenario.vat_returns
      .filter((x) => x.status === 'filed' && isCa3(x) && String(x.summary.period_start).slice(0, 10) < start)
      .sort((x, y) => {
        const key = (z: VatReturnRecord) =>
          `${String(z.summary.period_start).slice(0, 10)} ${z.summary.confirmed_at ?? z.summary.filed_at ?? ''}`;
        return key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0;
      })
      .at(-1);
    const credit = lastFiled?.boxes?.['27'];
    const boxes = ca3Boxes(txs, this.scenario.categories, typeof credit === 'number' ? credit : null);
    const summary =
      'net_amount' in r.summary
        ? { ...r.summary, net_amount: boxes['28'] ? boxes['28'] : -boxes['27']! || 0 }
        : r.summary;
    return { status: r.status, summary, boxes };
  }

  /** One validation status per list, newest first (date, then id, descending), then paged. */
  private list(query: URLSearchParams): Transaction[] {
    const validated = query.get('validated') === 'true';
    const offset = nonNegative(query.get('offset'), 0);
    const limit = nonNegative(query.get('limit'), 40);
    return [...this.transactions.values()]
      .filter((tx) => tx.validated === validated)
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
      .slice(offset, offset + limit);
  }

  // ── files ──────────────────────────────────────────────────────────

  /** Downloads answer 302 to a signed storage URL, to be followed without credentials. */
  private download(key: string): Response {
    if (!this.files.has(key)) return notFound();
    return new Response(null, {
      status: 302,
      headers: { location: `${this.storageBase()}${STORAGE_PREFIX}${key}?signature=${this.sign(key)}` },
    });
  }

  private storageBase(): string {
    return this.storageOrigin ?? 'https://127.0.0.1';
  }

  private sign(key: string): string {
    return createHmac('sha256', this.signingKey).update(key).digest('hex');
  }

  /** Signed storage (API.md §7.2): no token needed, a valid signature is. */
  private storage(req: Request, url: URL): Response {
    const key = decodeURIComponent(url.pathname.slice(STORAGE_PREFIX.length));
    const given = Buffer.from(url.searchParams.get('signature') ?? '', 'hex');
    const expected = Buffer.from(this.sign(key), 'hex');
    const file = this.files.get(key);
    const status =
      req.method !== 'GET'
        ? 405
        : given.length !== expected.length || !timingSafeEqual(given, expected)
          ? 403
          : file
            ? 200
            : 404;
    this.storageFetches.push({
      ts: new Date().toISOString(),
      file_key: key,
      status,
      had_credentials: req.headers.has('authorization') || req.headers.has('cookie'),
    });
    if (status === 405) return apiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed', {}, { allow: 'GET' });
    if (status === 403) return apiError(403, 'INVALID_SIGNATURE', 'Invalid signature');
    if (status !== 200 || !file) return notFound();
    return new Response(file.bytes as Uint8Array<ArrayBuffer>, {
      headers: { 'content-type': file.mimeType, 'content-length': String(file.size) },
    });
  }

  /** Deterministic file keys (API.md §7.3), so reruns of a scenario produce the same ids. */
  private newFileKey(): string {
    const h = sha256(new TextEncoder().encode(`${this.scenario.id}:upload:${this.uploads.length}`));
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }

  /** Upload (API.md §4.13): each `file` part becomes a new unclassified document. */
  private upload(txId: string, body: Body): Response {
    const tx = this.transactions.get(txId);
    if (!tx) return notFound();
    const parts = body.kind === 'multipart' ? body.files.filter((f) => f.field === 'file') : [];
    if (!parts.length)
      return apiError(400, 'FILE_REQUIRED', 'Expected multipart/form-data with at least one "file" part');
    const seq = this.log.nextSeq;
    for (const part of parts) {
      const key = this.newFileKey();
      const stored: StoredFile = {
        bytes: part.bytes,
        name: part.name,
        mimeType: part.mimeType,
        sha256: sha256(part.bytes),
        size: part.bytes.length,
        origin: { upload_seq: seq },
      };
      this.files.set(key, stored);
      const attachment: Attachment = {
        id: this.nextAttachmentId++,
        removable: true,
        document: {
          id: this.nextDocumentId++,
          kind: 'unclassified',
          purchase_invoice_id: null,
          amount: null,
          date: null,
          file: {
            id: this.nextFileId++,
            name: part.name,
            mime_type: part.mimeType,
            download_url: `/v1/files/${key}/download`,
          },
        },
      };
      tx.attachments.push(attachment);
      this.documents.set(String(attachment.document.id), structuredClone(attachment.document));
      this.uploads.push({
        seq,
        transaction_id: tx.id,
        attachment_id: attachment.id,
        document_id: attachment.document.id,
        file_key: key,
        name: stored.name,
        mime_type: stored.mimeType,
        size: stored.size,
        sha256: stored.sha256,
      });
    }
    return Response.json(tx);
  }

  /** Link an existing document of the company (API.md §4.14): JSON, form or multipart field. */
  private attachExisting(txId: string, body: Body): Response {
    const tx = this.transactions.get(txId);
    if (!tx) return notFound();
    const fields =
      body.kind === 'form'
        ? body.value
        : body.kind === 'multipart'
          ? body.fields
          : body.kind === 'json' && isObject(body.value)
            ? (body.value as Record<string, unknown>)
            : {};
    const wanted = String(fields.document_id ?? '');
    const doc = this.documents.get(wanted);
    if (!doc) return apiError(404, 'DOCUMENT_NOT_FOUND', 'Document not found', { document_id: wanted });
    tx.attachments.push({ id: this.nextAttachmentId++, removable: true, document: structuredClone(doc) });
    return Response.json(tx);
  }

  // ── the transaction update (API.md §4.12, §6) ──────────────────────

  private update(id: string, body: Body, overrideLock: boolean): Response {
    // 1. Unknown transaction.
    const current = this.transactions.get(id);
    if (!current) return notFound();
    // 2. Body must be a JSON object.
    if (body.kind !== 'json' || !isObject(body.value))
      return apiError(400, 'INVALID_BODY', 'Expected a JSON object');
    const sent = body.value;
    // 3. Ledger locks, unless override_lock=true (logged as `force: true`).
    if ((current.lock?.period || current.lock?.manual) && !overrideLock)
      return apiError(423, current.lock?.period ? 'PERIOD_LOCKED' : 'MANUALLY_LOCKED', 'This transaction is locked.', {
        transaction_id: current.id,
      });
    // 4. Lines: a non-array `lines` is treated as absent; items must be well-formed (§6.1).
    let lines: Line[] = current.lines;
    if (Array.isArray(sent.lines)) {
      const parsed = sent.lines.map((l) => parseLine(l));
      if (parsed.some((l) => l === null)) return apiError(400, 'INVALID_LINES', 'Invalid lines');
      lines = parsed as Line[];
    }
    const note = 'note' in sent ? ((sent.note as string | null) ?? null) : (current.note ?? null);
    const validated = 'validated' in sent ? sent.validated === true : current.validated;

    // 5. A validated transaction is read-only until reopened; frozen ones cannot be reopened.
    if (current.validated) {
      if (!validated && this.frozen.has(id)) return forbidden();
      const edited = validated && (linesKey(lines) !== linesKey(current.lines) || note !== (current.note ?? null));
      if (edited) return forbidden();
    }
    // 6. Unknown categories.
    const unknown = lines.find((l) => l.category_id !== null && !this.categories.has(l.category_id));
    if (unknown) return apiError(400, 'UNKNOWN_CATEGORY', 'Unknown category', { category_id: unknown.category_id });
    // 7. A reason being recorded (or changed) needs a category whose lines can carry one (§6.1).
    for (const line of lines) {
      const reason = line.tax.exemption_reason;
      if (reason === null) continue;
      if (current.lines.find((x) => x.id === line.id)?.tax.exemption_reason === reason) continue;
      const category = line.category_id === null ? undefined : this.categories.get(line.category_id);
      if (!category || exemptionPolicy(category) === 'unavailable')
        return apiError(400, 'EXEMPTION_NOT_ALLOWED', 'This line cannot carry an exemption reason', {
          line_id: line.id,
          category_id: line.category_id,
        });
    }

    // 8. Apply, then recompute (§6.1–6.3).
    const next: Transaction = { ...current, note, validated, lines: structuredClone(lines) };
    for (const line of next.lines) {
      const previous = current.lines.find((x) => x.id === line.id);
      if (previous && previous.category_id !== line.category_id) this.recategorized(line);
      line.tax.deductible = this.deductible(line);
    }
    // 9. A validated result must pass the validation rules (§6.5); nothing is stored otherwise.
    if (next.validated) {
      const problems = validationProblems(next, this.categories);
      if (problems.length)
        return apiError(400, 'VALIDATION_FAILED', `Transaction cannot be validated: ${problems.join('; ')}`, {
          problems,
        });
    }
    this.transactions.set(id, next);
    return Response.json(next);
  }

  /** Deductible VAT (§6.2): the line's VAT times its category's deductible share. */
  private deductible(line: Line): number {
    const category = line.category_id === null ? undefined : this.categories.get(line.category_id);
    return round2(line.tax.amount * (category?.deductible_share ?? 1));
  }

  /**
   * A line moved to another category (§6.3) takes the category's default tax, unless its tax is
   * overridden or exempt: categorizing a zero-VAT line into a VAT category adds VAT (the "side
   * effect" clients report). Uncategorizing leaves the tax as it is.
   */
  private recategorized(line: Line): void {
    if (line.category_id === null) return;
    const cat = this.categories.get(line.category_id);
    if (!cat || line.tax.treatment === 'exempt' || line.tax.overridden) return;
    const rate = cat.default_vat?.rate;
    const tax = (treatment: Treatment, r: number | null, amount: number): Tax => ({
      treatment,
      rate: r,
      amount,
      deductible: 0,
      exemption_reason: null,
      overridden: false,
    });
    if (!cat.default_vat) line.tax = tax('out_of_scope', null, 0);
    else if (typeof rate === 'number' && rate > 0)
      line.tax = tax('taxable', rate, round2(line.amount - line.amount / (1 + rate)));
    // A null or zero rate: in VAT, no amount.
    else line.tax = tax('taxable', null, 0);
  }

  // ── admin views ────────────────────────────────────────────────────

  /** What the write log records about a transaction: its complete mutable state (§9.2). */
  snapshot(txId: string): TransactionSnapshot | null {
    const tx = this.transactions.get(txId);
    if (!tx) return null;
    return {
      validated: tx.validated,
      note: tx.note ?? null,
      date: tx.date,
      amount: tx.amount,
      direction: tx.direction,
      source: tx.source ?? null,
      status: tx.status ?? 'active',
      lock: { manual: !!tx.lock?.manual, period: !!tx.lock?.period },
      issues: structuredClone(tx.issues ?? []),
      attachments: tx.attachments.map((a) => ({
        id: a.id,
        document_id: a.document.id,
        kind: a.document.kind,
        purchase_invoice_id: a.document.purchase_invoice_id ?? null,
        name: a.document.file?.name ?? null,
        sha256: this.fileOf(a)?.sha256 ?? null,
      })),
      lines: structuredClone(tx.lines),
    };
  }

  private fileOf(a: Attachment): StoredFile | undefined {
    const key = a.document.file?.download_url?.match(FILE_URL)?.[1];
    return key ? this.files.get(decodeURIComponent(key)) : undefined;
  }

  /** Full state for graders (admin port only, §8.2): internal flags and file hashes included. */
  state(): Json {
    const transactions = [...this.transactions.values()].map((tx) => {
      const copy = structuredClone(tx) as Transaction & { frozen: boolean };
      copy.frozen = this.frozen.has(String(tx.id));
      for (const a of copy.attachments) {
        const f = this.fileOf(a);
        if (a.document.file)
          Object.assign(a.document.file, { sha256: f?.sha256 ?? null, size: f?.size ?? null });
      }
      return copy;
    });
    return {
      scenario: {
        id: this.scenario.id,
        path: this.scenarioPath,
        seed: this.scenario.seed ?? null,
        as_of: this.scenario.as_of ?? null,
      },
      company: this.scenario.company,
      mark: this.log.mark,
      transactions,
      uploads: this.uploads,
      files: Object.fromEntries(
        [...this.files].map(([key, f]) => [
          key,
          { name: f.name, mime_type: f.mimeType, size: f.size, sha256: f.sha256, origin: f.origin },
        ]),
      ),
      // Open CA3 returns as currently recomputed (filed returns as in the scenario).
      vat_returns: this.scenario.vat_returns.map((r) => this.vatReturnNow(r)),
      fiscal_years: this.scenario.fiscal_years,
      storage_fetches: this.storageFetches,
      counters: {
        unauthorized_responses: this.unauthorizedResponses,
        remote_logouts: this.remoteLogouts,
        auth_attempts: this.log.records.filter((r) => r.kind === 'auth').length,
      },
    };
  }
}

/** Why a transaction cannot be validated (API.md §6.5). */
export function validationProblems(tx: Transaction, categories: ReadonlyMap<number, Category>): string[] {
  const problems: string[] = [];
  if (tx.issues?.length) problems.push(`it has ${tx.issues.length} issue(s)`);
  if (tx.lines.some((l) => l.category_id === null)) problems.push('a line is uncategorized');
  const signed = (direction: string, amount: number) => (direction === 'in' ? amount : -amount);
  const total = tx.lines.reduce((sum, l) => sum + signed(l.direction ?? tx.direction, l.amount), 0);
  if (tx.lines.length && Math.abs(total - signed(tx.direction, tx.amount)) > 0.01)
    problems.push('its lines do not add up to the transaction amount');
  for (const l of tx.lines) {
    const category = l.category_id === null ? undefined : categories.get(l.category_id);
    if (category && exemptionPolicy(category) === 'required' && l.tax.treatment === 'taxable' && l.tax.amount === 0)
      problems.push('zero VAT without a required exemption reason');
  }
  return problems;
}

function unauthenticated(): Response {
  return apiError(401, 'UNAUTHENTICATED', 'Unauthorized', {}, { 'www-authenticate': 'Bearer realm="compta"' });
}

function isCa3(r: VatReturnRecord): boolean {
  return String(r.summary.return_type ?? '').startsWith('CA3');
}

function nonNegative(value: string | null, fallback: number): number {
  const n = Number(value);
  return value !== null && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * A line item of an update (§6.1) in its canonical form, or null when malformed: required
 * fields and types, a known treatment, and a reason exactly when the line is exempt (then with
 * no rate and no VAT). `tax.deductible` is the server's (recomputed); other fields are ignored.
 */
function parseLine(l: unknown): Line | null {
  if (!isObject(l) || !isObject(l.tax)) return null;
  const t = l.tax;
  const ok =
    typeof l.id === 'number' &&
    typeof l.amount === 'number' &&
    (l.category_id === null || typeof l.category_id === 'number') &&
    (l.direction === undefined || l.direction === 'in' || l.direction === 'out') &&
    (l.refund === undefined || typeof l.refund === 'boolean') &&
    TREATMENTS.includes(t.treatment as Treatment) &&
    (t.rate === null || typeof t.rate === 'number') &&
    typeof t.amount === 'number' &&
    (t.overridden === undefined || typeof t.overridden === 'boolean') &&
    (t.treatment === 'exempt'
      ? EXEMPTION_REASONS.includes(t.exemption_reason as string) && t.rate === null && t.amount === 0
      : t.exemption_reason === null || t.exemption_reason === undefined);
  return ok ? canonicalLine(l as unknown as Line, 0) : null;
}

/** A line with exactly the documented keys, in the documented order. */
function canonicalLine(l: Line, deductible: number | undefined): Line {
  const t = l.tax ?? ({} as Partial<Tax>);
  return {
    id: l.id,
    amount: l.amount,
    ...(l.direction !== undefined ? { direction: l.direction } : {}),
    ...(l.refund !== undefined ? { refund: l.refund } : {}),
    category_id: l.category_id,
    tax: {
      treatment: t.treatment as Treatment,
      rate: t.rate ?? null,
      amount: t.amount as number,
      deductible: deductible ?? 0,
      exemption_reason: t.exemption_reason ?? null,
      overridden: t.overridden ?? false,
    },
  };
}

/** Lines compared for edits: everything but the server-computed deductible VAT. */
function linesKey(lines: readonly Line[]): string {
  return JSON.stringify(lines.map((l) => ({ ...l, tax: { ...l.tax, deductible: 0 } })));
}

async function readBody(req: Request): Promise<Body> {
  if (req.method === 'GET' || req.method === 'HEAD' || !req.body) return { kind: 'none' };
  const type = (req.headers.get('content-type') ?? '').toLowerCase();
  if (type.startsWith('multipart/form-data')) {
    const form = await req.formData();
    const fields: Record<string, string> = {};
    const files: Extract<Body, { kind: 'multipart' }>['files'] = [];
    for (const [field, value] of form) {
      if (typeof value === 'string') fields[field] = value;
      else
        files.push({
          field,
          name: value.name,
          mimeType: value.type || mimeFromName(value.name),
          bytes: new Uint8Array(await value.arrayBuffer()),
        });
    }
    return { kind: 'multipart', fields, files };
  }
  const text = await req.text();
  if (type.startsWith('application/x-www-form-urlencoded'))
    return { kind: 'form', value: Object.fromEntries(new URLSearchParams(text)) };
  if (!text) return { kind: 'none' };
  return { kind: 'json', value: JSON.parse(text) as unknown };
}

function bodyDigest(path: string, body: Body): unknown {
  switch (body.kind) {
    case 'none':
      return null;
    case 'json':
      return digestBody(path, body.value);
    case 'form':
      return path.startsWith(AUTH_PREFIX) ? digestBody(path, body.value) : body.value;
    case 'multipart':
      return {
        fields: body.fields,
        files: body.files.map((f) => ({
          field: f.field,
          name: f.name,
          size: f.bytes.length,
          sha256: sha256(f.bytes),
          mimeType: f.mimeType,
        })),
      };
  }
}
