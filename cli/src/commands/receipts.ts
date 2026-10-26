import { basename } from 'node:path';
import type { Command } from 'commander';
import type { Operation } from '../api/schemas.js';
import { ComptaError, ExitCode } from '../output/errors.js';
import { style } from '../output/style.js';
import { renderTable } from '../output/table.js';
import { buildPlan } from '../plan/types.js';
import { mapLimit } from '../util/concurrency.js';
import { addDays, today } from '../util/dates.js';
import { formatAmount } from '../util/money.js';
import { VERSION } from '../version.js';
import {
  collectFiles,
  DATE_WINDOW,
  matchReceipts,
  prefixedOpId,
  type ReceiptsReport,
  readReceipt,
} from '../workflows/receipts.js';
import { contextOf } from './context.js';
import { downloadAll, fetchOperations, renderDownloads } from './ops.js';
import {
  addPlanOption,
  addRangeOptions,
  PLAN_NEXT_STEP,
  parseNumber,
  rangeOf,
  withExamples,
  writePlan,
} from './shared.js';

function renderReport(r: ReceiptsReport): string {
  const out: string[] = [];
  if (r.matched.length) {
    out.push(style.bold(style.green(`Matched (${r.matched.length})`)));
    out.push(
      renderTable(
        [
          { header: 'FILE', value: (m) => basename(m.file), flex: true, max: 36 },
          { header: 'OP', value: (m) => m.best.op },
          { header: 'DATE', value: (m) => m.best.date },
          { header: 'WORDING', value: (m) => m.best.wording, flex: true, max: 28 },
          { header: 'AMOUNT', value: (m) => formatAmount(m.best.amount), align: 'right' },
          { header: 'SCORE', value: (m) => m.best.score.toFixed(2), align: 'right' },
        ],
        r.matched,
      ),
      '',
    );
  }
  if (r.ambiguous.length) {
    out.push(style.bold(style.yellow(`Ambiguous (${r.ambiguous.length})`)));
    for (const a of r.ambiguous) {
      out.push(`  ${basename(a.file)}  ${style.dim(a.reason)}`);
      for (const c of a.candidates)
        out.push(
          style.dim(`    ${c.op}  ${c.date}  ${formatAmount(c.amount)}  ${c.wording}  — ${c.why}`),
        );
    }
    out.push('');
  }
  if (r.unmatched.length) {
    out.push(style.bold(style.red(`Unmatched (${r.unmatched.length})`)));
    for (const u of r.unmatched)
      out.push(
        `  ${basename(u.file)}  ${style.dim(`${u.reason}; totals ${u.detected.totals.map(formatAmount).join(', ') || '—'}`)}`,
      );
    out.push('');
  }
  if (r.alreadyAttached.length)
    out.push(style.dim(`${r.alreadyAttached.length} already attached (same document), skipped`));
  if (r.alreadyDocumented.length)
    out.push(
      style.yellow(
        `${r.alreadyDocumented.length} excluded: the matching operation already has a document (--include-attached to consider them)`,
      ),
    );
  out.push(
    r.meta.plan
      ? `${style.green('✓')} wrote ${r.matched.length} attach step(s) to ${r.meta.plan}; ${PLAN_NEXT_STEP(r.meta.plan)}`
      : r.matched.length
        ? style.dim('add --plan receipts.plan.json to write these as attach steps')
        : '',
  );
  return out.join('\n').trimEnd();
}

