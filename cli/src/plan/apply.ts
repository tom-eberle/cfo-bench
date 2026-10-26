import type { Compta, PeriodGuard } from '../api/compta.js';
import { categoryIds, uploadName } from '../api/compta.js';
import { exemptionValue, isSaleLine, lineInbound, percentToRate } from '../api/normalize.js';
import type {
  Operation,
  RawCategory,
  RawLine,
  RawTransaction,
  VatExemptKind,
} from '../api/schemas.js';
import { ComptaError, ExitCode, errorPayload, toComptaError } from '../output/errors.js';
import { vatFromGross } from '../util/money.js';
import { readUpload, resolveUpload } from './attachments.js';
import {
  describeChanges,
  driftedFields,
  expectedKeys,
  isSatisfied,
  snapshot,
  snapshotDiff,
  targetBreakdown,
} from './diff.js';
import type {
  ApplyReport,
  Change,
  Plan,
  PlanStep,
  SetChanges,
  SetStep,
  StepResult,
} from './types.js';

export interface ApplyOptions {
  dryRun?: boolean;
  force?: boolean;
  continueOnError?: boolean;
  /** Directory relative attach paths are resolved against (the plan file's). */
  baseDir?: string;
  /** Allow attach steps to upload files outside the plan directory and cwd. */
  allowAnyPath?: boolean;
  /** Filed VAT periods / closed years; set, validate and detach steps there are refused. */
  periods?: PeriodGuard;
  allowFiledPeriods?: boolean;
  /** Categories by id, for the validation rules they carry (default: the company's). */
  categories?: ReadonlyMap<number, RawCategory>;
  onResult?: (result: StepResult) => void;
}

/** A step failure that may have left changes behind (reported in the audit log). */
export class StepError extends ComptaError {
  constructor(
    base: ComptaError,
    readonly changes: Change[],
  ) {
    super(base.code, base.message, {
      exitCode: base.exitCode,
      hint: base.hint,
      status: base.status,
    });
  }
}

function rawLine(raw: RawTransaction, id: string): RawLine {
  const b = raw.lines.find((x) => String(x.id) === id);
  if (!b)
    throw new ComptaError('NOT_FOUND', `Breakdown ${id} disappeared from operation ${raw.id}`, {
      exitCode: ExitCode.notFound,
    });
  return b;
}

/** Send the full list of lines with one line replaced (the API replaces them all). */
function updateLine(compta: Compta, raw: RawTransaction, line: RawLine): Promise<RawTransaction> {
  return compta.updateTransaction(String(raw.id), {
    lines: raw.lines.map((b) => (String(b.id) === String(line.id) ? line : b)),
  });
}

/** Move the line to a category; Compta then applies the category's default VAT. */
async function setCategory(
  compta: Compta,
  raw: RawTransaction,
  id: string,
  category: number,
): Promise<RawTransaction> {
  const b = rawLine(raw, id);
  if (b.category_id === category) return raw;
  return updateLine(compta, raw, { ...b, category_id: category });
}

function exemptionUnavailable(opId: RawTransaction['id']): ComptaError {
  return new ComptaError(
    'EXEMPTION_UNAVAILABLE',
    `Compta offers no VAT exemption for operation ${opId} in its current category`,
    {
      exitCode: ExitCode.rejected,
      hint: 'set a purchase category that carries VAT (e.g. software, advertising) first',
    },
  );
}

/**
 * Record a VAT exemption in one update: the reason with no rate and no VAT, together
 * with the step's category when it moves the line. Compta checks the result as a
 * whole, so nothing is saved when the exemption is refused.
 *
 * A move re-applies the new category's default VAT unless the line's tax is
 * overridden or exempt, so whether VAT applies is judged on the line as it would be
 * after the move. Removing VAT marks the tax overridden (set by hand).
 */
