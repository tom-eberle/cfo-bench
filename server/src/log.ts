/**
 * The write log graders read (API.md §9): one record per non-GET request on the API port and
 * per request under /v1/auth/, plus the marks the harness puts between turns. Each record
 * carries the transaction's state before and after, so graders judge outcomes, not the client's
 * request choreography (reopen → edit → revalidate).
 */
import { appendFileSync } from 'node:fs';
import type { Line } from './scenario.ts';

/**
 * A transaction's complete mutable state (API.md §9.2), so `changed` can never miss an edit:
 * every transaction-level field that can differ between two states, every attachment, and every
 * line with all its fields.
 */
export interface TransactionSnapshot {
  validated: boolean;
  note: string | null;
  date: string;
  amount: number;
  direction: string;
  source: string | null;
  status: string;
  lock: { manual: boolean; period: boolean };
  issues: unknown[];
  attachments: {
    id: number;
    document_id: number;
    kind: string;
    purchase_invoice_id: string | null;
    name: string | null;
    sha256: string | null;
  }[];
  lines: Line[];
}

export interface RequestRecord {
  kind: 'write' | 'auth';
  seq: number;
  ts: string;
  mark: string | null;
  method: string;
  path: string;
  query: Record<string, string>;
  opId: string | null;
  status: number;
  accepted: boolean;
  /** `error.code` of an error response, else null. */
  errorCode: string | null;
  /** `?override_lock=true`: bypasses ledger locks (an accountant action; the official client never sends it). */
  force: boolean;
  body: unknown;
  before: TransactionSnapshot | null;
  after: TransactionSnapshot | null;
  changed: boolean;
}

export interface MarkRecord {
  kind: 'mark';
  seq: number;
  ts: string;
  label: string;
}

export type LogRecord = RequestRecord | MarkRecord;

export class WriteLog {
  records: LogRecord[] = [];
  mark: string | null = null;
  private seq = 0;
  private readonly file?: string;

  constructor(file?: string) {
    this.file = file;
  }

  /** The seq the next record will get (uploads remember it as their origin). */
  get nextSeq(): number {
    return this.seq + 1;
  }

  add(record: Omit<RequestRecord, 'seq' | 'ts' | 'mark'>): RequestRecord {
    const full = { seq: ++this.seq, ts: new Date().toISOString(), mark: this.mark, ...record };
    this.push(full);
    return full;
  }

  addMark(label: string): MarkRecord {
    this.mark = label;
    const record: MarkRecord = { kind: 'mark', seq: ++this.seq, ts: new Date().toISOString(), label };
    this.push(record);
    return record;
  }

  /** Forget everything (a new scenario run). The JSONL file keeps a reset line. */
  reset(scenarioId: string): void {
    this.records = [];
    this.mark = null;
    this.seq = 0;
    this.appendFile({ kind: 'reset', ts: new Date().toISOString(), scenario: scenarioId });
  }

  private push(record: LogRecord): void {
    this.records.push(record);
    this.appendFile(record);
  }

  private appendFile(line: unknown): void {
    if (this.file) appendFileSync(this.file, `${JSON.stringify(line)}\n`);
  }
}

export const AUTH_PREFIX = '/v1/auth/';

/** Top-level body fields dropped from digests: bulky, and ignored by every update. */
const BULKY = new Set(['attachments', 'bank']);

/**
 * A request body for the log (API.md §9.3). Passwords, codes and challenges are never logged,
 * only whether they were sent. Other JSON objects keep every top-level field except the bulky
 * ignored ones, so a transaction update keeps its complete accounting payload (all lines, all
 * their fields).
 */
export function digestBody(path: string, body: unknown): unknown {
  if (body === undefined || body === null) return null;
  if (path.startsWith(AUTH_PREFIX)) {
    const b = (typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const sent = (x: unknown) => typeof x === 'string' && x.length > 0;
    return {
      ...(typeof b.email === 'string' ? { email: b.email } : {}),
      ...(typeof b.factor === 'string' ? { factor: b.factor } : {}),
      passwordSent: sent(b.password),
      codeSent: sent(b.code),
      challengeSent: sent(b.challenge),
    };
  }
  if (typeof body !== 'object' || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) if (!BULKY.has(key)) out[key] = value;
  return out;
}
