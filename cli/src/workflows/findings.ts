import { z } from 'zod';
import { returnType, type VatReturnSummary } from '../api/compta.js';
import { type Category, type Operation, operationSchema } from '../api/schemas.js';
import {
  attachStepSchema,
  detachStepSchema,
  type StepDraft,
  setStepSchema,
  validateStepSchema,
} from '../plan/types.js';

export const SEVERITIES = ['error', 'warning', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_CODES = [
  'MISSING_RECEIPT',
  'UNCATEGORIZED',
  'UNVALIDATED',
  'VAT_SUSPECT',
  'RULE_MATCH',
  'POSSIBLE_DUPLICATE',
  'DOCUMENT_AMOUNT_MISMATCH',
  'OVERDUE_DECLARATION',
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

/** Sub-codes of VAT_SUSPECT, also used by `vat check`. */
export const VAT_RULES = [
  'VAT_TOTAL_MISMATCH',
  'VAT_RATE_INVALID',
  'REVERSE_CHARGE_SUSPECT',
  'ZERO_VAT_NO_REASON',
  'DOCUMENT_VAT_MISMATCH',
] as const;
export type VatRule = (typeof VAT_RULES)[number];

const draftSchema = z
  .union([
    setStepSchema.omit({ id: true }),
    attachStepSchema.omit({ id: true }),
    detachStepSchema.omit({ id: true }),
    validateStepSchema.omit({ id: true }),
  ])
  .describe('A plan step without its id');

export const findingSchema = z.object({
  code: z.enum([...FINDING_CODES, ...VAT_RULES]),
  severity: z.enum(SEVERITIES),
  detail: z.string(),
  op: operationSchema.nullable().describe('null for findings about a declaration'),
  declaration: z.lazy(() => declarationRefSchema).optional(),
  evidence: z.record(z.string(), z.unknown()).optional(),
  fix: draftSchema.optional().describe('Suggested plan step, when the fix is unambiguous'),
  related: z.array(z.string()).optional().describe('Other operation ids involved (duplicates)'),
});
export type Finding = Omit<z.infer<typeof findingSchema>, 'code' | 'fix'> & {
  code: FindingCode | VatRule;
  fix?: StepDraft;
};

export const declarationRefSchema = z
  .object({
    id: z.string(),
    type: z.string().describe('e.g. CA3-2026 (monthly VAT return)'),
    label: z.string().nullable(),
    periodStart: z.string(),
    periodEnd: z.string(),
    dueDate: z.string().nullable(),
    isLate: z.boolean(),
    status: z.enum(['completed', 'ready_to_complete', 'upcoming']),
  })
  .describe('A Compta declaration (tax return)');
export type DeclarationRef = z.infer<typeof declarationRefSchema>;

export function declarationRef(d: VatReturnSummary): DeclarationRef {
  return {
    id: String(d.id),
    type: returnType(d),
    label: d.title ?? null,
    periodStart: d.period_start.slice(0, 10),
    periodEnd: d.period_end.slice(0, 10),
    dueDate: d.due_date ? d.due_date.slice(0, 10) : null,
    isLate: !!d.overdue,
    status: d.status,
  };
}

/** Declarations Compta marks as overdue and that are not filed yet. */
export function overdueDeclarations(declarations: readonly VatReturnSummary[]): Finding[] {
  return declarations
    .filter((d) => d.status !== 'completed' && d.overdue)
    .sort((a, b) => a.period_start.localeCompare(b.period_start))
    .map((d) => {
      const ref = declarationRef(d);
      return {
        code: 'OVERDUE_DECLARATION' as const,
        severity: 'error' as const,
        detail: `${ref.label ?? ref.type}: not filed, overdue since ${ref.dueDate ?? 'its due date'}`,
        op: null,
        declaration: ref,
      };
    });
}

/** Receipts above this gross amount must be a full invoice, not a till receipt. */
export const INVOICE_THRESHOLD = 150;

/** Compta category names that never need a justifying document. */
const NO_RECEIPT_CATEGORY_NAMES = new Set(
  [
    'Virement compte à compte',
    'Capital souscrit',
    "Apport d'argent personnel",
    'Gains de change',
    'Pertes de change',
    'Commissions Paypal',
    'Commissions e-commerce',
    'Encaissement e-commerce',
    'Banque',
  ].map((n) => n.toLowerCase()),
);

export interface ReceiptPolicy {
  /** Categories the user's rules file exempts (always honoured). */
  noReceiptCategories: ReadonlySet<number>;
  /** Category metadata: movements booked to transfer/capital/loan/… accounts need no receipt. */
  categories?: CategoryIndex;
  /** Ask for a receipt on everything except the rules file's exemptions. */
  strict?: boolean;
}

function needsReceipt(op: Operation, policy: ReceiptPolicy): boolean {
  if (op.direction !== 'expense' || op.amount < 1) return false;
  if (op.type?.startsWith('dispatch')) return false;
  const exempt = (b: Operation['breakdowns'][number]) => {
    if (!b.category) return false;
    if (policy.noReceiptCategories.has(b.category.id)) return true;
    if (policy.strict) return false;
    const meta = policy.categories?.get(b.category.id);
    return (
      meta?.needsDocument === false || NO_RECEIPT_CATEGORY_NAMES.has(b.category.name.toLowerCase())
    );
  };
  return !op.breakdowns.filter((b) => !b.isCounterpart).every(exempt);
}

export function missingReceipt(op: Operation, policy: ReceiptPolicy): Finding | null {
  if (op.attachments.length > 0 || !needsReceipt(op, policy)) return null;
  const invoice = op.amount > INVOICE_THRESHOLD;
  return {
    code: 'MISSING_RECEIPT',
    severity: invoice ? 'error' : 'warning',
    detail: invoice
      ? `no document; ${op.amount.toFixed(2)} € > ${INVOICE_THRESHOLD} € needs a full invoice`
      : `no document for a ${op.amount.toFixed(2)} € expense`,
    op,
    evidence: { invoiceRequired: invoice },
  };
}

export function uncategorized(op: Operation): Finding | null {
  const count = op.breakdowns.filter((b) => !b.isCounterpart && !b.category).length;
  if (!count) return null;
  return {
    code: 'UNCATEGORIZED',
    severity: 'warning',
    detail: 'no category (category -1)',
    op,
  };
}

export function unvalidated(op: Operation): Finding | null {
  return op.validated
    ? null
    : { code: 'UNVALIDATED', severity: 'info', detail: 'not yet validated in Compta', op };
}

export type CategoryIndex = ReadonlyMap<number, Category>;
