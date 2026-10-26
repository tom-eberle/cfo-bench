import { writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { type Command, InvalidArgumentError, Option } from 'commander';
import { ComptaError, ExitCode } from '../output/errors.js';
import type { Plan } from '../plan/types.js';
import { checkRange, type DateRange, isIsoDate } from '../util/dates.js';

const EXAMPLES = new WeakMap<Command, string[]>();

/** Append an "Examples:" section to --help. Every command has 1–3 real examples. */
export function withExamples(command: Command, ...examples: string[]): Command {
  EXAMPLES.set(command, examples);
  command.addHelpText(
    'after',
    `\nExamples:\n${examples.map((e) => `  $ compta ${e}`).join('\n')}\n`,
  );
  return command;
}

export function examplesOf(command: Command): string[] {
  return EXAMPLES.get(command) ?? [];
}

export function parseInteger(value: string): number {
  if (!/^-?\d+$/.test(value)) throw new InvalidArgumentError('expected an integer');
  return Number(value);
}

export function parsePositiveInt(value: string): number {
  const n = parseInteger(value);
  if (n < 1) throw new InvalidArgumentError('expected a positive integer');
  return n;
}

export function parseNumber(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n))
    throw new InvalidArgumentError('expected a number');
  return n;
}

export function parseDate(value: string): string {
  if (!isIsoDate(value)) throw new InvalidArgumentError('expected a date as YYYY-MM-DD');
  return value;
}

export function addRangeOptions(command: Command, defaults = ''): Command {
  return command
    .option(
      '--from <date>',
      `Only operations on or after this date (YYYY-MM-DD)${defaults}`,
      parseDate,
    )
    .option('--to <date>', 'Only operations on or before this date (YYYY-MM-DD)', parseDate);
}

export function rangeOf(options: { from?: string; to?: string }): DateRange {
  return checkRange({ from: options.from, to: options.to });
}

export function addMutationOptions(command: Command): Command {
  return command
    .option('--dry-run', 'Show what would change without writing anything')
    .option('-y, --yes', 'Apply without asking for confirmation (required when not in a terminal)');
}

export function addPlanOption(command: Command): Command {
  return command.option(
    '--plan <file>',
    'Write proposed fixes to a plan file for review, then run: compta apply <file>',
  );
}

export function addDocumentsOption(command: Command): Command {
  return command.option('--no-documents', 'Skip reading attached invoices (faster, fewer checks)');
}

export function rulesOption(): Option {
  return new Option('--rules <file>', 'Rules file (default: ./compta.rules.json when present)');
}

/**
 * Write a plan file. Attach paths are stored relative to the plan's directory,
 * so the plan and its documents can be moved or committed together.
 */
export async function writePlan(path: string, plan: Plan): Promise<string> {
  const target = resolve(path);
  const base = dirname(target);
  const portable: Plan = {
    ...plan,
    steps: plan.steps.map((s) => {
      if (s.action !== 'attach') return s;
      const rel = relative(base, isAbsolute(s.file) ? s.file : resolve(s.file));
      return { ...s, file: rel.startsWith('..') || isAbsolute(rel) ? resolve(s.file) : `./${rel}` };
    }),
  };
  try {
    await writeFile(target, `${JSON.stringify(portable, null, 2)}\n`, { mode: 0o600 });
  } catch (cause) {
    throw new ComptaError('WRITE_FAILED', `Could not write plan to ${path}`, {
      exitCode: ExitCode.usage,
      cause,
    });
  }
  return target;
}

export const PLAN_NEXT_STEP = (path: string) => `review it, then run: compta apply ${path}`;
