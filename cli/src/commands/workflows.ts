import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  boxesByName,
  type Compta,
  type OperationRecord,
  type VatReturnSummary,
} from '../api/compta.js';
import { ComptaError, ExitCode, usageError } from '../output/errors.js';
import { style } from '../output/style.js';
import { renderTable } from '../output/table.js';
import { needsPeriodGuard, whyNotPlannable } from '../plan/apply.js';
import { buildPlan, type PlanStep, type StepDraft } from '../plan/types.js';
import { addDays, parseMonthOption, previousMonth, today } from '../util/dates.js';
import { formatAmount } from '../util/money.js';
import { plural } from '../util/text.js';
import { VERSION } from '../version.js';
import { runCloseCheck } from '../workflows/close-check.js';
import type { CategoryIndex } from '../workflows/findings.js';
import { DEFAULT_RULES_FILE, inferRules, loadRules, planRules } from '../workflows/rules.js';
import { buildTodo, countByReason, TODO_REASONS, type TodoItem } from '../workflows/todo.js';
import {
  compareWithDeclaration,
  estimateCa3,
  runVatCheck,
  type VatSummary,
} from '../workflows/vat.js';
import { VendorRegistry } from '../workflows/vendors.js';
import { type Context, contextOf } from './context.js';
import { loadPeriodGuard } from './mutate.js';
import { addListFilters, fetchOperations, filterFromOptions } from './ops.js';
import { renderFindings, subjectColumns } from './render.js';
import {
  addDocumentsOption,
  addPlanOption,
  addRangeOptions,
  PLAN_NEXT_STEP,
  parsePositiveInt,
  rangeOf,
  rulesOption,
  withExamples,
  writePlan,
} from './shared.js';

function setSummary(set: object): string {
  return Object.entries(set)
    .map(([k, v]) => `${k}=${v ?? '∅'}`)
    .join(' ');
}

async function categoriesOrNull(ctx: Context, compta: Compta): Promise<CategoryIndex | undefined> {
  try {
    return await compta.categoryIndex();
  } catch (e) {
    ctx.out.warn(`categories unavailable, some VAT checks are skipped (${(e as Error).message})`);
    return undefined;
  }
}

function progress(ctx: Context, label: string) {
  let last = 0;
  return (done: number, total: number) => {
    if (done === total || Date.now() - last > 1500) {
      last = Date.now();
      ctx.out.info(style.dim(`  ${label} ${done}/${total}`));
    }
  };
}

/** Options shared by every command that writes fix plans. */
function addPlanSafetyOptions(command: Command, { warnings = true } = {}): Command {
  if (warnings)
    command.option(
      '--include-warnings',
      'Also plan fixes backed by weaker evidence (warning-level findings)',
    );
  return command.option(
    '--allow-filed-periods',
    'Also plan edits in months whose VAT return is filed, or in closed years',
  );
}

export interface NotPlannable {
  op: string;
  action: string;
  code: string;
  reason: string;
}

/**
 * Keep only steps apply would accept, using apply's own checks (locks, filed
 * periods unless allowed, validation, exemption preconditions, split operations).
 * The others are reported as not plannable, with the reason.
 */
async function plannableSteps(
  ctx: Context,
  compta: Compta,
  steps: StepDraft[],
  records: readonly OperationRecord[],
  allowFiledPeriods?: boolean,
): Promise<{ steps: StepDraft[]; notPlannable: NotPlannable[]; heldBack: number }> {
  if (!steps.length) return { steps, notPlannable: [], heldBack: 0 };
  const byId = new Map(records.map((r) => [r.op.id, r]));
  const periods = needsPeriodGuard(steps)
    ? await loadPeriodGuard(compta, allowFiledPeriods)
    : undefined;
  const categories = await compta.categoryMap();
  const kept: StepDraft[] = [];
  const notPlannable: NotPlannable[] = [];
  for (const draft of steps) {
    const record = byId.get(draft.op);
    const refusal = record
      ? whyNotPlannable(record.raw, record.op, { id: 'check', ...draft } as PlanStep, {
          periods,
          allowFiledPeriods,
          categories,
        })
      : null;
    if (refusal)
      notPlannable.push({
        op: draft.op,
        action: draft.action,
        code: refusal.code,
        reason: refusal.message,
      });
    else kept.push(draft);
  }
  const heldBack = notPlannable.filter((n) => n.code === 'FILED_PERIOD').length;
  if (heldBack)
    ctx.out.warn(
      `${heldBack} fix(es) left out: the operations are in filed VAT periods or closed years (--allow-filed-periods to include them)`,
    );
  const others = notPlannable.length - heldBack;
  if (others)
    ctx.out.warn(`${others} fix(es) left out because apply would refuse them (see notPlannable)`);
  return { steps: kept, notPlannable, heldBack };
}

