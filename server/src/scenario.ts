/**
 * Scenario files (API.md §10): a fully synthetic company, its transactions and documents, as
 * Compta API objects. Everything is served as stored except the scenario-only keys
 * (`frozen` on transactions, `deductible_share` and `exemption_required` on categories).
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type Json = Record<string, unknown>;

/** How VAT applies to a line (API.md §5 "Tax"). */
export type Treatment = 'taxable' | 'exempt' | 'out_of_scope';
export const TREATMENTS: readonly Treatment[] = ['taxable', 'exempt', 'out_of_scope'];

/** The known exemption reasons (API.md §11). */
export const EXEMPTION_REASONS: readonly string[] = [
  'purchase_non_eu',
  'purchase_eu',
  'purchase_non_eu_not_imported',
  'purchase_not_applicable',
  'purchase_no_document',
  'sale_non_eu',
  'sale_eu',
  'sale_not_applicable',
];

/** The tax treatment of a line (API.md §5 "Tax"). */
export interface Tax {
  treatment: Treatment;
  rate: number | null;
  amount: number;
  /** Server-computed: the part of `amount` the company may deduct (§6.2). */
  deductible: number;
  exemption_reason: string | null;
  overridden: boolean;
}

/** One accounting line (API.md §5 "Line"). */
export interface Line {
  id: number;
  amount: number;
  direction?: 'in' | 'out';
  refund?: boolean;
  category_id: number | null;
  tax: Tax;
}

export interface FileRef extends Json {
  id: number;
  name: string;
  mime_type?: string;
  download_url?: string;
}

export interface Document extends Json {
  id: number;
  kind: string;
  purchase_invoice_id?: string | null;
  amount?: number | null;
  date?: string | null;
  file?: FileRef | null;
}

export interface Attachment extends Json {
  id: number;
  removable?: boolean;
  document: Document;
}

export interface Transaction extends Json {
  id: number;
  company_id?: number;
  source?: 'bank' | 'expense';
  date: string;
  label: string;
  note?: string | null;
  amount: number;
  direction: 'in' | 'out';
  validated: boolean;
  validated_at?: string | null;
  status?: 'active' | 'excluded' | 'deleted';
  lock?: { manual?: boolean; period?: boolean };
  issues?: unknown[] | null;
  bank?: Json | null;
  lines: Line[];
  attachments: Attachment[];
}

export interface Category extends Json {
  id: number;
  label: string;
  group?: { id: number; name: string } | null;
  ledger_account?: string | null;
  default_vat?: { rate?: number | null; optional?: boolean } | null;
  /** Scenario-only (never served): share of the VAT that is deductible. Default 1. */
  deductible_share?: number;
  /** Scenario-only (never served): zero-VAT lines need an exemption reason (§6.5). Default false. */
  exemption_required?: boolean;
}

/** What a category allows for exemption reasons (API.md §5 Category `exemptions`). */
export type ExemptionPolicy = 'unavailable' | 'allowed' | 'required';

/** Server-derived: no reason outside VAT; else required when the scenario says so. */
export function exemptionPolicy(c: Category): ExemptionPolicy {
  if (!c.default_vat) return 'unavailable';
  return c.exemption_required ? 'required' : 'allowed';
}

export type VatReturnStatus = 'filed' | 'to_file' | 'upcoming';
export const VAT_RETURN_STATUSES: readonly VatReturnStatus[] = ['filed', 'to_file', 'upcoming'];

export interface VatReturnRecord {
  status: VatReturnStatus;
  summary: Json & { id: number | string };
  boxes: Record<string, number> | null;
}

export interface Scenario {
  schema_version: 2;
  id: string;
  seed?: number;
  as_of?: string;
  api_token: string;
  company: Json & { id: number };
  user: Json & { id: number };
  bank_accounts: Json[];
  categories: Category[];
  fiscal_years: Json[];
  vat_returns: VatReturnRecord[];
  /** Scenario-only flag (never served): `frozen: true`, a validated transaction that cannot be reopened. */
  transactions: (Transaction & { frozen?: boolean })[];
  purchase_invoices: Record<string, Json>;
  /** File key → path relative to the scenario directory. */
  files: Record<string, string>;
}

export interface StoredFile {
  bytes: Uint8Array;
  name: string;
  mimeType: string;
  sha256: string;
  size: number;
  /** Where it came from: the scenario (relative path) or an upload (log seq). */
  origin: { scenario: string } | { upload_seq: number };
}

export interface LoadedScenario {
  scenario: Scenario;
  path: string;
  files: Map<string, StoredFile>;
}

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.heic': 'image/heic',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
};

export function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot >= 0 && MIME_TYPES[name.slice(dot).toLowerCase()]) || 'application/octet-stream';
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(path: string, message: string): never {
  throw new Error(`Invalid scenario ${path}: ${message}`);
}

/** Load `<dir>/scenario.json` (or a .json path) and every file it references. */
export function loadScenario(input: string): LoadedScenario {
  const path = statSync(input).isDirectory() ? join(resolve(input), 'scenario.json') : resolve(input);
  const scenario = JSON.parse(readFileSync(path, 'utf8')) as Scenario;
  if (scenario.schema_version !== 2) fail(path, 'schema_version must be 2');
  if (typeof scenario.api_token !== 'string' || scenario.api_token.length < 8)
    fail(path, 'api_token must be a string of at least 8 characters');
  if (typeof scenario.company?.id !== 'number') fail(path, 'company.id must be a number');
  if (typeof scenario.user?.id !== 'number') fail(path, 'user.id must be a number');
  for (const key of ['bank_accounts', 'categories', 'fiscal_years', 'vat_returns', 'transactions'])
    if (!Array.isArray((scenario as unknown as Json)[key])) fail(path, `${key} must be an array`);
  const ids = new Set<number>();
  for (const tx of scenario.transactions) {
    if (typeof tx.id !== 'number' || ids.has(tx.id)) fail(path, `bad or duplicate transaction id ${tx.id}`);
    ids.add(tx.id);
    if (!Array.isArray(tx.lines)) fail(path, `transaction ${tx.id} has no lines`);
    tx.attachments ??= [];
  }
  for (const r of scenario.vat_returns)
    if (!VAT_RETURN_STATUSES.includes(r.status))
      fail(path, `VAT return ${r.summary?.id}: unknown status ${r.status}`);
  scenario.purchase_invoices ??= {};
  scenario.files ??= {};

  const files = new Map<string, StoredFile>();
  const base = dirname(path);
  for (const [key, rel] of Object.entries(scenario.files)) {
    const full = resolve(base, rel);
    if (!full.startsWith(`${base}/`)) fail(path, `file ${rel} is outside the scenario directory`);
    const bytes = new Uint8Array(readFileSync(full));
    const name = rel.split('/').at(-1)!;
    files.set(key, {
      bytes,
      name,
      mimeType: mimeFromName(name),
      sha256: sha256(bytes),
      size: bytes.length,
      origin: { scenario: rel },
    });
  }
  return { scenario, path, files };
}
