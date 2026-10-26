import type { Account, Category, Operation } from '../api/schemas.js';
import { style } from '../output/style.js';
import { type Column, renderKeyValues, renderTable } from '../output/table.js';
import type { ApplyReport, Change, StepResult } from '../plan/types.js';
import { formatAmount, formatRate, formatSigned } from '../util/money.js';
import { plural } from '../util/text.js';
import type { Finding } from '../workflows/findings.js';

export const operationColumns: Column<Operation>[] = [
  { header: 'ID', value: (o) => o.id },
  { header: 'DATE', value: (o) => o.date },
  { header: 'WORDING', value: (o) => o.wording, flex: true, max: 44 },
  { header: 'AMOUNT', value: (o) => formatSigned(o.amount, o.direction), align: 'right' },
  {
    header: 'VAT',
    value: (o) => (o.vatAmount === null ? 'split' : formatAmount(o.vatAmount)),
    align: 'right',
  },
  {
    header: 'CATEGORY',
    value: (o) =>
      o.category?.name ?? (o.breakdowns.length > 1 ? 'split' : style.yellow('uncategorized')),
    flex: true,
    max: 32,
  },
  {
    header: 'DOCS',
    value: (o) => (o.attachments.length ? String(o.attachments.length) : style.dim('–')),
    align: 'right',
  },
  {
    header: 'STATUS',
    value: (o) => (o.validated ? style.green('validated') : style.yellow('pending')),
  },
];

export function renderOperations(ops: readonly Operation[], footer?: string): string {
  if (!ops.length) return style.dim('No operations match.');
  return `${renderTable(operationColumns, ops)}\n${style.dim(footer ?? plural(ops.length, 'operation'))}`;
}

function vatLabel(b: {
  vatAmount: number;
  vatRate: number | null;
  vatExemptReason: string | null;
}): string {
  const rate = b.vatRate !== null ? ` at ${formatRate(b.vatRate)}` : '';
  const exempt = b.vatExemptReason ? ` (exempt: ${b.vatExemptReason})` : '';
  return `${formatAmount(b.vatAmount)} €${rate}${exempt}`;
}

export function renderOperation(op: Operation): string {
  const entries: [string, string][] = [
    ['id', op.id],
    ['date', op.date],
    ['wording', op.wording],
    [
      'amount',
      `${formatSigned(op.amount, op.direction)} €${op.original ? `  (${formatAmount(op.original.amount)} ${op.original.currency})` : ''}`,
    ],
    ['status', op.validated ? 'validated' : 'pending validation'],
    ['account', op.account ? `${op.account.name || '—'} (${op.account.id})` : '—'],
    ['memo', op.memo ?? '—'],
  ];
  const lines = [renderKeyValues(entries), '', style.bold('Breakdowns')];
  lines.push(
    renderTable(
      [
        { header: 'ID', value: (b) => b.id },
        {
          header: 'CATEGORY',
          value: (b) =>
            b.category
              ? `${b.category.name} (${b.category.id})`
              : style.yellow('uncategorized (-1)'),
          flex: true,
        },
        { header: 'TTC', value: (b) => formatAmount(b.amount), align: 'right' },
        { header: 'HT', value: (b) => formatAmount(b.amountExcludingVat), align: 'right' },
        { header: 'VAT', value: (b) => vatLabel(b) },
        { header: 'ROLE', value: (b) => (b.isCounterpart ? style.dim('counterpart') : 'main') },
      ],
      op.breakdowns,
    ),
  );
  lines.push('', style.bold('Documents'));
  lines.push(
    op.attachments.length
      ? renderTable(
          [
            { header: 'ID', value: (a) => a.id },
            { header: 'FILE', value: (a) => a.filename, flex: true },
            { header: 'TYPE', value: (a) => a.type },
          ],
          op.attachments,
        )
      : style.yellow('none'),
  );
  lines.push('', style.dim(op.url));
  return lines.join('\n');
}

export function renderCategories(categories: readonly Category[]): string {
  if (!categories.length) return style.dim('No categories match.');
  return renderTable(
    [
      { header: 'ID', value: (c) => String(c.id), align: 'right' },
      { header: 'NAME', value: (c) => c.name, flex: true },
      { header: 'GROUP', value: (c) => c.group ?? '—', flex: true },
      { header: 'FOR', value: (c) => c.direction },
      { header: 'VAT', value: (c) => formatRate(c.defaultVatRate), align: 'right' },
      { header: 'PCG', value: (c) => c.accountingNumber ?? '—' },
    ],
    categories,
  );
}