async function declarationsOrEmpty(ctx: Context, compta: Compta): Promise<VatReturnSummary[]> {
  try {
    return await compta.vatReturns();
  } catch (e) {
    ctx.out.warn(`could not list declarations (${(e as Error).message})`);
    return [];
  }
}

async function maybeWritePlan(
  compta: Compta,
  path: string | undefined,
  command: string,
  steps: StepDraft[],
) {
  if (!path) return null;
  await writePlan(path, buildPlan(compta.company, `compta-cli ${VERSION} ${command}`, steps));
  return path;
}

/**
 * The CA3 for a month: the latest filed return (corrective returns supersede
 * the original), else the open one with Compta's draft.
 */
export function pickCa3(
  declarations: readonly VatReturnSummary[],
  month: string,
): VatReturnSummary | undefined {
  const forMonth = declarations.filter(
    (d) => d.return_type.startsWith('CA3') && d.period_start.startsWith(month),
  );
  const filed = forMonth
    .filter((d) => d.status === 'completed')
    .sort((a, b) =>
      (b.confirmed_at ?? b.filed_at ?? '').localeCompare(a.confirmed_at ?? a.filed_at ?? ''),
    );
  return filed[0] ?? forMonth[0];
}

const REASON_TITLES: Record<string, string> = {
  MISSING_RECEIPT: 'Missing receipt',
  UNCATEGORIZED: 'Uncategorized',
  UNVALIDATED: 'Waiting for validation',
  VAT_SUSPECT: 'VAT to check',
  RULE_MATCH: 'A local rule would change it',
  OVERDUE_DECLARATION: 'Overdue declarations',
  POSSIBLE_DUPLICATE: 'Possible duplicates',
  DOCUMENT_AMOUNT_MISMATCH: 'Document amount differs',
  VAT_TOTAL_MISMATCH: 'TTC ≠ HT + VAT',
  VAT_RATE_INVALID: 'Invalid VAT rate',
  REVERSE_CHARGE_SUSPECT: 'Reverse charge to check (foreign supplier)',
  ZERO_VAT_NO_REASON: 'Zero VAT without exemption reason',
  DOCUMENT_VAT_MISMATCH: 'Invoice VAT ≠ booked VAT',
};

const TODO_SUMMARY: Record<(typeof TODO_REASONS)[number], string> = {
  OVERDUE_DECLARATION: 'overdue declarations',
  MISSING_RECEIPT: 'missing receipts',
  UNCATEGORIZED: 'uncategorized',
  UNVALIDATED: 'to validate',
  VAT_SUSPECT: 'VAT to check',
  RULE_MATCH: 'rule matches',
};

function renderTodo(items: readonly TodoItem[]): string {
  if (!items.length) return style.green('✓ Nothing to do.');
  const counts = countByReason(items);
  const blocks: string[] = [];
  for (const reason of TODO_REASONS) {
    const list = items.filter((i) => i.reasons.some((r) => r.code === reason));
    if (!list.length) continue;
    const urgent =
      reason === 'MISSING_RECEIPT'
        ? list.filter((i) => i.reasons.some((r) => r.code === reason && r.severity === 'error'))
            .length
        : 0;
    blocks.push(
      `${style.bold(REASON_TITLES[reason] ?? reason)} ${style.dim(`(${list.length}${urgent ? `, ${urgent} over 150 € need a full invoice` : ''})`)}`,
    );
    blocks.push(
      renderTable(
        [
          ...subjectColumns<TodoItem>((i) => i),
          {
            header: 'DETAIL',
            value: (i: TodoItem) => {
              const r = i.reasons.find((x) => x.code === reason)!;
              const text = r.severity === 'error' ? style.red(r.detail) : r.detail;
              return i.suggestion && (reason === 'VAT_SUSPECT' || reason === 'RULE_MATCH')
                ? `${text} ${style.cyan('[fix]')}`
                : text;
            },
            flex: true,
          },
        ],
        list,
      ),
      '',
    );
  }
  const summary = TODO_REASONS.filter((r) => counts[r]).map(
    (r) => `${counts[r]} ${TODO_SUMMARY[r]}`,
  );
  blocks.push(style.dim(`${plural(items.length, 'item')} need attention: ${summary.join(' · ')}`));
  if (items.some((i) => i.suggestion))
    blocks.push(
      style.dim(
        'Fixable items: re-run with --plan todo.plan.json, review, then compta apply todo.plan.json',
      ),
    );
  return blocks.join('\n');
}

