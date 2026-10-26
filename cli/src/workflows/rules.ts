import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { OperationRecord } from '../api/compta.js';
import { type Operation, vatExemptKindSchema } from '../api/schemas.js';
import { ComptaError, ExitCode } from '../output/errors.js';
import { observe, setFieldSatisfied } from '../plan/diff.js';
import type { SetChanges, StepDraft } from '../plan/types.js';
import { setChangesSchema } from '../plan/types.js';
import { includesLoose, merchantKey, parseRegexLiteral } from '../util/text.js';
import { vendorSchema } from './vendors.js';

export const DEFAULT_RULES_FILE = 'compta.rules.json';

const wordingMatcher = z
  .string()
  .min(1)
  .refine((v) => {
    try {
      parseRegexLiteral(v);
      return true;
    } catch {
      return false;
    }
  }, 'invalid /regex/')
  .describe('Case/accent-insensitive substring, or /regex/flags tested against the raw wording');

export const ruleSchema = z.strictObject({
  name: z.string().optional(),
  match: z
    .strictObject({
      wording: wordingMatcher.optional(),
      direction: z.enum(['expense', 'income']).optional(),
      amountMin: z.number().nonnegative().optional(),
      amountMax: z.number().nonnegative().optional(),
      account: z.string().optional().describe('Bank account id, or a substring of its name'),
    })
    .refine((m) => Object.keys(m).length > 0, 'match needs at least one condition'),
  set: setChangesSchema,
});
export type Rule = z.infer<typeof ruleSchema>;

export const rulesFileSchema = z
  .strictObject({
    $schema: z.string().optional(),
    $comment: z.string().optional(),
    rules: z.array(ruleSchema).default([]),
    vendors: z
      .array(vendorSchema)
      .default([])
      .describe('Extra or overriding supplier establishments'),
    noReceiptCategories: z
      .array(z.number().int())
      .default([])
      .describe(
        'Category ids that never need a justifying document (internal transfers, capital…)',
      ),
  })
  .describe('Local categorisation rules (compta.rules.json). First matching rule wins.');
export type RulesFile = z.infer<typeof rulesFileSchema>;

export const EMPTY_RULES: RulesFile = { rules: [], vendors: [], noReceiptCategories: [] };

/**
 * Load a rules file. An explicit path must exist; otherwise ./compta.rules.json
 * is used when present, and an empty rule set when not.
 */
export async function loadRules(path?: string): Promise<{ rules: RulesFile; path: string | null }> {
  const file = path ?? (existsSync(DEFAULT_RULES_FILE) ? DEFAULT_RULES_FILE : null);
  if (!file) return { rules: EMPTY_RULES, path: null };
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    throw new ComptaError(
      'RULES_INVALID',
      missing ? `Rules file not found: ${file}` : `Rules file is not valid JSON: ${file}`,
      {
        exitCode: ExitCode.usage,
        hint: missing ? 'create one with: compta rules init' : undefined,
      },
    );
  }
  const parsed = rulesFileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ComptaError(
      'RULES_INVALID',
      `${file}: ${issue?.path.join('.') || 'root'}: ${issue?.message}`,
      {
        exitCode: ExitCode.usage,
        hint: 'see: compta schema rules',
      },
    );
  }
  return { rules: parsed.data, path: file };
}

export function ruleMatches(rule: Rule, op: Operation): boolean {
  const m = rule.match;
  if (m.direction && op.direction !== m.direction) return false;
  if (m.amountMin !== undefined && op.amount < m.amountMin) return false;
  if (m.amountMax !== undefined && op.amount > m.amountMax) return false;
  if (
    m.account &&
    op.account?.id !== m.account &&
    !includesLoose(op.account?.name ?? '', m.account)
  )
    return false;
  if (m.wording) {
    const regex = parseRegexLiteral(m.wording);
    if (regex ? !regex.test(op.wording) : !includesLoose(op.wording, m.wording)) return false;
  }
  return true;
}

export function describeRule(rule: Rule, index: number): string {
  const label = rule.name ? `rule "${rule.name}"` : `rule #${index + 1}`;
  const parts = Object.entries(rule.match).map(([k, v]) => `${k} ${JSON.stringify(v)}`);
  return `${label} (${parts.join(', ')})`;
}