export function renderAccounts(accounts: readonly Account[]): string {
  return renderTable(
    [
      { header: 'ID', value: (a) => a.id },
      { header: 'NAME', value: (a) => a.name, flex: true },
      { header: 'BANK', value: (a) => a.bank, flex: true },
      { header: 'BALANCE', value: (a) => formatAmount(a.balance), align: 'right' },
      { header: 'CUR', value: (a) => a.currency },
      { header: 'STATE', value: (a) => (a.closed ? 'closed' : a.hidden ? 'hidden' : 'open') },
    ],
    accounts,
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

export function formatChanges(changes: readonly Change[]): string {
  return changes.map((c) => `${c.field} ${formatValue(c.from)} → ${formatValue(c.to)}`).join(', ');
}

const STATUS_STYLE: Record<StepResult['status'], (s: string) => string> = {
  applied: style.green,
  planned: style.cyan,
  skipped: style.dim,
  conflict: style.yellow,
  failed: style.red,
  pending: style.dim,
};

export function renderApplyReport(report: ApplyReport): string {
  const rows = report.results;
  const table = renderTable(
    [
      { header: 'STEP', value: (r) => r.step },
      { header: 'OP', value: (r) => r.op },
      { header: 'DATE', value: (r) => r.operation?.date ?? '' },
      { header: 'WORDING', value: (r) => r.operation?.wording ?? '', flex: true, max: 30 },
      { header: 'ACTION', value: (r) => r.action },
      { header: 'STATUS', value: (r) => STATUS_STYLE[r.status](r.status) },
      {
        header: 'DETAIL',
        value: (r) => {
          const what = r.changes.length ? formatChanges(r.changes) : (r.reason ?? '');
          const detail = r.error
            ? `${r.error.message}${r.changes.length ? ` — saved: ${what}` : ''}`
            : what;
          return r.file && !r.error ? `${detail} (${r.file})` : detail;
        },
        flex: true,
      },
    ],
    rows,
  );
  const m = report.meta;
  const parts = m.dryRun
    ? [
        `${m.planned} to apply`,
        `${m.skipped} skipped`,
        m.conflicts ? style.yellow(`${m.conflicts} changed since planning`) : '',
        m.failed ? style.red(`${m.failed} failed`) : '',
      ]
    : [
        style.green(`${m.applied} applied`),
        `${m.skipped} skipped`,
        m.conflicts ? style.yellow(`${m.conflicts} changed since planning`) : '',
        m.failed ? style.red(`${m.failed} failed`) : '',
        m.pending ? `${m.pending} not attempted` : '',
      ];
  const effects = rows
    .filter((r) => r.sideEffects?.length)
    .map((r) =>
      style.yellow(
        `  ${r.step} op ${r.op}: Compta also changed ${formatChanges(r.sideEffects ?? [])}`,
      ),
    );
  const why = rows
    .filter((r) => r.status === 'planned' || r.status === 'applied')
    .map((r) => `  ${style.dim(r.step)} ${r.why}`);
  return [
    table,
    '',
    parts.filter(Boolean).join(' · '),
    ...(effects.length ? ['', style.bold(style.yellow('Side effects')), ...effects] : []),
    ...(why.length ? ['', style.bold('Why'), ...why] : []),
  ].join('\n');
}

/**
 * ID/DATE/WORDING/AMOUNT columns for something about an operation, or about a
 * declaration (then: its id, due date and label).
 */
export function subjectColumns<T>(
  subject: (row: T) => {
    op: Operation | null;
    declaration?: { id: string; label: string | null; type: string; dueDate: string | null };
  },
): Column<T>[] {
  return [
    { header: 'ID', value: (r) => subject(r).op?.id ?? subject(r).declaration?.id ?? '' },
    { header: 'DATE', value: (r) => subject(r).op?.date ?? subject(r).declaration?.dueDate ?? '' },
    {
      header: 'WORDING',
      value: (r) => {
        const s = subject(r);
        return s.op?.wording ?? s.declaration?.label ?? s.declaration?.type ?? '';
      },
      flex: true,
      max: 36,
    },
    {
      header: 'AMOUNT',
      value: (r) => {
        const op = subject(r).op;
        return op ? formatSigned(op.amount, op.direction) : '';
      },
      align: 'right',
    },
  ];
}

const SEVERITY_STYLE = { error: style.red, warning: style.yellow, info: style.dim };

export function renderFindings(
  findings: readonly Finding[],
  title?: (code: string) => string,
): string {
  if (!findings.length) return style.green('No findings.');
  const groups = new Map<string, Finding[]>();
  for (const f of findings) groups.set(f.code, [...(groups.get(f.code) ?? []), f]);
  const blocks: string[] = [];
  for (const [code, list] of groups) {
    const worst = list.some((f) => f.severity === 'error')
      ? 'error'
      : list.some((f) => f.severity === 'warning')
        ? 'warning'
        : 'info';
    blocks.push(
      `${SEVERITY_STYLE[worst](style.bold(title?.(code) ?? code))} ${style.dim(`(${list.length})`)}`,
    );
    blocks.push(
      renderTable(
        [
          ...subjectColumns<Finding>((f) => f),
          ...(list.some((f) => f.fix)
            ? [{ header: 'FIX', value: (f: Finding) => (f.fix ? style.cyan('plan') : '') }]
            : []),
          { header: 'DETAIL', value: (f) => f.detail, flex: true },
        ],
        list,
      ),
      '',
    );
  }
  return blocks.join('\n').trimEnd();
}