function declarationStatusText(d: NonNullable<VatSummary['meta']['declaration']>): string {
  if (d.filed) return `filed${d.corrective ? ' (corrected: latest return used)' : ''}`;
  const due = d.dueDate ? ` since ${d.dueDate}` : '';
  return d.isLate
    ? `not filed, overdue${due}`
    : `not filed yet${d.dueDate ? `, due ${d.dueDate}` : ''}`;
}

function renderSummary(s: VatSummary): string {
  const decl = s.meta.declaration;
  const compare = !!decl?.hasForm;
  const column = decl?.filed ? 'FILED' : 'COMPTA DRAFT';
  const header = [
    style.bold(`CA3 estimate for ${s.meta.month}`),
    style.dim(
      `${plural(s.meta.operations, 'operation')}${s.meta.unvalidated ? `, ${s.meta.unvalidated} not yet validated` : ''}${s.meta.uncategorized ? `, ${s.meta.uncategorized} uncategorized` : ''}. Estimate only — not a filing.`,
    ),
    '',
  ];
  const lines = s.lines.filter((l) => (l.estimate ?? 0) !== 0 || (l.declared ?? 0) !== 0);
  type Line = VatSummary['lines'][number];
  const table = renderTable(
    [
      { header: 'BOX', value: (l: Line) => l.box },
      { header: 'LABEL', value: (l) => l.label, flex: true, max: 60 },
      { header: 'ESTIMATE', value: (l) => formatAmount(l.estimate), align: 'right' },
      ...(compare
        ? [
            {
              header: column,
              value: (l: Line) => (l.declared === null ? '—' : String(l.declared)),
              align: 'right' as const,
            },
            {
              header: 'DIFF',
              value: (l: Line) =>
                l.difference === null
                  ? ''
                  : Math.abs(l.difference) > 1
                    ? style.yellow(String(l.difference))
                    : style.dim(String(l.difference)),
              align: 'right' as const,
            },
          ]
        : []),
    ],
    lines,
  );
  const status = decl
    ? `${decl.label ?? `CA3 ${s.meta.month}`}: ${declarationStatusText(decl)}`
    : 'No Compta CA3 declaration exists for this month.';
  const statusLine = decl?.isLate && !decl.filed ? style.red(status) : style.dim(status);
  const source = compare
    ? style.dim(
        decl?.filed
          ? 'Compared with the filed return (whole euros).'
          : 'Compared with Compta’s draft for this open month (whole euros).',
      )
    : '';
  return [...header, table, '', statusLine, source, ...s.notes.map((n) => style.dim(`• ${n}`))]
    .filter((l) => l !== '')
    .join('\n');
}