export interface RuleOutcome {
  rule: Rule;
  index: number;
  /** Only the fields that would actually change; empty when already compliant. */
  changes: SetChanges | null;
  blocked?: string;
}

/** First matching rule and the subset of its changes the op still needs. */
export function evaluateRules(rules: RulesFile, op: Operation): RuleOutcome | null {
  const index = rules.rules.findIndex((r) => ruleMatches(r, op));
  if (index < 0) return null;
  const rule = rules.rules[index]!;
  const mains = op.breakdowns.filter((b) => !b.isCounterpart);
  if (mains.length !== 1)
    return { rule, index, changes: null, blocked: 'split operation; edit it manually' };
  const b = mains[0]!;
  const pending = Object.fromEntries(
    Object.entries(rule.set).filter(
      ([field, value]) => !setFieldSatisfied(op, b, field as keyof SetChanges, value),
    ),
  ) as SetChanges;
  if (Object.keys(pending).length === 0) return { rule, index, changes: null };
  if (pending.vatExempt && !b.category && pending.category === undefined)
    return {
      rule,
      index,
      changes: null,
      blocked: 'uncategorized; add "category" to the rule to allow the VAT exemption',
    };
  return { rule, index, changes: pending };
}

export function ruleStep(op: Operation, outcome: RuleOutcome): StepDraft | null {
  if (!outcome.changes) return null;
  return {
    op: op.id,
    action: 'set',
    set: outcome.changes,
    expect: observe(op),
    why: `${describeRule(outcome.rule, outcome.index)} matches "${op.wording}"`,
  };
}

export interface RulesApplyResult {
  steps: StepDraft[];
  matched: number;
  compliant: number;
  blocked: { op: string; wording: string; reason: string }[];
}

export function planRules(rules: RulesFile, records: readonly OperationRecord[]): RulesApplyResult {
  const result: RulesApplyResult = { steps: [], matched: 0, compliant: 0, blocked: [] };
  for (const { op } of records) {
    const outcome = evaluateRules(rules, op);
    if (!outcome) continue;
    result.matched++;
    if (outcome.blocked)
      result.blocked.push({ op: op.id, wording: op.wording, reason: outcome.blocked });
    const step = ruleStep(op, outcome);
    if (step) result.steps.push(step);
    else if (!outcome.blocked) result.compliant++;
  }
  return result;
}

export interface InferredRule extends Rule {
  /** Evidence, stripped before writing if the caller prefers a clean file. */
  stats: { operations: number; agreement: number };
}

/**
 * Infer a starter rule set from history: for each normalized merchant, the
 * dominant category and VAT exemption across validated operations.
 */
export function inferRules(
  ops: readonly Operation[],
  options: { minCount?: number; minAgreement?: number } = {},
): InferredRule[] {
  const minCount = options.minCount ?? 2;
  const minAgreement = options.minAgreement ?? 0.8;
  const groups = new Map<string, Operation[]>();
  for (const op of ops) {
    const key = merchantKey(op.wording);
    if (key.length < 3 || !op.category) continue;
    if (op.breakdowns.filter((b) => !b.isCounterpart).length !== 1) continue;
    groups.set(key, [...(groups.get(key) ?? []), op]);
  }
  const rules: InferredRule[] = [];
  for (const [key, group] of groups) {
    if (group.length < minCount) continue;
    const [category, categoryCount] = mode(group.map((o) => o.category!.id));
    const agreement = categoryCount / group.length;
    if (agreement < minAgreement) continue;
    const set: SetChanges = { category };
    const exemptions = group.map((o) => o.vatExemptReason ?? 'none');
    const [exempt, exemptCount] = mode(exemptions);
    if (exemptCount / group.length >= minAgreement && vatExemptKindSchema.safeParse(exempt).success)
      set.vatExempt = exempt as SetChanges['vatExempt'];
    const directions = new Set(group.map((o) => o.direction));
    const name = group[0]!.category!.name;
    rules.push({
      name: `${key} → ${name}`,
      match: { wording: key, ...(directions.size === 1 ? { direction: group[0]!.direction } : {}) },
      set,
      stats: { operations: group.length, agreement: Math.round(agreement * 100) / 100 },
    });
  }
  return rules.sort((a, b) => b.stats.operations - a.stats.operations);
}

function mode<T>(values: readonly T[]): [T, number] {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] as [T, number];
}
