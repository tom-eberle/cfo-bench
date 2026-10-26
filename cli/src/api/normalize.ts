import type { z } from 'zod';
import { ComptaError, ExitCode } from '../output/errors.js';
import { cents } from '../util/money.js';
import type {
  Account,
  Attachment,
  Breakdown,
  Category,
  Company,
  Operation,
  RawAttachment,
  RawBankAccount,
  RawCategory,
  RawLine,
  RawTransaction,
  rawUserSchema,
  VatExemptKind,
  Whoami,
} from './schemas.js';

/** Compta exemption values for purchases, by our short names. */
export const EXEMPTION_VALUES: Record<VatExemptKind, string> = {
  'outside-eu': 'purchase_non_eu',
  'inside-eu': 'purchase_eu',
  'outside-eu-not-imported': 'purchase_non_eu_not_imported',
  'not-applicable': 'purchase_not_applicable',
  'no-document': 'purchase_no_document',
};

/**
 * Compta exemption values for sales lines (`sale_*`), by the same short names;
 * purchases-only reasons (no-document, outside-eu-not-imported) have no sales
 * counterpart.
 */
export const SALES_EXEMPTION_VALUES: Partial<Record<VatExemptKind, string>> = {
  'outside-eu': 'sale_non_eu',
  'inside-eu': 'sale_eu',
  'not-applicable': 'sale_not_applicable',
};

/** A sales line: income, or money paid back to a customer (refund). */
export function isSaleLine(b: { direction: 'expense' | 'income'; isRefund: boolean }): boolean {
  return b.isRefund ? b.direction === 'expense' : b.direction === 'income';
}

/** The Compta value for a short name on a given line, or null if that line can't take it. */
export function exemptionValue(kind: VatExemptKind, sale: boolean): string | null {
  return (sale ? SALES_EXEMPTION_VALUES[kind] : EXEMPTION_VALUES[kind]) ?? null;
}

export function exemptionKind(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  const known = [
    ...Object.entries(EXEMPTION_VALUES),
    ...Object.entries(SALES_EXEMPTION_VALUES),
  ].find(([, value]) => value === raw);
  return known ? known[0] : raw;
}

/** API rates are fractions (0.2); the CLI speaks percent (20). */
export function rateToPercent(rate: number | null | undefined): number | null {
  return rate == null ? null : Math.round(rate * 1000) / 10;
}

export function percentToRate(percent: number): number {
  return Math.round(percent * 10) / 1000;
}

/** A line is inbound when its own direction (default: the transaction's) is "in". */
export function lineInbound(
  line: Pick<RawLine, 'direction'>,
  tx: Pick<RawTransaction, 'direction'>,
) {
  return (line.direction ?? tx.direction) === 'in';
}

/** Raw document kinds, as the CLI's attachment types (unknown kinds pass through). */
const DOCUMENT_TYPES: Record<string, string> = {
  purchase_invoice: 'vendorInvoice',
  sales_invoice: 'salesInvoice',
  other: 'other',
  unclassified: 'unknown',
};

/** The operation in the Compta web app, served from the API origin. */
export function operationUrl(apiBase: string, company: string, opId: string): string {
  return `${apiBase.replace(/\/+$/, '')}/app/companies/${company}/transactions/${opId}`;
}

/**
 * A line as a breakdown. The category's name and group come from the category list
 * (lines carry only the id). Compta has no bank-side counterpart lines: every line
 * is a main one, which the normalized shape keeps as `isCounterpart: false`,
 * `section: "main"`.
 */
function normalizeBreakdown(
  b: RawLine,
  tx: RawTransaction,
  categories: ReadonlyMap<number, RawCategory>,
): Breakdown {
  const tax = b.tax;
  const category = b.category_id == null ? undefined : categories.get(b.category_id);
  if (b.category_id != null && !category)
    // Never a blank name: the caller refreshes the category list first (Compta.categoryMap).
    throw new ComptaError(
      'CATEGORY_UNKNOWN',
      `Operation ${tx.id}: category ${b.category_id} is not in Compta's category list`,
      {
        exitCode: ExitCode.network,
        hint: 'the category list may have changed; retry with --no-cache, or run: compta doctor',
      },
    );
  const group = category?.group?.name;
  const name = category?.label ?? '';
  return {
    id: String(b.id),
    isCounterpart: false,
    section: 'main',
    direction: lineInbound(b, tx) ? 'income' : 'expense',
    isRefund: b.refund ?? false,
    vatApplicable: tax.treatment !== 'out_of_scope',
    category:
      b.category_id == null
        ? null
        : { id: b.category_id, name, path: group ? [group, name] : [name] },
    amount: cents(b.amount),
    amountExcludingVat: cents(b.amount - tax.deductible),
    vatRate: rateToPercent(tax.rate),
    vatAmount: cents(tax.amount),
    recoverableVat: cents(tax.deductible),
    vatExemptReason: exemptionKind(tax.exemption_reason),
  };
}

function normalizeAttachment(a: RawAttachment): Attachment {
  const doc = a.document;
  const type = DOCUMENT_TYPES[doc.kind] ?? doc.kind;
  return {
    id: String(a.id),
    documentId: String(doc.id),
    fileId: doc.file ? String(doc.file.id) : null,
    filename: doc.file?.name ?? '',
    mimeType: doc.file?.mime_type ?? null,
    type,
    vendorInvoiceId:
      doc.kind === 'purchase_invoice' && doc.purchase_invoice_id ? doc.purchase_invoice_id : null,
    downloadPath: doc.file?.download_url?.startsWith('/') ? doc.file.download_url : null,
  };
}