async function setExemption(
  compta: Compta,
  raw: RawTransaction,
  id: string,
  kind: VatExemptKind,
  category: number | undefined,
): Promise<RawTransaction> {
  const b = rawLine(raw, id);
  const tax = b.tax;
  const moved = category !== undefined && b.category_id !== category;
  const categoryId = moved ? category : b.category_id;
  const target =
    categoryId == null ? undefined : (await compta.categoryMap([categoryId])).get(categoryId);
  const keepsTax = !moved || tax.overridden || tax.treatment === 'exempt';
  const inVat = keepsTax ? tax.treatment !== 'out_of_scope' : !!target?.default_vat;
  if (categoryId == null || !inVat || target?.exemptions === 'unavailable')
    throw exemptionUnavailable(raw.id);
  const inbound = lineInbound(b, raw);
  const sale = (b.refund ?? false) ? !inbound : inbound;
  const reason = exemptionValue(kind, sale);
  if (!reason)
    throw new ComptaError(
      'SALES_EXEMPTION_UNSUPPORTED',
      `Operation ${raw.id}: "${kind}" only exists for purchases`,
      {
        exitCode: ExitCode.usage,
      },
    );
  if (!moved && tax.exemption_reason === reason && tax.amount === 0 && tax.rate === null)
    return raw;
  const hadVat = keepsTax
    ? tax.amount !== 0 || tax.rate != null
    : (target?.default_vat?.rate ?? 0) > 0;
  try {
    return await updateLine(compta, raw, {
      ...b,
      category_id: categoryId,
      tax: {
        ...tax,
        treatment: 'exempt',
        rate: null,
        amount: 0,
        exemption_reason: reason,
        overridden: tax.overridden || hadVat,
      },
    });
  } catch (error) {
    const e = toComptaError(error);
    throw e.apiCode === 'EXEMPTION_NOT_ALLOWED' ? exemptionUnavailable(raw.id) : e;
  }
}

/**
 * Set the VAT rate: the full line with the rate and the VAT amount it gives on the
 * gross amount, and no exemption (an exempt line goes back to taxable; a line
 * outside VAT stays so). Compta recomputes the deductible part.
 */
async function setVatRate(
  compta: Compta,
  raw: RawTransaction,
  id: string,
  percent: number,
): Promise<RawTransaction> {
  const b = rawLine(raw, id);
  return updateLine(compta, raw, {
    ...b,
    tax: {
      ...b.tax,
      treatment: b.tax.treatment === 'exempt' ? 'taxable' : b.tax.treatment,
      rate: percent === 0 ? null : percentToRate(percent),
      amount: vatFromGross(b.amount, percent),
      exemption_reason: null,
    },
  });
}

async function applySet(
  compta: Compta,
  raw: RawTransaction,
  op: Operation,
  step: SetStep,
): Promise<void> {
  const id = targetBreakdown(op, step).id;
  const s: SetChanges = step.set;
  let current = raw;
  if (s.vatExempt !== undefined)
    current = await setExemption(compta, current, id, s.vatExempt, s.category);
  else if (s.category !== undefined) current = await setCategory(compta, current, id, s.category);
  if (s.vatRate !== undefined) current = await setVatRate(compta, current, id, s.vatRate);
  if (s.memo !== undefined && (current.note ?? null) !== (s.memo ?? null))
    await compta.updateTransaction(String(current.id), { note: s.memo });
}

/**
 * Un-validate a validated operation so it can be edited. If Compta refuses that
 * too, the operation is read-only.
 */
async function unvalidate(compta: Compta, raw: RawTransaction): Promise<RawTransaction> {
  try {
    return await compta.updateTransaction(String(raw.id), { validated: false });
  } catch (error) {
    const e = toComptaError(error);
    if (e.code !== 'FORBIDDEN') throw e;
    throw new ComptaError(
      'VALIDATED_READONLY',
      `Operation ${raw.id} is validated and Compta refuses to reopen it for editing`,
      {
        exitCode: ExitCode.rejected,
        status: e.status,
        hint: 'reopen it in the Compta web app (validate toggle) or ask your accountant — it may be under review for a declaration',
      },
    );
  }
}

/** Validate again after an edit, unless Compta would now show errors (then it stays open). */
async function validateAgain(compta: Compta, opId: string): Promise<void> {
  const now = await compta.getRaw(opId);
  const problems = validationProblems(now, await compta.categoryMap(categoryIds(now)));
  if (problems.length)
    throw new ComptaError(
      'NOT_REVALIDATED',
      `Edited operation ${opId}, but it cannot be validated again: ${problems.join('; ')}`,
      {
        exitCode: ExitCode.rejected,
        hint: 'fix it, then: compta ops validate <id>',
      },
    );
  await compta.updateTransaction(opId, { validated: true });
}

