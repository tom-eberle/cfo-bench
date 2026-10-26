import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Command, Option } from 'commander';
import type { OperationFilter, OperationRecord } from '../api/compta.js';
import { VAT_EXEMPT_KINDS } from '../api/schemas.js';
import { usageError } from '../output/errors.js';
import { style } from '../output/style.js';
import { resolveUpload } from '../plan/attachments.js';
import { expectFor } from '../plan/diff.js';
import { type SetChanges, type StepDraft, setChangesSchema } from '../plan/types.js';
import { FRENCH_VAT_RATES } from '../util/money.js';
import { plural } from '../util/text.js';
import { type Context, contextOf } from './context.js';
import { runSteps } from './mutate.js';
import { renderOperation, renderOperations } from './render.js';
import {
  addMutationOptions,
  addRangeOptions,
  parseInteger,
  parseNumber,
  parsePositiveInt,
  rangeOf,
  withExamples,
} from './shared.js';

interface ListOptions {
  validated?: boolean;
  unvalidated?: boolean;
  from?: string;
  to?: string;
  search?: string;
  missingReceipt?: boolean;
  category?: number;
  expense?: boolean;
  income?: boolean;
  limit: number;
  all?: boolean;
  raw?: boolean;
}

export function filterFromOptions(
  o: Omit<ListOptions, 'limit' | 'raw'> & { limit?: number },
): OperationFilter {
  if (o.validated && o.unvalidated)
    throw usageError('Use either --validated or --unvalidated, not both');
  if (o.expense && o.income) throw usageError('Use either --expense or --income, not both');
  return {
    ...rangeOf(o),
    status: o.validated ? 'validated' : o.unvalidated ? 'unvalidated' : 'all',
    search: o.search,
    missingReceipt: o.missingReceipt,
    category: o.category,
    direction: o.expense ? 'expense' : o.income ? 'income' : undefined,
    limit: o.all ? undefined : o.limit,
  };
}

/** Fetch operations with progress feedback on stderr. */
export async function fetchOperations(
  ctx: Context,
  filter: OperationFilter,
): Promise<OperationRecord[]> {
  const compta = await ctx.compta();
  ctx.out.info(style.dim('Fetching operations…'));
  return compta.listOperations(filter);
}

export function addListFilters(command: Command): Command {
  return addRangeOptions(command)
    .option('--validated', 'Only operations validated in Compta')
    .option('--unvalidated', 'Only operations waiting for validation')
    .option('--search <text>', 'Wording or memo contains this text (case and accents ignored)')
    .option('--missing-receipt', 'Only operations without any attached document')
    .option('--category <id>', 'Only this category id (-1 for uncategorized)', parseInteger)
    .option('--expense', 'Only expenses')
    .option('--income', 'Only income');
}

async function downloadAll(ctx: Context, records: readonly OperationRecord[], dir: string) {
  const compta = await ctx.compta();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const results: {
    op: string;
    attachment: string;
    file: string;
    status: 'downloaded' | 'skipped' | 'failed';
    bytes?: number;
    error?: string;
  }[] = [];
  for (const { op } of records) {
    for (const att of op.attachments) {
      const safe = (att.filename || `attachment-${att.id}`)
        .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
        .slice(0, 150);
      const file = join(dir, `${op.id}_${safe}`);
      const existing = await stat(file).catch(() => null);
      if (existing?.size) {
        results.push({ op: op.id, attachment: att.id, file, status: 'skipped' });
        continue;
      }
      try {
        const bytes = await compta.downloadAttachment(att);
        await writeFile(file, bytes, { mode: 0o600 });
        results.push({
          op: op.id,
          attachment: att.id,
          file,
          status: 'downloaded',
          bytes: bytes.length,
        });
        ctx.out.info(style.dim(`  ${file}`));
      } catch (e) {
        results.push({
          op: op.id,
          attachment: att.id,
          file,
          status: 'failed',
          error: (e as Error).message,
        });
      }
    }
  }
  return results;
}

