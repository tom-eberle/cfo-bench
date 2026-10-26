import { writeFile } from 'node:fs/promises';
import { type Command, Option } from 'commander';
import type { Operation } from '../api/schemas.js';
import { style } from '../output/style.js';
import { includesLoose } from '../util/text.js';
import { contextOf } from './context.js';
import { fetchOperations } from './ops.js';
import { renderAccounts, renderCategories } from './render.js';
import { addRangeOptions, rangeOf, withExamples } from './shared.js';

export const EXPORT_COLUMNS = [
  'date',
  'wording',
  'amount_ttc',
  'amount_ht',
  'vat',
  'vat_rate',
  'is_expense',
  'category',
  'category_group',
  'memo',
  'validated',
  'has_receipt',
  'compta_id',
] as const;
type ExportRow = Record<(typeof EXPORT_COLUMNS)[number], string | number | boolean | null>;

export function exportRow(op: Operation): ExportRow {
  return {
    date: op.date,
    wording: op.wording,
    amount_ttc: op.amount,
    amount_ht: op.amountExcludingVat,
    vat: op.vatAmount,
    vat_rate: op.vatRate,
    is_expense: op.direction === 'expense',
    category:
      op.category?.name ??
      (op.breakdowns.filter((b) => !b.isCounterpart).length > 1 ? 'split' : ''),
    category_group: op.category?.path.length === 2 ? op.category.path[0]! : '',
    memo: op.memo,
    validated: op.validated,
    has_receipt: op.attachments.length > 0,
    compta_id: op.id,
  };
}

/** Free-text columns that come from bank data and users, never numbers. */
const TEXT_COLUMNS = new Set<string>(['wording', 'memo', 'category', 'category_group']);

/**
 * Spreadsheet formula injection guard (OWASP "CSV injection"): a text cell
 * starting with = + - @ tab or CR is prefixed with a single quote so Excel,
 * LibreOffice and Sheets show it as text instead of evaluating it.
 */
export function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function toCsv(rows: readonly ExportRow[]): string {
  const cell = (column: string, v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (TEXT_COLUMNS.has(column)) s = neutralizeFormula(s);
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = rows.map((r) => EXPORT_COLUMNS.map((c) => cell(c, r[c])).join(','));
  return `${[EXPORT_COLUMNS.join(','), ...lines].join('\n')}\n`;
}

export function registerResourceCommands(program: Command): void {
  const categories = program
    .command('categories')
    .description('Compta categories (ids for --category and rules)');
  withExamples(
    categories
      .command('list')
      .description('List assignable categories (cached for 24 h; --no-cache to refresh)')
      .option('--search <text>', 'Name or group contains this text')
      .addOption(
        new Option('--for <direction>', 'Only categories usable for expenses or income').choices([
          'expense',
          'income',
        ]),
      )
      .option('--raw', 'Print the untouched API payload'),
    'categories list --search logiciel',
    'categories list --for expense --json',
  ).action(
    async (o: { search?: string; for?: 'expense' | 'income'; raw?: boolean }, cmd: Command) => {
      const ctx = contextOf(cmd);
      const compta = await ctx.compta();
      if (o.raw) return ctx.out.result(await compta.rawCategories());
      const list = (await compta.categories())
        .filter((c) => !o.search || includesLoose(c.path.join(' '), o.search))
        .filter((c) => !o.for || c.direction === o.for || c.direction === 'both')
        .sort(
          (a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.name.localeCompare(b.name),
        );
      ctx.out.result(list, renderCategories);
    },
  );

  const accounts = program.command('accounts').description('Bank accounts');
  withExamples(
    accounts
      .command('list')
      .description('List bank accounts with live balances (in each account’s currency)')
      .option('--raw', 'Print the untouched API payload'),
    'accounts list',
    'accounts list --json | jq ".[] | {name, balance}"',
  ).action(async (o: { raw?: boolean }, cmd: Command) => {
    const ctx = contextOf(cmd);
    const result = await (await ctx.compta()).accounts();
    if (o.raw) return ctx.out.result(result.raw);
    ctx.out.result(result.data, renderAccounts);
  });

  withExamples(
    addRangeOptions(
      program
        .command('export')
        .description('Flat transaction export (one row per operation) for spreadsheets and scripts')
        .addOption(
          new Option('--format <format>', 'Output format')
            .choices(['csv', 'json', 'jsonl'])
            .default('csv'),
        )
        .option('-o, --output <file>', 'Write to a file instead of stdout'),
    ),
    'export --from 2026-01-01 --to 2026-12-31 -o 2026.csv',
    'export --format jsonl | jq -c "select(.has_receipt == false)"',
  ).action(
    async (
      o: { from?: string; to?: string; format: 'csv' | 'json' | 'jsonl'; output?: string },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      const rows = (await fetchOperations(ctx, { ...rangeOf(o) })).map((r) => exportRow(r.op));
      const text =
        o.format === 'csv'
          ? toCsv(rows)
          : o.format === 'jsonl'
            ? rows.map((r) => `${JSON.stringify(r)}\n`).join('')
            : `${JSON.stringify(rows, null, 2)}\n`;
      if (o.output) {
        await writeFile(o.output, text, { mode: 0o600 });
        ctx.out.result(
          { file: o.output, rows: rows.length, format: o.format },
          (r) => `${style.green('✓')} wrote ${r.rows} rows to ${r.file}`,
        );
      } else {
        ctx.runtime.stdout.write(text);
      }
    },
  );
}