/** Compta's validation rules (server/API.md §6.5), checked before asking it to validate. */
export function validationProblems(
  raw: RawTransaction,
  categories?: ReadonlyMap<number, RawCategory>,
): string[] {
  const problems: string[] = [];
  if (raw.issues?.length) problems.push(`Compta reports ${raw.issues.length} error(s) on it`);
  const lines = raw.lines;
  if (lines.some((b) => b.category_id == null)) problems.push('a breakdown is uncategorized');
  const signed = (inbound: boolean, amount: number) => (inbound ? amount : -amount);
  const total = lines.reduce((s, b) => s + signed(lineInbound(b, raw), b.amount), 0);
  if (lines.length && Math.abs(total - signed(raw.direction === 'in', raw.amount)) > 0.01)
    problems.push('its breakdowns do not add up to the operation amount');
  for (const b of lines) {
    const category = b.category_id == null ? undefined : categories?.get(b.category_id);
    if (category?.exemptions === 'required' && b.tax.treatment === 'taxable' && b.tax.amount === 0)
      problems.push('zero VAT without the exemption reason Compta requires');
  }
  return problems;
}

/** Refusals that apply in previews, at apply time, and when writing plans. */
function guard(raw: RawTransaction, op: Operation, step: PlanStep, options: ApplyOptions): void {
  // Detaching can remove the only invoice behind VAT already deducted on a filed
  // return, so it is guarded like an edit. Attaching a document stays allowed.
  const writesLedger = step.action !== 'attach';
  if (writesLedger && op.locked)
    throw new ComptaError(
      'LOCKED',
      `Operation ${op.id} is locked in Compta (${raw.lock?.manual ? 'manually' : 'by a closed period'})`,
      {
        exitCode: ExitCode.rejected,
        hint: 'unlock it in the Compta web app (accountant action) if the change is really needed',
      },
    );
  const period = writesLedger ? options.periods?.reason(op.date) : null;
  if (period && !options.allowFiledPeriods)
    throw new ComptaError(
      'FILED_PERIOD',
      `Operation ${op.id} (${op.date}) is in a closed period: ${period}`,
      {
        exitCode: ExitCode.usage,
        hint: 'editing it desynchronizes the books from what was filed; re-run with --allow-filed-periods if you really mean it',
      },
    );
  if (step.action === 'set' && step.set.vatExempt !== undefined) {
    // vatExempt writes a purchase reason; a supplier refund (inbound, isRefund) is still a purchase.
    const b = targetBreakdown(op, step);
    // VAT does not apply to this line (outside VAT): there is no exemption to record.
    if (!b.vatApplicable && step.set.category === undefined)
      throw new ComptaError(
        'EXEMPTION_UNAVAILABLE',
        `Operation ${op.id}: VAT does not apply to this line (e.g. bank fees), so there is no exemption to record`,
        {
          exitCode: ExitCode.rejected,
          hint: 'nothing to fix: zero VAT without a reason is correct here',
        },
      );
    // An exemption needs a category.
    if (!b.category && step.set.category === undefined)
      throw new ComptaError(
        'CATEGORY_REQUIRED',
        `Operation ${raw.id} is uncategorized; Compta needs a category before a VAT exemption`,
        {
          exitCode: ExitCode.usage,
          hint: 'add "category" to the same set step (see: compta categories list)',
        },
      );
    // The line decides purchase (outbound) vs sale (inbound) values; some reasons
    // only exist for purchases.
    if (isSaleLine(b) && !exemptionValue(step.set.vatExempt, true))
      throw new ComptaError(
        'SALES_EXEMPTION_UNSUPPORTED',
        `Operation ${op.id}: "${step.set.vatExempt}" only exists for purchases, and this line is a sale`,
        { exitCode: ExitCode.usage, hint: 'for sales use outside-eu, inside-eu or not-applicable' },
      );
  }
  if (step.action === 'validate' && !op.validated) {
    const problems = validationProblems(raw, options.categories);
    if (problems.length)
      throw new ComptaError(
        'NOT_VALIDATABLE',
        `Operation ${op.id} cannot be validated: ${problems.join('; ')}`,
        {
          exitCode: ExitCode.usage,
          hint: 'fix it first (compta ops get <id>), then validate',
        },
      );
  }
}