export function registerWorkflowCommands(program: Command): void {
  // ── todo ────────────────────────────────────────────────────────────
  withExamples(
    addPlanSafetyOptions(
      addPlanOption(
        addRangeOptions(
          program
            .command('todo')
            .description('The morning worklist: everything that needs a human or an agent'),
        )
          .option('--limit <n>', 'Maximum number of items (newest first)', parsePositiveInt, 50)
          .option('--all', 'Return every item')
          .option(
            '--strict',
            'Also ask for receipts on transfers between accounts, capital, loans, subsidies, FX and tax settlements',
          )
          .addOption(rulesOption()),
      ),
    ),
    'todo',
    'todo --from 2026-07-01 --limit 100 --json',
    'todo --plan todo.plan.json',
  ).action(
    async (
      o: {
        from?: string;
        to?: string;
        limit: number;
        all?: boolean;
        rules?: string;
        plan?: string;
        includeWarnings?: boolean;
        allowFiledPeriods?: boolean;
        strict?: boolean;
      },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      const { rules } = await loadRules(o.rules);
      const compta = await ctx.compta();
      const [records, categories, declarations] = await Promise.all([
        fetchOperations(ctx, { ...rangeOf(o) }),
        categoriesOrNull(ctx, compta),
        declarationsOrEmpty(ctx, compta),
      ]);
      const all = buildTodo(records, {
        rules,
        categories,
        declarations,
        includeWarnings: o.includeWarnings,
        strict: o.strict,
      });
      const items = o.all ? all : all.slice(0, o.limit);
      if (items.length < all.length)
        ctx.out.info(
          style.dim(`Showing ${items.length} of ${all.length} items (use --all or --limit)`),
        );
      if (o.plan) {
        const { steps } = await plannableSteps(
          ctx,
          compta,
          items.flatMap((i) => i.suggestion ?? []),
          records,
          o.allowFiledPeriods,
        );
        await maybeWritePlan(compta, o.plan, 'todo', steps);
        ctx.out.info(`wrote ${steps.length} fix(es) to ${o.plan}; ${PLAN_NEXT_STEP(o.plan)}`);
      }
      ctx.out.result(items, renderTodo);
    },
  );

  // ── vat ─────────────────────────────────────────────────────────────
  const vat = program.command('vat').description('VAT audit and monthly CA3 preview');

  withExamples(
    addPlanSafetyOptions(
      addPlanOption(
        addDocumentsOption(
          addRangeOptions(
            vat
              .command('check')
              .description('Audit VAT: arithmetic, rates, reverse charge, exemptions, invoice VAT'),
            ' (default: last 90 days)',
          ),
        ).addOption(rulesOption()),
      ),
    ),
    'vat check --from 2026-07-01 --to 2026-08-31',
    'vat check --from 2026-01-01 --plan vat.plan.json',
    'vat check --no-documents --json',
  ).action(
    async (
      o: {
        from?: string;
        to?: string;
        documents: boolean;
        plan?: string;
        rules?: string;
        includeWarnings?: boolean;
        allowFiledPeriods?: boolean;
      },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      const range = rangeOf({
        from: o.from ?? (o.to ? undefined : addDays(today(), -90)),
        to: o.to,
      });
      const { rules } = await loadRules(o.rules);
      const compta = await ctx.compta();
      const [records, categories] = await Promise.all([
        fetchOperations(ctx, range),
        categoriesOrNull(ctx, compta),
      ]);
      if (o.documents)
        ctx.out.info(style.dim('Reading attached invoices (cached after the first run)…'));
      const { findings, documentsChecked } = await runVatCheck(compta, records, {
        documents: o.documents,
        categories,
        vendors: new VendorRegistry(rules.vendors),
        onProgress: progress(ctx, 'documents'),
      });
      // Plans hold strong-evidence fixes only, unless --include-warnings.
      const fixes = findings
        .filter((f) => f.fix && (f.severity === 'error' || o.includeWarnings))
        .map((f) => f.fix!);
      const candidates = [...new Map(fixes.map((f) => [`${f.op}`, f])).values()];
      // Counted even without --plan, so meta.fixes is what a plan would really contain.
      const {
        steps: unique,
        heldBack,
        notPlannable,
      } = await plannableSteps(ctx, compta, candidates, records, o.allowFiledPeriods);
      const planPath = await maybeWritePlan(compta, o.plan, 'vat check', unique);
      const counts: Record<string, number> = {};
      for (const f of findings) counts[f.code] = (counts[f.code] ?? 0) + 1;
      const report = {
        meta: {
          from: range.from ?? null,
          to: range.to ?? null,
          operations: records.length,
          documentsChecked,
          counts,
          fixes: unique.length,
          weakFixes: findings.filter((f) => f.fix && f.severity !== 'error').length,
          heldBackFiledPeriods: heldBack,
          notPlannable: notPlannable.length,
          plan: planPath,
        },
        findings,
        notPlannable,
      };
      ctx.out.result(report, (r) =>
        [
          renderFindings(r.findings, (code) => REASON_TITLES[code] ?? code),
          '',
          ...r.notPlannable.map((n) =>
            style.yellow(`not plannable: ${n.op} ${n.action} — ${n.reason} (${n.code})`),
          ),
          style.dim(
            `${plural(r.meta.operations, 'operation')} checked, ${r.meta.documentsChecked} with documents read.`,
          ),
          r.meta.plan
            ? `${style.green('✓')} wrote ${r.meta.fixes} fix(es) to ${r.meta.plan}; ${PLAN_NEXT_STEP(r.meta.plan)}`
            : r.meta.fixes
              ? style.dim(
                  `${r.meta.fixes} fix(es) backed by strong evidence: re-run with --plan vat.plan.json`,
                )
              : '',
          r.meta.weakFixes && !o.includeWarnings
            ? style.dim(
                `${r.meta.weakFixes} weaker fix(es) not planned; add --include-warnings after reviewing them`,
              )
            : '',
        ]
          .filter((l) => l !== '')
          .join('\n'),
      );
    },
  );

  withExamples(
    vat
      .command('summary')
      .description(
        'Estimate the monthly CA3 from operations, side by side with the Compta declaration when filed',
      )
      .requiredOption('--month <YYYY-MM>', 'Declaration month'),
    'vat summary --month 2026-08',
    'vat summary --month 2026-03 --json',
  ).action(async (o: { month: string }, cmd: Command) => {
    const ctx = contextOf(cmd);
    const range = parseMonthOption(o.month);
    const compta = await ctx.compta();
    const [records, categories, declarations] = await Promise.all([
      fetchOperations(ctx, range),
      categoriesOrNull(ctx, compta),
      declarationsOrEmpty(ctx, compta),
    ]);
    const current = pickCa3(declarations, o.month);
    // Box 22 is the credit carried from the last *filed* return (Compta's drafts do
    // the same: unfiled drafts don't chain). A chained projection is only a note.
    const lastFiledMonth = declarations
      .filter(
        (d) =>
          d.status === 'completed' &&
          d.return_type.startsWith('CA3') &&
          d.period_start.slice(0, 7) < o.month,
      )
      .map((d) => d.period_start.slice(0, 7))
      .sort()
      .at(-1);
    const lastFiled = lastFiledMonth ? pickCa3(declarations, lastFiledMonth) : undefined;
    const previous = pickCa3(declarations, previousMonth(o.month));
    const previousDraft = previous && previous.status !== 'completed' ? previous : undefined;
    const boxesOf = (id: VatReturnSummary['id']) =>
      compta.vatReturn(String(id)).then((d) => boxesByName(d.boxes));
    const [currentForm, filedForm, draftForm] = await Promise.all([
      current ? boxesOf(current.id) : null,
      lastFiled ? boxesOf(lastFiled.id) : null,
      previousDraft ? boxesOf(previousDraft.id) : null,
    ]);
    const previousCredit =
      typeof filedForm?.['27'] === 'number' ? (filedForm['27'] as number) : null;
    const ops = records.map((r) => r.op);
    const { boxes, byRate } = estimateCa3(ops, categories, previousCredit);
    const notes = [
      'Reverse-charge purchases are self-assessed at 20 % (services); adjust if some were goods or reduced-rate.',
    ];
    if (previousCredit === null)
      notes.push(
        'No filed return with a credit to carry: box 22 is unknown and left out of box 23.',
      );
    else
      notes.push(
        `Box 22 (credit carried forward) is box 27 of the last filed return (${lastFiledMonth}), as in Compta's drafts.`,
      );
    if (typeof draftForm?.['27'] === 'number' && draftForm['27'] !== previousCredit)
      notes.push(
        `Projection: if ${previousMonth(o.month)} is filed as drafted, box 22 would be ${draftForm['27']} instead.`,
      );
    const corrective =
      declarations.filter(
        (d) =>
          d.status === 'completed' &&
          d.return_type.startsWith('CA3') &&
          d.period_start.startsWith(o.month),
      ).length > 1;
    const summary: VatSummary = {
      meta: {
        month: o.month,
        estimate: true,
        operations: ops.length,
        unvalidated: ops.filter((op) => !op.validated).length,
        uncategorized: ops.filter((op) =>
          op.breakdowns.some((b) => !b.isCounterpart && !b.category),
        ).length,
        declaration: current
          ? {
              id: String(current.id),
              label: current.title ?? null,
              status: current.status,
              filed: current.status === 'completed',
              dueDate: current.due_date ? current.due_date.slice(0, 10) : null,
              isLate: !!current.overdue && current.status !== 'completed',
              hasForm: !!currentForm,
              corrective,
            }
          : null,
      },
      collectedByRate: byRate,
      lines: compareWithDeclaration(boxes, currentForm),
      notes,
    };
    ctx.out.result(summary, renderSummary);
  });

  // ── rules ───────────────────────────────────────────────────────────
  const rulesCmd = program
    .command('rules')
    .description(`Local, versionable categorisation rules (${DEFAULT_RULES_FILE})`);

  withExamples(
    addPlanSafetyOptions(
      addPlanOption(
        addListFilters(
          rulesCmd
            .command('apply')
            .description(
              'Plan the changes your rules would make (only operations that differ get a step)',
            ),
        )
          .addOption(rulesOption())
          .option('--unvalidated-only', 'Only operations waiting for validation (the default)')
          .option('--include-validated', 'Also operations already validated in Compta'),
      ),
      // Rules are the user's own intent: there are no weaker fixes to opt into.
      { warnings: false },
    ),
    'rules apply --plan rules.plan.json',
    'rules apply --rules ./config/compta.rules.json --from 2026-01-01 --json',
  ).action(
    async (
      o: Parameters<typeof filterFromOptions>[0] & {
        rules?: string;
        unvalidatedOnly?: boolean;
        includeValidated?: boolean;
        plan?: string;
        allowFiledPeriods?: boolean;
      },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      const { rules, path } = await loadRules(o.rules);
      if (!path)
        throw new ComptaError(
          'RULES_MISSING',
          `No rules file (looked for ./${DEFAULT_RULES_FILE})`,
          { exitCode: ExitCode.usage, hint: 'create one with: compta rules init' },
        );
      if (!rules.rules.length) throw usageError(`${path} has no rules`);
      // Default to operations still waiting for validation: booked history is
      // only touched on request (--include-validated or --validated).
      const filter = filterFromOptions({
        ...o,
        unvalidated: o.unvalidated || o.unvalidatedOnly || (!o.validated && !o.includeValidated),
        limit: undefined,
      });
      const records = await fetchOperations(ctx, filter);
      const result = planRules(rules, records);
      const compta = await ctx.compta();
      const { steps, heldBack, notPlannable } = await plannableSteps(
        ctx,
        compta,
        result.steps,
        records,
        o.allowFiledPeriods,
      );
      result.steps = steps;
      const planPath = await maybeWritePlan(compta, o.plan, 'rules apply', result.steps);
      const report = {
        meta: {
          rules: path,
          operations: records.length,
          matched: result.matched,
          compliant: result.compliant,
          steps: result.steps.length,
          blocked: result.blocked.length,
          heldBackFiledPeriods: heldBack,
          notPlannable: notPlannable.length,
          plan: planPath,
        },
        steps: result.steps,
        blocked: result.blocked,
        notPlannable,
      };
      ctx.out.result(report, (r) =>
        [
          r.steps.length
            ? renderTable(
                [
                  { header: 'OP', value: (s: StepDraft) => s.op },
                  {
                    header: 'SET',
                    value: (s: StepDraft) => (s.action === 'set' ? setSummary(s.set) : s.action),
                  },
                  { header: 'WHY', value: (s: StepDraft) => s.why, flex: true },
                ],
                r.steps,
              )
            : style.green('✓ Every matched operation already follows the rules.'),
          ...r.blocked.map((b) => style.yellow(`! ${b.op} ${b.wording}: ${b.reason}`)),
          ...r.notPlannable.map((n) =>
            style.yellow(`not plannable: ${n.op} ${n.action} — ${n.reason} (${n.code})`),
          ),
          '',
          style.dim(
            `${r.meta.operations} operations · ${r.meta.matched} matched a rule · ${r.meta.compliant} already compliant · ${r.meta.steps} to change`,
          ),
          r.meta.plan
            ? `${style.green('✓')} wrote ${r.meta.plan}; ${PLAN_NEXT_STEP(r.meta.plan)}`
            : r.steps.length
              ? style.dim('add --plan rules.plan.json to save these steps')
              : '',
        ]
          .filter((l) => l !== '')
          .join('\n'),
      );
    },
  );

  withExamples(
    addRangeOptions(
      rulesCmd
        .command('init')
        .description('Write a starter rules file inferred from your validated history')
        .option('-o, --output <file>', 'Where to write the rules', DEFAULT_RULES_FILE)
        .option('--min-count <n>', 'Minimum operations per merchant', parsePositiveInt, 2)
        .option('--force', 'Overwrite an existing file'),
      ' (default: last 12 months)',
    ),
    'rules init',
    'rules init --from 2025-01-01 --min-count 3 -o team.rules.json',
  ).action(
    async (
      o: { from?: string; to?: string; output: string; minCount: number; force?: boolean },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      if (existsSync(o.output) && !o.force)
        throw usageError(`${o.output} already exists`, 're-run with --force to overwrite');
      const range = rangeOf({ from: o.from ?? addDays(today(), -365), to: o.to });
      const records = await fetchOperations(ctx, { ...range, status: 'validated' });
      const inferred = inferRules(
        records.map((r) => r.op),
        { minCount: o.minCount },
      );
      const file = {
        $comment: `Generated by compta-cli ${VERSION} rules init from ${records.length} validated operations. Review before use; first matching rule wins.`,
        rules: inferred.map(({ stats: _stats, ...rule }) => rule),
        vendors: [],
        noReceiptCategories: [],
      };
      await writeFile(o.output, `${JSON.stringify(file, null, 2)}\n`);
      ctx.out.result(
        { file: o.output, rules: inferred.length, operations: records.length, inferred },
        (r) =>
          [
            r.inferred.length
              ? renderTable(
                  [
                    {
                      header: 'MATCH',
                      value: (x: (typeof inferred)[number]) => String(x.match.wording),
                    },
                    { header: 'SET', value: (x) => setSummary(x.set) },
                    { header: 'OPS', value: (x) => String(x.stats.operations), align: 'right' },
                    {
                      header: 'AGREE',
                      value: (x) => `${Math.round(x.stats.agreement * 100)}%`,
                      align: 'right',
                    },
                    { header: 'NAME', value: (x) => x.name ?? '', flex: true },
                  ],
                  r.inferred,
                )
              : style.yellow('No merchant appears often enough with a consistent category.'),
            '',
            `${style.green('✓')} wrote ${plural(r.rules, 'rule')} to ${r.file}; review it, then: compta rules apply --plan rules.plan.json`,
          ].join('\n'),
      );
    },
  );

  // ── close-check ─────────────────────────────────────────────────────
  withExamples(
    addDocumentsOption(
      program
        .command('close-check')
        .description('Pre-closing report for an accounting year (exit code 0 even with findings)')
        .requiredOption(
          '--year <YYYY>',
          'Accounting year (the Compta fiscal year ending that year, else the calendar year)',
          parsePositiveInt,
        )
        .option(
          '--strict',
          'Also ask for receipts on transfers between accounts, capital, loans, subsidies, FX and tax settlements',
        )
        .addOption(rulesOption()),
    ),
    'close-check --year 2025',
    'close-check --year 2026 --no-documents --json | jq .meta',
  ).action(
    async (
      o: { year: number; documents: boolean; rules?: string; strict?: boolean },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      const compta = await ctx.compta();
      const years = await compta.fiscalYears().catch(() => []);
      const fiscal = years.find((y) => y.end_date.startsWith(String(o.year)));
      const from = fiscal?.start_date.slice(0, 10) ?? `${o.year}-01-01`;
      const to = fiscal?.end_date.slice(0, 10) ?? `${o.year}-12-31`;
      ctx.out.info(
        style.dim(
          `Accounting period ${from} → ${to}${fiscal ? ' (Compta fiscal year)' : ' (calendar year)'}`,
        ),
      );
      const { rules } = await loadRules(o.rules);
      const [records, categories, declarations] = await Promise.all([
        fetchOperations(ctx, { from, to }),
        categoriesOrNull(ctx, compta),
        declarationsOrEmpty(ctx, compta),
      ]);
      const report = await runCloseCheck(compta, records, {
        year: o.year,
        from,
        to,
        rules,
        categories,
        declarations,
        documents: o.documents,
        strict: o.strict,
        onProgress: progress(ctx, 'documents'),
      });
      ctx.out.result(report, (r) =>
        [
          renderFindings(r.findings, (code) => REASON_TITLES[code] ?? code),
          '',
          style.dim(
            `${r.meta.from} → ${r.meta.to}: ${plural(r.meta.operations, 'operation')}, ${r.meta.bySeverity.error} errors, ${r.meta.bySeverity.warning} warnings, ${r.meta.bySeverity.info} info`,
          ),
        ].join('\n'),
      );
    },
  );
}
