import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { z } from 'zod';
import { uploadName } from '../api/compta.js';
import type { Operation } from '../api/schemas.js';
import { ComptaError, ExitCode } from '../output/errors.js';
import { analyzeDocumentText, analyzeFilename, extractPdfText } from '../pdf/extract.js';
import { UPLOAD_EXTENSIONS } from '../plan/attachments.js';
import type { StepDraft } from '../plan/types.js';
import { daysBetween } from '../util/dates.js';
import { sameCents } from '../util/money.js';
import { merchantTokens, normalizeText } from '../util/text.js';

/** Same allow-list as uploads: a matched file must be attachable. */
export const RECEIPT_EXTENSIONS = UPLOAD_EXTENSIONS;

/** Window, in days, of an operation date relative to a date read from the document text. */
export const DATE_WINDOW = { before: 10, after: 40 } as const;
/**
 * Tighter window for a date in the file name: it is the document's own date
 * (invoices exported as "vendor-2026-07-20.pdf"), so a month off is another
 * billing period, not the same document.
 */
export const FILENAME_DATE_WINDOW = { before: 5, after: 10 } as const;
export interface ReceiptDocument {
  path: string;
  name: string;
  /** Normalized text used for vendor matching (PDF text + file name). */
  text: string;
  totals: number[];
  amounts: number[];
  dates: string[];
  /** Where `dates` came from: the file name wins over dates found in the text. */
  dateSource: 'filename' | 'text' | null;
  currency: string | null;
  extracted: boolean;
}

/**
 * Identity of a document across naming variants: "Invoice-1234-5678.pdf" and
 * "Receipt-1234-5678.pdf" (or a "<opId>_" prefix) are the same document. Null
 * when the name carries no number to identify it.
 */
export function documentKey(name: string): string | null {
  const key = uploadName(name)
    .normalize('NFC')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9ç]+/g, '-')
    .replace(/(^|-)(invoice|receipt|facture|re[cç]u|bill|quittance)s?(?=-|$)/g, '$1')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /\d/.test(key) ? key : null;
}

/** The operation already carries this document (same name, or same invoice/receipt number). */
export function hasDocument(op: Operation, name: string): boolean {
  const display = uploadName(name).normalize('NFC');
  const key = documentKey(name);
  return op.attachments.some(
    (a) =>
      a.filename.normalize('NFC') === display || (key !== null && documentKey(a.filename) === key),
  );
}

/** Operation id from the "<opId>_filename" convention used by receipts download. */
export function prefixedOpId(name: string): string | null {
  return /^(\d+)_/.exec(basename(name))?.[1] ?? null;
}

/** Expand files and directories (recursively) into receipt files. */
export async function collectFiles(inputs: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const visit = async (path: string, explicit: boolean) => {
    const info = await stat(path).catch(() => null);
    if (!info)
      throw new ComptaError('FILE_NOT_FOUND', `No such file or directory: ${path}`, {
        exitCode: ExitCode.usage,
      });
    if (info.isDirectory()) {
      for (const entry of (await readdir(path)).sort())
        if (!entry.startsWith('.')) await visit(join(path, entry), false);
    } else if (RECEIPT_EXTENSIONS.has(extname(path).toLowerCase())) {
      out.push(resolve(path));
    } else if (explicit) {
      throw new ComptaError(
        'USAGE',
        `Not a receipt file (${[...RECEIPT_EXTENSIONS].join(', ')}): ${path}`,
        {
          exitCode: ExitCode.usage,
        },
      );
    }
  };
  for (const input of inputs) await visit(input, true);
  return [...new Set(out)];
}

export async function readReceipt(path: string): Promise<ReceiptDocument> {
  const name = basename(path);
  const fromName = analyzeFilename(name);
  let text = '';
  if (extname(path).toLowerCase() === '.pdf')
    text = await extractPdfText(await readFile(path)).catch(() => '');
  const facts = analyzeDocumentText(text);
  return {
    path,
    name,
    text: normalizeText(`${name} ${text}`),
    totals: facts.totals.length ? facts.totals : fromName.amounts,
    amounts: [...new Set([...facts.amounts, ...fromName.amounts])],
    // A date in the file name is the document's date; text dates (periods, due
    // dates) are only used when the name has none.
    dates: fromName.dates.length ? fromName.dates : facts.dates,
    dateSource: fromName.dates.length ? 'filename' : facts.dates.length ? 'text' : null,
    currency: facts.currency,
    extracted: text.trim().length > 0,
  };
}

export interface Score {
  total: number;
  amount: number;
  date: number;
  vendor: number;
  reasons: string[];
}