function summary(op: Operation): StepResult['operation'] {
  return { date: op.date, wording: op.wording, amount: op.amount, direction: op.direction };
}

/** Execute one step: re-read, check, skip if satisfied or drifted, write, verify. */
export async function executeStep(
  compta: Compta,
  step: PlanStep,
  options: ApplyOptions = {},
): Promise<StepResult> {
  const policy = {
    baseDir: options.baseDir ?? process.cwd(),
    cwd: process.cwd(),
    allowAnyPath: options.allowAnyPath,
  };
  // Validate an upload first, so an unsafe plan fails at preview time.
  const uploadPath = step.action === 'attach' ? resolveUpload(step.file, policy) : undefined;
  const base = {
    step: step.id,
    op: step.op,
    action: step.action,
    why: step.why,
    ...(uploadPath ? { file: uploadPath } : {}),
  };
  const { raw, op } = await compta.getOperation(step.op);
  const checks: ApplyOptions = options.categories
    ? options
    : {
        ...options,
        categories: await compta.categoryMap([
          ...categoryIds(raw),
          ...(step.action === 'set' && step.set.category !== undefined ? [step.set.category] : []),
        ]),
      };
  const result = { ...base, operation: summary(op), changes: describeChanges(op, step) };
  // Compta treats validated operations as read-only (and refuses locked ones):
  // set/detach reopen them, edit, then validate again.
  // An operation validated when the plan was made must end validated, even if an
  // earlier, interrupted run left it open.
  const reopenable = step.action === 'set' || step.action === 'detach';
  const mustEndValidated = reopenable && (op.validated || step.expect?.validated === true);
  const leftOpen = mustEndValidated && !op.validated;
  const revalidated = { field: 'validated', from: false, to: true };
  if (isSatisfied(op, step)) {
    if (!leftOpen)
      return { ...result, changes: [], status: 'skipped', reason: 'already satisfied' };
    guard(raw, op, step, checks);
    const finish = {
      ...result,
      changes: [revalidated],
      reason: 'edit already done; validating the operation again',
    };
    if (options.dryRun) return { ...finish, status: 'planned' };
    await validateAgain(compta, step.op);
    return { ...finish, status: 'applied' };
  }
  guard(raw, op, step, checks);
  const drift = driftedFields(op, step);
  if (drift.length && !options.force)
    return {
      ...result,
      status: 'conflict',
      reason: `operation changed since the plan was made (${drift.join(', ')}); review it or re-run with --force`,
    };
  const reopen = reopenable && op.validated;
  if (reopen)
    result.changes = [
      { field: 'validated', from: true, to: false },
      ...result.changes,
      revalidated,
    ];
  else if (leftOpen) result.changes = [...result.changes, revalidated];
  if (options.dryRun) return { ...result, status: 'planned' };

  const before = snapshot(op);
  try {
    let current = raw;
    if (reopen) current = await unvalidate(compta, raw);
    if (step.action === 'attach') {
      // Read the exact bytes that were checked (no path re-read later: TOCTOU-safe).
      const upload = await readUpload(step.file, policy);
      await compta.attachFiles(step.op, [
        { bytes: upload.bytes, name: step.name ?? uploadName(upload.path) },
      ]);
    } else if (step.action === 'detach') await compta.detachAttachment(step.op, step.attachmentId);
    else if (step.action === 'validate')
      await compta.updateTransaction(step.op, { validated: true });
    else await applySet(compta, current, op, step);
    if (mustEndValidated) await validateAgain(compta, step.op);
  } catch (error) {
    // Report what actually changed, so the audit log never claims "nothing" wrongly.
    let now = await compta.getOperation(step.op).catch(() => null);
    // If only the un-validation stuck, put the validation back (best effort).
    if (reopen && now && !now.op.validated) {
      const only = snapshotDiff(before, snapshot(now.op));
      if (only.length === 1 && only[0]!.field === 'validated') {
        await compta.updateTransaction(step.op, { validated: true }).catch(() => undefined);
        now = await compta.getOperation(step.op).catch(() => now);
      }
    }
    const left = now ? snapshotDiff(before, snapshot(now.op)) : [];
    const e = toComptaError(error);
    if (!left.length && !(leftOpen && now && !now.op.validated)) throw e;
    const open = mustEndValidated && !!now && !now.op.validated;
    throw new StepError(
      new ComptaError(
        'PARTIALLY_APPLIED',
        `${e.message} (some changes were saved${open ? '; the operation was left open' : ''})`,
        {
          exitCode: e.exitCode,
          hint: open
            ? `the operation is open (not validated): run compta ops validate ${step.op} once it looks right (re-running the same plan file also finishes it)`
            : e.hint,
        },
      ),
      left,
    );
  }
  const after = await compta.operationOf(await compta.getRaw(step.op));
  if (!isSatisfied(after, step))
    throw new StepError(
      new ComptaError(
        'VERIFY_FAILED',
        `Compta accepted the change to operation ${step.op}, but re-reading it does not show it`,
        {
          exitCode: ExitCode.rejected,
          hint: 'inspect it with: compta ops get <id>; Compta may process attachments asynchronously',
        },
      ),
      snapshotDiff(before, snapshot(after)),
    );
  const expected = expectedKeys(op, step);
  if (mustEndValidated) expected.add('validated');
  const sideEffects = snapshotDiff(before, snapshot(after), expected);
  return { ...result, status: 'applied', ...(sideEffects.length ? { sideEffects } : {}) };
}