export function registerReceiptsCommands(program: Command): void {
  const receipts = program
    .command('receipts')
    .description('Download justifying documents and match local invoices to operations');

  withExamples(
    addRangeOptions(
      receipts
        .command('download')
        .description(
          'Download every attached document as <opId>_<filename>, skipping files already present',
        )
        .option('-o, --output <dir>', 'Destination directory', 'receipts'),
    ),
    'receipts download --from 2026-01-01 -o ./receipts',
    'receipts download --from 2026-08-01 --to 2026-08-31 --json',
  ).action(async (o: { from?: string; to?: string; output: string }, cmd: Command) => {
    const ctx = contextOf(cmd);
    const records = await fetchOperations(ctx, { ...rangeOf(o) });
    const withDocs = records.filter((r) => r.op.attachments.length);
    ctx.out.info(style.dim(`${withDocs.length} operations with documents`));
    ctx.out.result(await downloadAll(ctx, withDocs, o.output), renderDownloads);
  });

  withExamples(
    addPlanOption(
      addRangeOptions(
        receipts
          .command('match <paths...>')
          .description('Match local PDFs/images to operations by amount, date and vendor name')
          .option(
            '--min-score <score>',
            'Confidence needed to propose an attachment (0–1)',
            parseNumber,
            0.8,
          )
          .option(
            '--include-attached',
            'Also propose operations that already have a document (default: only those missing one)',
          ),
        ' (default: around the documents’ dates)',
      ),
    ),
    'receipts match ./inbox',
    'receipts match ./inbox/*.pdf --plan receipts.plan.json',
    'receipts match ~/Downloads/invoices --from 2026-07-01 --min-score 0.9 --json',
  ).action(
    async (
      paths: string[],
      o: { from?: string; to?: string; minScore: number; plan?: string; includeAttached?: boolean },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      if (o.minScore < 0 || o.minScore > 1)
        throw new ComptaError('USAGE', '--min-score must be between 0 and 1', {
          exitCode: ExitCode.usage,
        });
      const files = await collectFiles(paths);
      if (!files.length)
        throw new ComptaError('USAGE', 'No PDF or image files found', {
          exitCode: ExitCode.usage,
          hint: 'pass files or directories containing .pdf/.png/.jpg',
        });
      ctx.out.info(style.dim(`Reading ${files.length} document(s)…`));
      const docs = await mapLimit(files, 4, readReceipt);
      // Old dates in a document (contract start, registration…) should not widen the search window.
      const recent = addDays(today(), -3 * 365);
      const dates = docs
        .flatMap((d) => d.dates)
        .filter((d) => d >= recent)
        .sort();
      const range = rangeOf(o);
      const from =
        range.from ??
        (dates.length ? addDays(dates[0]!, -DATE_WINDOW.before) : addDays(today(), -365));
      const to = range.to ?? (dates.length ? addDays(dates.at(-1)!, DATE_WINDOW.after) : undefined);
      const records = await fetchOperations(ctx, { from, to });
      const ops = records.map((r) => r.op);
      // Files named "<opId>_…" (as receipts download writes them) point at their operation,
      // even outside the date window. Prefixes that are not operations are ignored.
      const known = new Map(ops.map((op) => [op.id, op]));
      const compta = await ctx.compta();
      const byId = new Map<string, Operation>();
      for (const id of new Set(
        docs.map((d) => prefixedOpId(d.name)).filter((x): x is string => !!x),
      )) {
        const op =
          known.get(id) ??
          (await compta.getOperation(id).then(
            (r) => r.op,
            () => undefined,
          ));
        if (op) byId.set(id, op);
      }
      const { report, steps } = matchReceipts(docs, ops, {
        minScore: o.minScore,
        includeAttached: o.includeAttached,
        byId,
      });
      let planPath: string | null = null;
      if (o.plan) {
        planPath = await writePlan(
          o.plan,
          buildPlan(compta.company, `compta-cli ${VERSION} receipts match`, steps),
        );
      }
      const full: ReceiptsReport = {
        meta: {
          files: files.length,
          matched: report.matched.length,
          ambiguous: report.ambiguous.length,
          unmatched: report.unmatched.length,
          alreadyAttached: report.alreadyAttached.length,
          alreadyDocumented: report.alreadyDocumented.length,
          minScore: o.minScore,
          plan: planPath ? (o.plan ?? null) : null,
        },
        ...report,
      };
      // In JSON mode the human summary isn't printed: say what the plan left out on stderr.
      if (planPath && !ctx.out.human)
        ctx.out.info(
          `wrote ${steps.length} attach step(s) to ${o.plan}; ${report.alreadyDocumented.length} excluded because the operation already has a document`,
        );
      ctx.out.result(full, renderReport);
    },
  );
}
