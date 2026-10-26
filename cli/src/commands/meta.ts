import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Argument, Command, Option } from 'commander';
import { z } from 'zod';
import {
  accountSchema,
  attachmentSchema,
  breakdownSchema,
  categorySchema,
  operationSchema,
  rawTransactionSchema,
  whoamiSchema,
} from '../api/schemas.js';
import { ComptaError, ExitCode, usageError } from '../output/errors.js';
import { renderTable } from '../output/table.js';
import { applyReportSchema, planSchema, planStepSchema } from '../plan/types.js';
import { closeCheckSchema } from '../workflows/close-check.js';
import { findingSchema } from '../workflows/findings.js';
import { receiptsReportSchema } from '../workflows/receipts.js';
import { rulesFileSchema } from '../workflows/rules.js';
import { todoItemSchema } from '../workflows/todo.js';
import { vatSummarySchema } from '../workflows/vat.js';
import { contextOf } from './context.js';
import { examplesOf, parseInteger, parseNumber, parsePositiveInt, withExamples } from './shared.js';

const NUMERIC_PARSERS = new Set<(v: string) => number>([
  parseInteger,
  parseNumber,
  parsePositiveInt,
]);

export const errorSchema = z
  .object({
    error: z.object({
      code: z
        .string()
        .describe('Stable machine code, e.g. AUTH_EXPIRED, NOT_FOUND, CONFIRMATION_REQUIRED'),
      message: z.string(),
      hint: z.string().optional().describe('What to do next'),
      status: z.number().optional().describe('HTTP status from Compta, when relevant'),
    }),
  })
  .describe('Written to stderr (one line) in JSON mode when a command fails');

export const vatCheckSchema = z
  .object({
    meta: z.object({
      from: z.string().nullable(),
      to: z.string().nullable(),
      operations: z.number(),
      documentsChecked: z.number(),
      counts: z.record(z.string(), z.number()),
      fixes: z.number(),
      plan: z.string().nullable(),
    }),
    findings: z.array(findingSchema),
  })
  .describe('Result of compta vat check');

/** Input schemas describe files users write; the rest describe command output. */
export const SCHEMAS: Record<string, { schema: z.ZodType; io: 'input' | 'output'; about: string }> =
  {
    operation: { schema: operationSchema, io: 'output', about: 'ops list/get items' },
    breakdown: { schema: breakdownSchema, io: 'output', about: 'operation.breakdowns[]' },
    attachment: { schema: attachmentSchema, io: 'output', about: 'operation.attachments[]' },
    category: { schema: categorySchema, io: 'output', about: 'categories list items' },
    account: { schema: accountSchema, io: 'output', about: 'accounts list items' },
    whoami: { schema: whoamiSchema, io: 'output', about: 'whoami' },
    'todo-item': { schema: todoItemSchema, io: 'output', about: 'todo items' },
    finding: { schema: findingSchema, io: 'output', about: 'vat check / close-check findings[]' },
    'vat-check': { schema: vatCheckSchema, io: 'output', about: 'vat check' },
    'vat-summary': { schema: vatSummarySchema, io: 'output', about: 'vat summary' },
    'receipts-match': { schema: receiptsReportSchema, io: 'output', about: 'receipts match' },
    'close-check': { schema: closeCheckSchema, io: 'output', about: 'close-check' },
    'apply-report': {
      schema: applyReportSchema,
      io: 'output',
      about: 'apply and single-op mutations',
    },
    plan: { schema: planSchema, io: 'input', about: 'plan files (apply input)' },
    'plan-step': { schema: planStepSchema, io: 'input', about: 'plan.steps[]' },
    rules: { schema: rulesFileSchema, io: 'input', about: 'compta.rules.json' },
    error: { schema: errorSchema, io: 'output', about: 'stderr on failure (JSON mode)' },
    'raw-operation': {
      schema: rawTransactionSchema,
      io: 'output',
      about: 'fields the CLI relies on in raw API transactions',
    },
  };

interface FlagInfo {
  flags: string;
  name: string;
  description: string;
  type: 'boolean' | 'string' | 'number' | 'string[]';
  required: boolean;
  default?: unknown;
  choices?: readonly string[];
}