/** Run a plan step by step. Stops at the first failure unless continueOnError. */
export async function applyPlan(
  compta: Compta,
  plan: Plan,
  options: ApplyOptions = {},
): Promise<ApplyReport> {
  if (plan.company !== compta.company)
    throw new ComptaError(
      'COMPANY_MISMATCH',
      `Plan is for company ${plan.company}, but company ${compta.company} is selected`,
      { exitCode: ExitCode.usage, hint: `re-run with --company ${plan.company}` },
    );
  const startedAt = new Date().toISOString();
  const results: StepResult[] = [];
  let stopped = false;
  for (const step of plan.steps) {
    const base = { step: step.id, op: step.op, action: step.action, why: step.why };
    let result: StepResult;
    if (stopped) {
      result = {
        ...base,
        changes: [],
        status: 'pending',
        reason: 'not attempted after an earlier failure',
      };
    } else {
      try {
        result = await executeStep(compta, step, options);
      } catch (error) {
        const { error: e } = errorPayload(error);
        const changes = error instanceof StepError ? error.changes : [];
        result = { ...base, changes, status: 'failed', error: e };
        if (!options.continueOnError) stopped = true;
      }
    }
    results.push(result);
    options.onResult?.(result);
  }
  return reportOf(plan, results, !!options.dryRun, startedAt);
}

export function reportOf(
  plan: Plan,
  results: StepResult[],
  dryRun: boolean,
  startedAt: string,
): ApplyReport {
  const count = (status: StepResult['status']) => results.filter((r) => r.status === status).length;
  return {
    meta: {
      company: plan.company,
      createdBy: plan.createdBy,
      dryRun,
      total: plan.steps.length,
      applied: count('applied'),
      planned: count('planned'),
      skipped: count('skipped'),
      conflicts: count('conflict'),
      failed: count('failed'),
      sideEffects: results.filter((r) => r.sideEffects?.length).length,
      pending: count('pending'),
      startedAt,
      finishedAt: new Date().toISOString(),
    },
    results,
  };
}

/** Steps the period guard applies to; plans without any don't need to load it. */
export function needsPeriodGuard(steps: readonly { action: PlanStep['action'] }[]): boolean {
  return steps.some((s) => s.action !== 'attach');
}

/**
 * Why apply would refuse this step on this operation, predicted with the same
 * checks apply runs (lock, filed period, validation, exemption preconditions,
 * split operations). Null when the step is plannable.
 */
export function whyNotPlannable(
  raw: RawTransaction,
  op: Operation,
  step: PlanStep,
  options: Pick<ApplyOptions, 'periods' | 'allowFiledPeriods' | 'categories'> = {},
): ComptaError | null {
  try {
    guard(raw, op, step, options);
    return null;
  } catch (error) {
    return toComptaError(error);
  }
}