export interface NormalizeContext {
  company: string;
  /** The API origin (COMPTA_API_BASE); the web app link is built from it. */
  apiBase: string;
  accounts?: ReadonlyMap<string, string>;
  /** Categories by id: lines name their category through it (every id they reference). */
  categories: ReadonlyMap<number, RawCategory>;
}

/** Deleted and excluded transactions count nowhere; lists skip them. */
export function isActive(raw: Pick<RawTransaction, 'status'>): boolean {
  return (raw.status ?? 'active') === 'active';
}

export function normalizeOperation(raw: RawTransaction, ctx: NormalizeContext): Operation {
  const breakdowns = raw.lines.map((b) => normalizeBreakdown(b, raw, ctx.categories));
  const mains = breakdowns.filter((b) => !b.isCounterpart);
  const main = mains.length === 1 ? mains[0] : undefined;
  const bank = raw.bank;
  const accountId = bank ? String(bank.account_id) : null;
  const foreign =
    bank?.original_currency && bank.original_currency !== 'EUR' && bank.original_amount != null
      ? { amount: cents(Math.abs(bank.original_amount)), currency: bank.original_currency }
      : bank?.currency && bank.currency !== 'EUR' && bank.amount != null
        ? { amount: cents(Math.abs(bank.amount)), currency: bank.currency }
        : null;
  const id = String(raw.id);
  return {
    id,
    date: raw.date.slice(0, 10),
    wording: raw.label,
    type: raw.source ?? null,
    amount: cents(Math.abs(raw.amount)),
    direction: raw.direction === 'in' ? 'income' : 'expense',
    original: foreign,
    validated: raw.validated,
    locked: !!(raw.lock?.manual || raw.lock?.period),
    memo: raw.note || null,
    account: accountId ? { id: accountId, name: ctx.accounts?.get(accountId) ?? '' } : null,
    breakdowns,
    category: main?.category ?? null,
    vatRate: main ? main.vatRate : null,
    vatAmount: main ? main.vatAmount : null,
    amountExcludingVat: main ? main.amountExcludingVat : null,
    vatExemptReason: main ? main.vatExemptReason : null,
    attachments: raw.attachments.map(normalizeAttachment),
    url: operationUrl(ctx.apiBase, ctx.company, id),
  };
}

export function normalizeAccount(a: RawBankAccount): Account {
  return {
    id: String(a.id),
    name: a.name || a.bank_name || '',
    bank: a.bank_name ?? '',
    currency: a.currency ?? 'EUR',
    balance: a.balance?.amount ?? null,
    balanceUpdatedAt: a.balance?.updated_at ?? null,
    closed: a.closed ?? false,
    hidden: a.hidden ?? false,
  };
}

/**
 * PCG accounts of movements that never need a justifying document: internal
 * transfers (58), associates' current accounts / owner contributions (455),
 * capital (10), subsidies (13), loans (16), currency gains and losses (666,
 * 766), tax settlements (444, 445).
 */
const NO_DOCUMENT_ACCOUNTS = /^(58|455|10|13|16|666|766|444|445)/;

const CATEGORY_DIRECTIONS = { in: 'income', out: 'expense', both: 'both' } as const;

export function normalizeCategory(c: RawCategory): Category {
  const group = c.group?.name ?? null;
  const accountingNumbers = (
    c.ledger_accounts?.length
      ? c.ledger_accounts
      : c.ledger_account != null
        ? [c.ledger_account]
        : []
  ).map(String);
  const rate = c.default_vat?.rate;
  return {
    id: c.id,
    name: c.label,
    group,
    path: group ? [group, c.label] : [c.label],
    direction: CATEGORY_DIRECTIONS[c.direction ?? 'both'],
    accountingNumber:
      c.ledger_account != null
        ? String(c.ledger_account)
        : c.ledger_accounts?.length
          ? String(c.ledger_accounts[0])
          : null,
    defaultVatRate: typeof rate === 'number' ? rateToPercent(rate) : null,
    // No default VAT: outside VAT. A 0 rate too; no rate at all (null) still carries VAT.
    carriesVat: !!c.default_vat && (rate == null || rate > 0),
    vatOptional: c.default_vat?.optional ?? false,
    accountingNumbers,
    needsDocument: !(
      accountingNumbers.length && accountingNumbers.every((n) => NO_DOCUMENT_ACCOUNTS.test(n))
    ),
  };
}

/** True when the operation needs a justifying document and has none. */
export function hasReceipt(op: Pick<Operation, 'attachments'>): boolean {
  return op.attachments.length > 0;
}

/** The user of `GET /v1/me` and the companies they can open. */
export function normalizeUser(raw: z.infer<typeof rawUserSchema>): {
  user: Whoami['user'];
  companies: Company[];
} {
  const companies = (raw.companies ?? (raw.company ? [raw.company] : [])).map((c) => ({
    id: String(c.id),
    name: c.trade_name || c.legal_name || '',
  }));
  return {
    user: { id: String(raw.id), name: raw.name?.full ?? null, email: raw.email ?? null },
    companies,
  };
}