export function renderDownloads(results: Awaited<ReturnType<typeof downloadAll>>): string {
  const count = (s: string) => results.filter((r) => r.status === s).length;
  const failed = results.filter((r) => r.status === 'failed');
  return [
    `${style.green(`${count('downloaded')} downloaded`)} · ${count('skipped')} already present${failed.length ? ` · ${style.red(`${failed.length} failed`)}` : ''}`,
    ...failed.map((f) => style.red(`  ${f.file}: ${f.error}`)),
  ].join('\n');
}

export { downloadAll };

export function registerOpsCommands(program: Command): void {
  const ops = program
    .command('ops')
    .description('Inspect and edit operations (building blocks for the workflows)');

  withExamples(
    addListFilters(ops.command('list').description('List operations, newest first'))
      .option('--limit <n>', 'Maximum number of operations', parsePositiveInt, 50)
      .option('--all', 'Return every matching operation (ignores --limit)')
      .option('--raw', 'Print the untouched API objects'),
    'ops list --unvalidated --limit 20',
    'ops list --from 2026-08-01 --to 2026-08-31 --expense --missing-receipt',
    'ops list --search hetzner --all --jsonl',
  ).action(async (o: ListOptions, cmd: Command) => {
    const ctx = contextOf(cmd);
    const records = await fetchOperations(ctx, filterFromOptions(o));
    if (o.raw) return ctx.out.result(records.map((r) => r.raw));
    const ops = records.map((r) => r.op);
    ctx.out.result(ops, (list) =>
      renderOperations(
        list,
        !o.all && list.length === o.limit
          ? `${plural(list.length, 'operation')} (limit reached; use --limit or --all)`
          : undefined,
      ),
    );
  });

  withExamples(
    ops
      .command('get <id>')
      .description('Show one operation with its breakdowns and documents')
      .option('--raw', 'Print the untouched API object'),
    'ops get 10001',
    'ops get 10001 --json | jq .breakdowns',
  ).action(async (id: string, o: { raw?: boolean }, cmd: Command) => {
    const ctx = contextOf(cmd);
    const { raw, op } = await (await ctx.compta()).getOperation(id);
    if (o.raw) return ctx.out.result(raw);
    ctx.out.result(op, renderOperation);
  });

  withExamples(
    addMutationOptions(
      ops
        .command('set <ids...>')
        .description('Change category, VAT treatment or memo (same engine as apply)')
        .option('--category <id>', 'Category id (see: compta categories list)', parsePositiveInt)
        .addOption(
          new Option(
            '--vat-rate <percent>',
            `VAT rate in percent (${FRENCH_VAT_RATES.join(', ')}); recomputes the VAT amount`,
          ).argParser(parseNumber),
        )
        .addOption(
          new Option('--vat-exempt <reason>', 'Zero the VAT and record why').choices(
            VAT_EXEMPT_KINDS,
          ),
        )
        .option('--memo <text>', 'Set the memo ("" to clear)')
        .option('--breakdown <id>', 'Breakdown to edit (split operations only)')
        .option('--force', 'Apply even if the operation changed since it was read')
        .option(
          '--allow-filed-periods',
          'Allow edits in months whose VAT return is filed, or closed years',
        ),
    ),
    'ops set 10001 --category 77 --vat-exempt outside-eu --dry-run',
    'ops set 10001 10002 --vat-rate 20 --yes',
    'ops set 10001 --memo "Annual plan, see contract"',
  ).action(
    async (
      ids: string[],
      o: {
        category?: number;
        vatRate?: number;
        vatExempt?: string;
        memo?: string;
        breakdown?: string;
        dryRun?: boolean;
        yes?: boolean;
        force?: boolean;
        allowFiledPeriods?: boolean;
      },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      const parsed = setChangesSchema.safeParse({
        category: o.category,
        vatRate: o.vatRate,
        vatExempt: o.vatExempt,
        memo: o.memo === undefined ? undefined : o.memo || null,
      });
      if (!parsed.success)
        throw usageError(
          parsed.error.issues[0]?.message ?? 'invalid changes',
          'see: compta ops set --help',
        );
      const set: SetChanges = Object.fromEntries(
        Object.entries(parsed.data).filter(([, v]) => v !== undefined),
      );
      if (o.breakdown && ids.length > 1)
        throw usageError('--breakdown applies to a single operation');
      const compta = await ctx.compta();
      const drafts: StepDraft[] = [];
      for (const id of ids) {
        const { op } = await compta.getOperation(id);
        const shape = {
          action: 'set' as const,
          set,
          ...(o.breakdown ? { breakdown: o.breakdown } : {}),
        };
        drafts.push({
          op: id,
          ...shape,
          expect: expectFor(op, shape),
          why: 'requested on the command line',
        });
      }
      await runSteps(ctx, 'ops set', drafts, o);
    },
  );

  withExamples(
    addMutationOptions(
      ops
        .command('attach <id> <files...>')
        .description(
          'Upload documents to an operation (a leading "<digits>_" is stripped from the shown name)',
        )
        .option('--name <name>', 'Display name in Compta (single file only)')
        .option('--allow-any-path', 'Allow files outside the current directory'),
    ),
    'ops attach 10001 ./invoices/2026-08-nimbus.pdf --yes',
    'ops attach 10001 ./10001_receipt.pdf --dry-run',
  ).action(
    async (
      id: string,
      files: string[],
      o: { name?: string; dryRun?: boolean; yes?: boolean; allowAnyPath?: boolean },
      cmd: Command,
    ) => {
      if (o.name && files.length !== 1) throw usageError('--name needs exactly one file');
      const ctx = contextOf(cmd);
      // Fail fast on any disallowed file, before previewing or uploading anything.
      for (const file of files)
        resolveUpload(file, {
          baseDir: process.cwd(),
          cwd: process.cwd(),
          allowAnyPath: o.allowAnyPath,
        });
      const drafts: StepDraft[] = files.map((file) => ({
        op: id,
        action: 'attach',
        file,
        ...(o.name ? { name: o.name } : {}),
        why: 'requested on the command line',
      }));
      await runSteps(ctx, 'ops attach', drafts, o);
    },
  );

  withExamples(
    addMutationOptions(
      ops
        .command('detach <id> <attachmentId>')
        .description('Remove a document from an operation (refused on locked operations)')
        .option(
          '--allow-filed-periods',
          'Allow it in months whose VAT return is filed, or closed years',
        ),
    ),
    'ops detach 10001 501 --dry-run',
  ).action(
    async (
      id: string,
      attachmentId: string,
      o: { dryRun?: boolean; yes?: boolean; allowFiledPeriods?: boolean },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      const { op } = await (await ctx.compta()).getOperation(id);
      await runSteps(
        ctx,
        'ops detach',
        [
          {
            op: id,
            action: 'detach',
            attachmentId,
            expect: expectFor(op, { action: 'detach' }),
            why: 'requested on the command line',
          },
        ],
        o,
      );
    },
  );

  withExamples(
    addMutationOptions(
      ops
        .command('validate <ids...>')
        .description('Mark operations as validated (refused if Compta would show errors)')
        .option('--allow-filed-periods', 'Allow validation in months whose VAT return is filed'),
    ),
    'ops validate 10001 10002 --yes',
  ).action(
    async (
      ids: string[],
      o: { dryRun?: boolean; yes?: boolean; allowFiledPeriods?: boolean },
      cmd: Command,
    ) => {
      const drafts: StepDraft[] = ids.map((op) => ({
        op,
        action: 'validate',
        why: 'requested on the command line',
      }));
      await runSteps(contextOf(cmd), 'ops validate', drafts, o);
    },
  );

  withExamples(
    ops
      .command('download <id>')
      .description('Download the documents attached to an operation as <id>_<filename>')
      .option('-o, --output <dir>', 'Destination directory', '.'),
    'ops download 10001 -o ./receipts',
  ).action(async (id: string, o: { output: string }, cmd: Command) => {
    const ctx = contextOf(cmd);
    const record = await (await ctx.compta()).getOperation(id);
    ctx.out.result(await downloadAll(ctx, [record], o.output), renderDownloads);
  });
}
