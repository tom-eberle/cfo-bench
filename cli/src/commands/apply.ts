import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import { ComptaError, ExitCode } from '../output/errors.js';
import { style } from '../output/style.js';
import { applyPlan, needsPeriodGuard } from '../plan/apply.js';
import { planSchema } from '../plan/types.js';
import { contextOf } from './context.js';
import { confirmationQuestion, loadPeriodGuard } from './mutate.js';
import { renderApplyReport } from './render.js';
import { addMutationOptions, withExamples } from './shared.js';

export async function readPlan(path: string) {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    throw new ComptaError(
      'PLAN_INVALID',
      missing ? `Plan file not found: ${path}` : `Plan file is not valid JSON: ${path}`,
      {
        exitCode: ExitCode.usage,
      },
    );
  }
  const parsed = planSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ComptaError(
      'PLAN_INVALID',
      `${path}: ${issue?.path.join('.') || 'plan'}: ${issue?.message}`,
      {
        exitCode: ExitCode.usage,
        hint: 'see: compta schema plan',
      },
    );
  }
  return parsed.data;
}

export function registerApplyCommand(program: Command): void {
  withExamples(
    addMutationOptions(
      program
        .command('apply <plan>')
        .description(
          'Review and execute a plan: re-reads each operation, skips what is already done, verifies every write',
        )
        .option('--force', 'Apply steps even if the operation changed since the plan was made')
        .option('--continue-on-error', 'Keep going after a failed step')
        .option(
          '--allow-filed-periods',
          'Allow changes to operations in months whose VAT return is filed, or in closed years',
        )
        .option(
          '--allow-any-path',
          'Let attach steps upload files outside the plan directory and the current directory',
        )
        .option('--report <file>', 'Also write the JSON result report (audit log) to this file'),
    ),
    'apply receipts.plan.json --dry-run',
    'apply vat.plan.json --yes --report vat.report.json',
    'apply rules.plan.json --yes --continue-on-error --json',
  ).action(
    async (
      path: string,
      o: {
        dryRun?: boolean;
        yes?: boolean;
        force?: boolean;
        continueOnError?: boolean;
        allowAnyPath?: boolean;
        allowFiledPeriods?: boolean;
        report?: string;
      },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      const plan = await readPlan(path);
      const compta = await ctx.compta();
      const baseDir = dirname(resolve(path));
      const periods = needsPeriodGuard(plan.steps)
        ? await loadPeriodGuard(compta, o.allowFiledPeriods)
        : undefined;
      ctx.out.info(style.dim(`Checking ${plan.steps.length} step(s) against the current state…`));
      const preview = await applyPlan(compta, plan, {
        dryRun: true,
        force: o.force,
        continueOnError: true,
        baseDir,
        allowAnyPath: o.allowAnyPath,
        allowFiledPeriods: o.allowFiledPeriods,
        periods,
      });
      // A plan that tries to upload a disallowed file is refused as a whole.
      const unsafe = preview.results.find((r) => r.error?.code === 'UNSAFE_ATTACHMENT');
      if (unsafe?.error && !o.dryRun)
        throw new ComptaError('UNSAFE_ATTACHMENT', `Step ${unsafe.step}: ${unsafe.error.message}`, {
          exitCode: ExitCode.usage,
          hint: unsafe.error.hint,
        });
      let report = preview;
      if (!o.dryRun && preview.meta.planned > 0) {
        if (ctx.out.human) ctx.out.humanError(`${renderApplyReport(preview)}\n\n`);
        await ctx.confirm(confirmationQuestion(preview, compta.company), o.yes);
        report = await applyPlan(compta, plan, {
          force: o.force,
          continueOnError: o.continueOnError,
          baseDir,
          allowAnyPath: o.allowAnyPath,
          allowFiledPeriods: o.allowFiledPeriods,
          periods,
          onResult: (r) =>
            ctx.out.info(
              style.dim(`  ${r.step} ${r.status}${r.error ? `: ${r.error.message}` : ''}`),
            ),
        });
      }
      if (o.report)
        await writeFile(o.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      ctx.out.result(report, renderApplyReport);
      // Side effects also exit 7: an agent checking only the exit code must notice them.
      if (
        report.meta.failed ||
        report.meta.pending ||
        report.meta.conflicts ||
        report.meta.sideEffects
      )
        ctx.exitCode = ExitCode.partial;
    },
  );
}
