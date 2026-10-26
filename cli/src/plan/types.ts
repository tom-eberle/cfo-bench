import { z } from 'zod';
import { vatExemptKindSchema } from '../api/schemas.js';
import { FRENCH_VAT_RATES } from '../util/money.js';

/*
 * Plans are the contract between an agent that proposes changes and a human
 * (or agent) that approves them. Plain JSON, safe to edit by hand.
 */

export const setChangesSchema = z
  .strictObject({
    category: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Compta category id (see: compta categories list)'),
    vatRate: z
      .number()
      .refine((r) => (FRENCH_VAT_RATES as readonly number[]).includes(r), {
        message: `vatRate must be one of ${FRENCH_VAT_RATES.join(', ')}`,
      })
      .optional()
      .describe('Percent; sets the VAT amount from the gross amount and clears any exemption'),
    vatExempt: vatExemptKindSchema
      .optional()
      .describe(
        'Zero the VAT and record why: supplier outside the EU, inside the EU, or no document',
      ),
    memo: z.string().max(2000).nullable().optional(),
  })
  .refine(
    (s) => Object.keys(s).length > 0,
    'set needs at least one of category, vatRate, vatExempt, memo',
  )
  .refine(
    (s) => s.vatRate === undefined || s.vatExempt === undefined,
    'vatRate and vatExempt are mutually exclusive',
  );
export type SetChanges = z.infer<typeof setChangesSchema>;

export const expectSchema = z
  .strictObject({
    category: z.number().int().optional().describe('-1 means uncategorized'),
    vatRate: z.number().nullable().optional(),
    vatAmount: z.number().nullable().optional(),
    vatExemptReason: z.string().nullable().optional(),
    memo: z.string().nullable().optional(),
    validated: z.boolean().optional(),
    attachments: z.number().int().optional().describe('Number of attachments'),
  })
  .describe(
    'State observed when the plan was made; if it changed, apply reports the step as a conflict (exit 7) unless --force. `validated` is recorded to restore it after a reopen, not to detect drift.',
  );
export type Expectation = z.infer<typeof expectSchema>;

const stepBase = {
  id: z.string().min(1),
  op: z.string().regex(/^\d+$/, 'op must be a numeric operation id'),
  why: z.string().min(1).describe('Human-readable justification, shown on review'),
  expect: expectSchema.optional(),
};

export const setStepSchema = z.strictObject({
  ...stepBase,
  action: z.literal('set'),
  set: setChangesSchema,
  breakdown: z.string().optional().describe('Breakdown id; only needed for split operations'),
});

export const attachStepSchema = z.strictObject({
  ...stepBase,
  action: z.literal('attach'),
  file: z.string().min(1).describe('Path, relative to the plan file'),
  name: z
    .string()
    .optional()
    .describe('Display name in Compta (default: file name without a leading "<digits>_")'),
});

export const detachStepSchema = z.strictObject({
  ...stepBase,
  action: z.literal('detach'),
  attachmentId: z.string().regex(/^\d+$/),
});

export const validateStepSchema = z.strictObject({ ...stepBase, action: z.literal('validate') });

export const planStepSchema = z.discriminatedUnion('action', [
  setStepSchema,
  attachStepSchema,
  detachStepSchema,
  validateStepSchema,
]);
export type PlanStep = z.infer<typeof planStepSchema>;
export type SetStep = z.infer<typeof setStepSchema>;

export const planSchema = z
  .strictObject({
    version: z.literal(1),
    company: z.string().regex(/^\d+$/),
    createdAt: z.string(),
    createdBy: z.string(),
    steps: z.array(planStepSchema),
  })
  .refine(
    (p) => new Set(p.steps.map((s) => s.id)).size === p.steps.length,
    'step ids must be unique',
  )
  .describe('A reviewable list of changes, executed by: compta apply <plan.json>');
export type Plan = z.infer<typeof planSchema>;

/** A step without its id; ids are assigned when the plan is assembled. */
export type StepDraft = PlanStep extends infer S
  ? S extends PlanStep
    ? Omit<S, 'id'>
    : never
  : never;

export const changeSchema = z.object({
  field: z.string(),
  from: z.unknown(),
  to: z.unknown(),
});
export type Change = z.infer<typeof changeSchema>;

export const STEP_STATUSES = [
  'applied',
  'planned',
  'skipped',
  'conflict',
  'failed',
  'pending',
] as const;

export const stepResultSchema = z.object({
  step: z.string(),
  op: z.string(),
  action: z.enum(['set', 'attach', 'detach', 'validate']),
  status: z.enum(STEP_STATUSES),
  reason: z.string().optional(),
  why: z.string(),
  file: z
    .string()
    .optional()
    .describe('Attach steps: the resolved absolute path that is (or would be) uploaded'),
  operation: z
    .object({
      date: z.string(),
      wording: z.string(),
      amount: z.number(),
      direction: z.enum(['expense', 'income']),
    })
    .optional(),
  changes: z.array(changeSchema),
  sideEffects: z
    .array(changeSchema)
    .optional()
    .describe(
      'Changes Compta made that the step did not ask for (seen when re-reading after the write)',
    ),
  error: z
    .object({ code: z.string(), message: z.string(), hint: z.string().optional() })
    .optional(),
});
export type StepResult = z.infer<typeof stepResultSchema>;

export const applyReportSchema = z
  .object({
    meta: z.object({
      company: z.string(),
      createdBy: z.string(),
      dryRun: z.boolean(),
      total: z.number(),
      applied: z.number(),
      planned: z.number(),
      skipped: z.number(),
      conflicts: z
        .number()
        .describe('Steps not applied because the operation changed since planning'),
      failed: z.number(),
      sideEffects: z.number().describe('Applied steps where Compta also changed something else'),
      pending: z.number(),
      startedAt: z.string(),
      finishedAt: z.string(),
    }),
    results: z.array(stepResultSchema),
  })
  .describe('Result of compta apply; usable as an audit log');
export type ApplyReport = z.infer<typeof applyReportSchema>;

export function buildPlan(
  company: string,
  createdBy: string,
  drafts: StepDraft[],
  now = new Date(),
): Plan {
  return {
    version: 1,
    company,
    createdAt: now.toISOString(),
    createdBy,
    steps: drafts.map((d, i) => ({ id: `s${i + 1}`, ...d }) as PlanStep),
  };
}
