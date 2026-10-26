import type { Compta, PeriodGuard } from '../api/compta.js';
import { ComptaError, ExitCode } from '../output/errors.js';
import {
  type ApplyOptions,
  applyPlan,
  executeStep,
  needsPeriodGuard,
  reportOf,
} from '../plan/apply.js';
import { type ApplyReport, buildPlan, type StepDraft } from '../plan/types.js';
import { VERSION } from '../version.js';
import type { Context } from './context.js';
import { renderApplyReport } from './render.js';

export interface MutationOptions {
  dryRun?: boolean;
  yes?: boolean;
  force?: boolean;
  allowAnyPath?: boolean;
  allowFiledPeriods?: boolean;
}

/** The confirmation question, listing every local file that would be uploaded. */
export function confirmationQuestion(preview: ApplyReport, company: string): string {
  const uploads = preview.results
    .filter((r) => r.status === 'planned' && r.file)
    .map((r) => r.file!);
  const question = `Apply ${preview.meta.planned} change(s) to company ${company}?`;
  if (!uploads.length) return question;
  return `These local files will be uploaded to Compta:\n${uploads.map((f) => `  ${f}`).join('\n')}\n${question}`;
}

/**
 * Load which periods are closed (filed CA3, closed years). Fails closed: if
 * Compta cannot tell us, refuse rather than risk editing a filed period.
 */
export async function loadPeriodGuard(
  compta: Compta,
  allowFiledPeriods?: boolean,
): Promise<PeriodGuard | undefined> {
  if (allowFiledPeriods) return undefined;
  try {
    return await compta.periodGuard();
  } catch (cause) {
    throw new ComptaError(
      'PERIODS_UNKNOWN',
      'Could not check which periods are already filed or closed',
      {
        exitCode: ExitCode.network,
        hint: 'retry, or pass --allow-filed-periods to skip this check',
        cause,
      },
    );
  }
}

/**
 * Single-command mutations (ops set/attach/detach/validate) run through the
 * same step executor as `apply`: preview, confirm, write, verify. With one
 * step, its error surfaces with its own exit code (usage, auth, rejected…).
 */
export async function runSteps(
  ctx: Context,
  command: string,
  drafts: StepDraft[],
  options: MutationOptions,
): Promise<void> {
  const compta = await ctx.compta();
  const plan = buildPlan(compta.company, `compta-cli ${VERSION} ${command}`, drafts);
  const single = plan.steps.length === 1 ? plan.steps[0]! : null;
  const base: ApplyOptions = {
    force: options.force,
    allowAnyPath: options.allowAnyPath,
    allowFiledPeriods: options.allowFiledPeriods,
    // Attach-only runs are never period-checked, so they don't depend on loading the periods.
    periods: needsPeriodGuard(drafts)
      ? await loadPeriodGuard(compta, options.allowFiledPeriods)
      : undefined,
  };
  const run = async (dryRun: boolean): Promise<ApplyReport> => {
    const startedAt = new Date().toISOString();
    return single
      ? reportOf(plan, [await executeStep(compta, single, { ...base, dryRun })], dryRun, startedAt)
      : applyPlan(compta, plan, { ...base, dryRun, continueOnError: dryRun });
  };

  const preview = await run(true);
  if (options.dryRun || preview.meta.planned === 0) {
    ctx.out.result(preview, renderApplyReport);
    if (preview.meta.failed || preview.meta.conflicts) ctx.exitCode = ExitCode.partial;
    return;
  }
  if (ctx.out.human) ctx.out.humanError(`${renderApplyReport(preview)}\n\n`);
  await ctx.confirm(confirmationQuestion(preview, compta.company), options.yes);
  const report = await run(false);
  ctx.out.result(report, renderApplyReport);
  // Side effects also exit 7: an agent checking only the exit code must notice them.
  if (report.meta.failed || report.meta.pending || report.meta.conflicts || report.meta.sideEffects)
    ctx.exitCode = ExitCode.partial;
}