function amountScore(
  doc: ReceiptDocument,
  op: Operation,
): { score: number; reason: string | null } {
  const targets: [string, number][] = [['TTC', op.amount]];
  if (op.amountExcludingVat !== null && op.amountExcludingVat !== op.amount)
    targets.push(['HT', op.amountExcludingVat]);
  if (op.original) targets.push([op.original.currency, op.original.amount]);
  const candidates = doc.totals.length ? doc.totals : doc.amounts;
  for (const [label, target] of targets)
    for (const value of candidates)
      if (sameCents(value, target))
        return { score: 1, reason: `amount ${value.toFixed(2)} = ${label}` };
  for (const [label, target] of targets)
    for (const value of doc.amounts)
      if (sameCents(value, target))
        return {
          score: 0.85,
          reason: `amount ${value.toFixed(2)} = ${label} (not on a total line)`,
        };
  // Foreign-currency documents only match the bank's original amount (above):
  // comparing them with the EUR amount would need the exchange rate.
  return { score: 0, reason: null };
}

function dateScore(doc: ReceiptDocument, op: Operation): { score: number; reason: string | null } {
  if (!doc.dates.length) return { score: 0.4, reason: null };
  const window = doc.dateSource === 'filename' ? FILENAME_DATE_WINDOW : DATE_WINDOW;
  let best: { score: number; delta: number } | null = null;
  for (const date of doc.dates) {
    const delta = daysBetween(date, op.date);
    if (delta < -window.before || delta > window.after) continue;
    const score =
      delta === 0
        ? 1
        : delta > 0
          ? 1 - delta / (window.after * 1.5)
          : 1 - -delta / (window.before * 1.5);
    if (!best || score > best.score) best = { score, delta };
  }
  if (!best) return { score: 0, reason: null };
  const source = doc.dateSource === 'filename' ? ' (file name)' : '';
  return { score: best.score, reason: `date ${best.delta >= 0 ? '+' : ''}${best.delta}d${source}` };
}

function vendorScore(
  doc: ReceiptDocument,
  op: Operation,
): { score: number; reason: string | null } {
  const tokens = merchantTokens(op.wording);
  if (!tokens.length) return { score: 0, reason: null };
  const haystack = ` ${doc.text} `;
  const hits = tokens.filter(
    (t) => haystack.includes(` ${t} `) || (t.length >= 5 && haystack.includes(t)),
  );
  if (!hits.length) return { score: 0, reason: null };
  return {
    score: Math.min(1, hits.length / Math.min(tokens.length, 2)),
    reason: `vendor '${hits.join(' ')}' in wording`,
  };
}

/** Weighted score in [0, 1]; an amount match is required to score highly. */
export function scoreMatch(doc: ReceiptDocument, op: Operation): Score {
  const a = amountScore(doc, op);
  const d = dateScore(doc, op);
  const v = vendorScore(doc, op);
  const total = Math.round((0.55 * a.score + 0.25 * d.score + 0.2 * v.score) * 100) / 100;
  return {
    total,
    amount: a.score,
    date: d.score,
    vendor: v.score,
    reasons: [a.reason, d.reason, v.reason].filter((r): r is string => r !== null),
  };
}

const candidateSchema = z.object({
  op: z.string(),
  date: z.string(),
  wording: z.string(),
  amount: z.number(),
  score: z.number(),
  why: z.string(),
});
export const receiptsReportSchema = z
  .object({
    meta: z.object({
      files: z.number(),
      matched: z.number(),
      ambiguous: z.number(),
      unmatched: z.number(),
      alreadyAttached: z.number(),
      alreadyDocumented: z
        .number()
        .describe(
          'Files whose matching operation already has another document (skipped by default)',
        ),
      minScore: z.number(),
      plan: z.string().nullable(),
    }),
    matched: z.array(
      z.object({ file: z.string(), best: candidateSchema, runnersUp: z.array(candidateSchema) }),
    ),
    ambiguous: z.array(
      z.object({ file: z.string(), candidates: z.array(candidateSchema), reason: z.string() }),
    ),
    unmatched: z.array(
      z.object({
        file: z.string(),
        reason: z.string(),
        detected: z.object({ totals: z.array(z.number()), dates: z.array(z.string()) }),
      }),
    ),
    alreadyAttached: z.array(z.object({ file: z.string(), op: z.string() })),
    alreadyDocumented: z.array(
      z.object({
        file: z.string(),
        op: z.string(),
        existing: z.array(z.string()),
        score: z.number(),
      }),
    ),
  })
  .describe('Result of compta receipts match');
export type ReceiptsReport = z.infer<typeof receiptsReportSchema>;
type Candidate = z.infer<typeof candidateSchema>;

export interface MatchOptions {
  minScore: number;
  /** Required gap between the best and second-best candidate to be confident. */
  margin?: number;
  /** Also propose operations that already have a document (default: only those without). */
  includeAttached?: boolean;
  /** Operations named by a file's "<opId>_" prefix (that exist in Compta). */
  byId?: ReadonlyMap<string, Operation>;
}