function flagInfo(o: Option): FlagInfo {
  const takesValue = o.required || o.optional;
  const numeric = NUMERIC_PARSERS.has(o.parseArg as unknown as (v: string) => number);
  return {
    flags: o.flags,
    name: o.attributeName(),
    description: o.description,
    type: !takesValue
      ? 'boolean'
      : o.variadic || Array.isArray(o.defaultValue)
        ? 'string[]'
        : numeric
          ? 'number'
          : 'string',
    required: !!o.mandatory,
    ...(o.defaultValue !== undefined && o.defaultValue !== false
      ? { default: o.defaultValue }
      : {}),
    ...(o.argChoices ? { choices: o.argChoices } : {}),
  };
}

function argInfo(a: Argument) {
  return {
    name: a.name(),
    required: a.required,
    variadic: a.variadic,
    description: a.description || undefined,
  };
}

export interface CommandInfo {
  name: string;
  path: string;
  description: string;
  args: ReturnType<typeof argInfo>[];
  flags: FlagInfo[];
  examples: string[];
  subcommands: CommandInfo[];
}

export function describeCommand(c: Command, parentPath = ''): CommandInfo {
  const path = parentPath ? `${parentPath} ${c.name()}` : c.name();
  return {
    name: c.name(),
    path,
    description: c.description(),
    args: c.registeredArguments.map(argInfo),
    flags: c.options.filter((o) => !o.hidden).map(flagInfo),
    examples: examplesOf(c).map((e) => `compta ${e}`),
    subcommands: c.commands.filter((s) => s.name() !== 'help').map((s) => describeCommand(s, path)),
  };
}

function flatten(info: CommandInfo): CommandInfo[] {
  return [info, ...info.subcommands.flatMap(flatten)];
}

/** skills/compta/SKILL.md, found from the built CLI (dist/) or the sources (src/commands/). */
export function skillPath(from = dirname(fileURLToPath(import.meta.url))): string | null {
  for (let dir = from, depth = 0; depth < 4; dir = dirname(dir), depth++) {
    const candidate = join(dir, 'skills', 'compta', 'SKILL.md');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function registerMetaCommands(program: Command): void {
  withExamples(
    program
      .command('skill')
      .description('Print the guide for AI agents: what compta can do and how to use it safely')
      .option('--path', 'Print where the skill file is (to install it as an agent skill)'),
    'skill',
    'skill --path',
  ).action((opts: { path?: boolean }, cmd: Command) => {
    const ctx = contextOf(cmd);
    const path = skillPath();
    if (!path)
      throw new ComptaError('SKILL_MISSING', 'The skill file is missing from this installation', {
        exitCode: ExitCode.unexpected,
        hint: 'reinstall compta-cli',
      });
    if (ctx.options.json)
      return ctx.out.result({ path, markdown: opts.path ? undefined : readFileSync(path, 'utf8') });
    ctx.runtime.stdout.write(opts.path ? `${path}\n` : readFileSync(path, 'utf8'));
  });

  withExamples(
    program
      .command('commands')
      .description('Describe every command, argument and flag (for agents: use --json)'),
    'commands --json',
    'commands --json | jq ".subcommands[].path"',
  ).action((_o: unknown, cmd: Command) => {
    const ctx = contextOf(cmd);
    const tree = describeCommand(program);
    ctx.out.result(tree, (t) =>
      renderTable(
        [
          { header: 'COMMAND', value: (c: CommandInfo) => c.path },
          { header: 'DESCRIPTION', value: (c: CommandInfo) => c.description, flex: true },
        ],
        flatten(t).filter((c) => c.subcommands.length === 0),
      ),
    );
  });

  withExamples(
    program
      .command('schema [type]')
      .description('Print the JSON Schema of an output or input type (omit type to list them)'),
    'schema',
    'schema operation',
    'schema plan > plan.schema.json',
  ).action((type: string | undefined, _o: unknown, cmd: Command) => {
    const ctx = contextOf(cmd);
    if (!type) {
      const list = Object.entries(SCHEMAS).map(([name, s]) => ({
        name,
        kind: s.io,
        describes: s.about,
      }));
      return ctx.out.result(list, (l) =>
        renderTable(
          [
            { header: 'TYPE', value: (r: (typeof l)[number]) => r.name },
            { header: 'KIND', value: (r: (typeof l)[number]) => r.kind },
            { header: 'DESCRIBES', value: (r: (typeof l)[number]) => r.describes, flex: true },
          ],
          l,
        ),
      );
    }
    const entry = SCHEMAS[type];
    if (!entry)
      throw usageError(`Unknown schema "${type}"`, `available: ${Object.keys(SCHEMAS).join(', ')}`);
    const json = z.toJSONSchema(entry.schema, { io: entry.io, unrepresentable: 'any' });
    ctx.out.result(json, (j) => JSON.stringify(j, null, 2));
  });
}