export function matchReceipts(
  docs: readonly ReceiptDocument[],
  ops: readonly Operation[],
  options: MatchOptions,
) {
  const margin = options.margin ?? 0.1;
  const report: Omit<ReceiptsReport, 'meta'> = {
    matched: [],
    ambiguous: [],
    unmatched: [],
    alreadyAttached: [],
    alreadyDocumented: [],
  };
  const steps: StepDraft[] = [];
  const claimed = new Map<string, string>();
  const attach = (
    doc: ReceiptDocument,
    op: Operation,
    candidate: Candidate,
    runnersUp: Candidate[],
  ) => {
    claimed.set(op.id, doc.path);
    report.matched.push({ file: doc.path, best: candidate, runnersUp });
    steps.push({ op: op.id, action: 'attach', file: doc.path, why: candidate.why });
  };
  const documented = (doc: ReceiptDocument, op: Operation, score: number) =>
    report.alreadyDocumented.push({
      file: doc.path,
      op: op.id,
      existing: op.attachments.map((a) => a.filename),
      score,
    });

  for (const doc of docs) {
    // "<opId>_name" (what receipts download writes) names its operation: that
    // operation or nothing, never another one.
    const pinnedId = prefixedOpId(doc.name);
    const pinned = pinnedId ? options.byId?.get(pinnedId) : undefined;
    if (pinned) {
      // Sanity check: digits that happen to be an operation id (e.g. a "20260815_" date
      // prefix) must not pin a document whose amount and date both disagree.
      const check = scoreMatch(doc, pinned);
      const agrees = check.amount > 0 || (doc.dates.length > 0 && check.date > 0);
      if (hasDocument(pinned, doc.name))
        report.alreadyAttached.push({ file: doc.path, op: pinned.id });
      else if (!agrees)
        report.ambiguous.push({
          file: doc.path,
          candidates: [
            {
              op: pinned.id,
              date: pinned.date,
              wording: pinned.wording,
              amount: pinned.amount,
              score: check.total,
              why: `file name prefix is operation ${pinned.id}, but neither its amount nor its date matches`,
            },
          ],
          reason: `file name prefix ${pinned.id} is an operation whose amount and date don't match this document`,
        });
      else if (pinned.attachments.length && !options.includeAttached) documented(doc, pinned, 1);
      else
        attach(
          doc,
          pinned,
          {
            op: pinned.id,
            date: pinned.date,
            wording: pinned.wording,
            amount: pinned.amount,
            score: 1,
            why: `file name prefix is operation ${pinned.id} (score 1.00)`,
          },
          [],
        );
      continue;
    }

    const ranked = ops
      .map((op) => ({ op, score: scoreMatch(doc, op) }))
      .filter((c) => c.score.amount > 0 && c.score.total >= 0.4)
      .sort(
        (a, b) =>
          b.score.total - a.score.total || a.op.attachments.length - b.op.attachments.length,
      );
    const toCandidate = ({ op, score }: (typeof ranked)[number]): Candidate => ({
      op: op.id,
      date: op.date,
      wording: op.wording,
      amount: op.amount,
      score: score.total,
      why: `${score.reasons.join(', ')} (score ${score.total.toFixed(2)})`,
    });
    // Same document (name, or invoice/receipt number) already on a matching candidate.
    // Only candidates count: common names on unrelated operations must not hide a match.
    const attachedTo = ranked.find(({ op }) => hasDocument(op, doc.name));
    if (attachedTo) {
      report.alreadyAttached.push({ file: doc.path, op: attachedTo.op.id });
      continue;
    }
    // By default only operations still missing a document are targets.
    const eligible = options.includeAttached
      ? ranked
      : ranked.filter(({ op }) => !op.attachments.length);
    const top = ranked[0];
    if (
      !options.includeAttached &&
      top?.op.attachments.length &&
      top.score.total >= options.minScore &&
      (!eligible[0] || eligible[0].score.total < top.score.total)
    ) {
      // The best match already has a document: almost always a second copy of it.
      documented(doc, top.op, top.score.total);
      continue;
    }
    const best = eligible[0];
    if (!best) {
      report.unmatched.push({
        file: doc.path,
        reason:
          doc.extracted || doc.amounts.length
            ? 'no operation with a matching amount near the document date'
            : 'no text could be extracted (scanned PDF or image?)',
        detected: { totals: doc.totals.slice(0, 5), dates: doc.dates.slice(0, 5) },
      });
      continue;
    }
    const second = eligible[1];
    const confident =
      best.score.total >= options.minScore &&
      (!second || best.score.total - second.score.total >= margin);
    if (!confident) {
      report.ambiguous.push({
        file: doc.path,
        candidates: eligible.slice(0, 3).map(toCandidate),
        reason:
          best.score.total < options.minScore
            ? `best score ${best.score.total.toFixed(2)} is below --min-score ${options.minScore}`
            : `${eligible.length} operations score within ${margin} of each other`,
      });
      continue;
    }
    const previous = claimed.get(best.op.id);
    if (previous) {
      report.ambiguous.push({
        file: doc.path,
        candidates: [toCandidate(best)],
        reason: `same operation as ${basename(previous)}`,
      });
      continue;
    }
    attach(doc, best.op, toCandidate(best), eligible.slice(1, 3).map(toCandidate));
  }
  return { report, steps };
}
