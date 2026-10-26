import { z } from 'zod';

/*
 * Raw Compta API shapes (loose: unknown fields pass through untouched) and the
 * normalized shapes the CLI prints. Raw schemas list only what we rely on, so
 * `compta doctor` can detect drift early. The API is documented in server/API.md.
 */

const id = z.union([z.number(), z.string()]);
const direction = z.enum(['in', 'out']);

// ───────────────────────────── raw ─────────────────────────────

/** How VAT applies to a line (server/API.md §5 Tax). */
export const rawTaxSchema = z.looseObject({
  treatment: z.enum(['taxable', 'exempt', 'out_of_scope']),
  rate: z.number().nullable().describe('Fraction; null when no rate'),
  amount: z.number(),
  deductible: z.number(),
  exemption_reason: z.string().nullable(),
  overridden: z.boolean(),
});
export type RawTax = z.infer<typeof rawTaxSchema>;

export const rawLineSchema = z.looseObject({
  id,
  amount: z.number(),
  direction: direction.optional(),
  refund: z.boolean().optional(),
  category_id: z.number().nullable(),
  tax: rawTaxSchema,
});
export type RawLine = z.infer<typeof rawLineSchema>;

export const rawFileSchema = z.looseObject({
  id,
  name: z.string(),
  mime_type: z.string().optional(),
  download_url: z.string().optional(),
});

export const rawDocumentSchema = z.looseObject({
  id,
  kind: z.string(),
  purchase_invoice_id: z.string().nullable().optional(),
  amount: z.number().nullable().optional(),
  date: z.string().nullable().optional(),
  file: rawFileSchema.nullable().optional(),
});

export const rawAttachmentSchema = z.looseObject({
  id,
  removable: z.boolean().optional(),
  document: rawDocumentSchema,
});
export type RawAttachment = z.infer<typeof rawAttachmentSchema>;

export const rawBankDetailsSchema = z.looseObject({
  account_id: id,
  amount: z.number().optional(),
  currency: z.string().optional(),
  original_amount: z.number().nullable().optional(),
  original_currency: z.string().nullable().optional(),
  fx_rate: z.number().nullable().optional(),
});

export const rawTransactionSchema = z.looseObject({
  id,
  company_id: id.optional(),
  source: z.string().optional(),
  date: z.string(),
  label: z.string(),
  note: z.string().nullable().optional(),
  amount: z.number(),
  direction,
  validated: z.boolean(),
  validated_at: z.string().nullable().optional(),
  status: z.string().optional(),
  lock: z
    .looseObject({ manual: z.boolean().optional(), period: z.boolean().optional() })
    .optional(),
  issues: z.array(z.unknown()).optional(),
  bank: rawBankDetailsSchema.nullable().optional(),
  lines: z.array(rawLineSchema),
  attachments: z.array(rawAttachmentSchema).default([]),
});
export type RawTransaction = z.infer<typeof rawTransactionSchema>;

export const rawBankAccountSchema = z.looseObject({
  id,
  name: z.string().nullable().optional(),
  bank_name: z.string().nullable().optional(),
  currency: z.string().optional(),
  closed: z.boolean().optional(),
  hidden: z.boolean().optional(),
  balance: z
    .looseObject({
      amount: z.number().nullable().optional(),
      updated_at: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type RawBankAccount = z.infer<typeof rawBankAccountSchema>;

export const rawCategorySchema = z.looseObject({
  id: z.number(),
  label: z.string(),
  group: z.looseObject({ name: z.string().optional() }).nullable().optional(),
  hidden: z.boolean().optional(),
  assignable: z.boolean().optional(),
  direction: z.enum(['in', 'out', 'both']).optional(),
  parent_id: z.number().nullable().optional(),
  ledger_account: z.string().nullable().optional(),
  ledger_accounts: z.array(z.string()).nullable().optional(),
  default_vat: z
    .looseObject({
      rate: z.number().nullable().optional().describe('Fraction; null: no default rate'),
      optional: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  exemptions: z.enum(['unavailable', 'allowed', 'required']).optional(),
});
export type RawCategory = z.infer<typeof rawCategorySchema>;

export const rawCompanySchema = z.looseObject({
  id,
  legal_name: z.string().nullable().optional(),
  trade_name: z.string().nullable().optional(),
});

export const rawUserSchema = z.looseObject({
  id,
  email: z.string().nullable().optional(),
  name: z.looseObject({ full: z.string().nullable().optional() }).nullable().optional(),
  companies: z.array(rawCompanySchema).optional(),
  company: rawCompanySchema.optional(),
});

export const rawPurchaseInvoiceSchema = z.looseObject({
  id: z.string(),
  extraction_status: z.string().nullable().optional(),
  total_amount: z.number().nullable().optional(),
  vat_amount: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
  issue_date: z.string().nullable().optional(),
  supplier: z
    .looseObject({
      name: z.string().nullable().optional(),
      country: z.string().nullable().optional(),
      vat_number: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  vat_lines: z
    .array(
      z.looseObject({
        rate: z.number().nullable().optional(),
        vat_amount: z.number().nullable().optional(),
        tax_category: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  file: z
    .looseObject({
      id: id.nullable().optional(),
      name: z.string().nullable().optional(),
      download_url: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type RawPurchaseInvoice = z.infer<typeof rawPurchaseInvoiceSchema>;

export const rawVatReturnSummarySchema = z.looseObject({
  id,
  return_type: z.string(),
  form_year: z.number().nullable().optional(),
  tax: z.string().nullable().optional(),
  title: z.string().optional(),
  period_start: z.string(),
  period_end: z.string(),
  due_date: z.string().nullable().optional(),
  filed: z.boolean().optional(),
  overdue: z.boolean().optional(),
  confirmed_at: z.string().nullable().optional(),
  filed_at: z.string().nullable().optional(),
  dismissed: z.boolean().optional(),
  net_amount: z.number().optional(),
});
export type RawVatReturnSummary = z.infer<typeof rawVatReturnSummarySchema>;

export const rawVatReturnSchema = rawVatReturnSummarySchema.extend({
  boxes: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const rawFiscalYearSchema = z.looseObject({
  id,
  start_date: z.string(),
  end_date: z.string(),
  closed: z.boolean().optional(),
  current: z.boolean().optional(),
});
export type RawFiscalYear = z.infer<typeof rawFiscalYearSchema>;

// ───────────────────────────── normalized ─────────────────────────────

/**
 * Why a purchase carries no French VAT — the five reasons Compta offers on
 * purchases (raw `purchase_*` values):
 * - outside-eu: supplier established outside the EU (reverse charge)
 * - inside-eu: supplier in another EU country (reverse charge / intra-EU acquisition)
 * - outside-eu-not-imported: goods bought outside the EU and not imported into it
 * - not-applicable: the supplier charges no VAT ("TVA non applicable", e.g. a French
 *   micro-entrepreneur under the art. 293 B CGI franchise)
 * - no-document: the justifying document is lost
 */
export const VAT_EXEMPT_KINDS = [
  'outside-eu',
  'inside-eu',
  'outside-eu-not-imported',
  'not-applicable',
  'no-document',
] as const;
export const vatExemptKindSchema = z.enum(VAT_EXEMPT_KINDS);
export type VatExemptKind = z.infer<typeof vatExemptKindSchema>;

export const categoryRefSchema = z
  .object({
    id: z.number().int().describe('Compta category id (use with --category)'),
    name: z.string(),
    path: z
      .array(z.string())
      .describe('Group then category name, e.g. ["Frais de fonctionnement", "Publicité"]'),
  })
  .describe('Category assigned to a breakdown');

export const breakdownSchema = z.object({
  id: z.string(),
  isCounterpart: z.boolean(),
  section: z.string().nullable(),
  direction: z
    .enum(['expense', 'income'])
    .describe('Can differ from the operation (e.g. fees inside a payout)'),
  isRefund: z.boolean().describe('A refund: reverses VAT of the opposite direction'),
  vatApplicable: z
    .boolean()
    .describe('False when VAT does not apply to this line: no VAT, no exemption'),
  category: categoryRefSchema.nullable().describe('null when uncategorized (category -1 in plans)'),
  amount: z.number().describe('Gross amount (TTC) in EUR'),
  amountExcludingVat: z.number().describe('Net amount (HT) in EUR'),
  vatRate: z.number().nullable().describe('Percent, e.g. 20 or 5.5; null when none'),
  vatAmount: z.number().describe('VAT in EUR'),
  recoverableVat: z
    .number()
    .describe(
      'Deductible part of the VAT (lower than vatAmount for partially recoverable categories)',
    ),
  vatExemptReason: z
    .string()
    .nullable()
    .describe(
      'outside-eu | inside-eu | outside-eu-not-imported | not-applicable | no-document. The same short names cover purchase (outbound) and sales (inbound) reasons; which one is meant follows from the line (direction and isRefund). Unknown API values are passed through raw.',
    ),
});
export type Breakdown = z.infer<typeof breakdownSchema>;

export const attachmentSchema = z.object({
  id: z.string().describe('Attachment id (use with ops detach)'),
  documentId: z.string(),
  fileId: z.string().nullable(),
  filename: z.string(),
  mimeType: z.string().nullable(),
  type: z
    .string()
    .describe('vendorInvoice | salesInvoice | other | unknown (classification is async)'),
  vendorInvoiceId: z.string().nullable(),
  downloadPath: z.string().nullable().describe('Authenticated API path; use compta ops download'),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const operationSchema = z
  .object({
    id: z.string(),
    date: z.string().describe('YYYY-MM-DD'),
    wording: z.string().describe('Bank wording'),
    type: z.string().nullable().describe('bank | expense'),
    amount: z.number().describe('Always positive, in EUR; see direction'),
    direction: z.enum(['expense', 'income']),
    original: z
      .object({ amount: z.number(), currency: z.string() })
      .nullable()
      .describe('Native amount when the bank line was in a foreign currency'),
    validated: z.boolean(),
    locked: z
      .boolean()
      .describe('Locked in Compta (manually or by a closed period); the CLI will not edit it'),
    memo: z.string().nullable(),
    account: z.object({ id: z.string(), name: z.string() }).nullable(),
    breakdowns: z.array(breakdownSchema),
    category: categoryRefSchema
      .nullable()
      .describe('Mirror of the single main breakdown; null if split'),
    vatRate: z.number().nullable(),
    vatAmount: z.number().nullable(),
    amountExcludingVat: z.number().nullable(),
    vatExemptReason: z.string().nullable(),
    attachments: z.array(attachmentSchema),
    url: z
      .string()
      .describe('Link to the operation in the Compta web app (same origin as the API)'),
  })
  .describe('A Compta accounting operation (normalized)');
export type Operation = z.infer<typeof operationSchema>;

export const categorySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  group: z.string().nullable(),
  path: z.array(z.string()),
  direction: z.enum(['expense', 'income', 'both']),
  accountingNumber: z.string().nullable().describe('French PCG account, e.g. "626100"'),
  defaultVatRate: z.number().nullable().describe('Percent'),
  carriesVat: z
    .boolean()
    .describe(
      'False for categories outside VAT (bank fees, transfers, salaries, taxes…); a line may still opt in',
    ),
  vatOptional: z.boolean(),
  accountingNumbers: z.array(z.string()).describe('Every PCG account the category books to'),
  needsDocument: z
    .boolean()
    .describe(
      'False for movements that never need a receipt (transfers, capital, loans, subsidies, FX, tax settlements)',
    ),
});
export type Category = z.infer<typeof categorySchema>;

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  bank: z.string(),
  currency: z.string(),
  balance: z.number().nullable().describe('Live balance in the account currency'),
  balanceUpdatedAt: z.string().nullable(),
  closed: z.boolean(),
  hidden: z.boolean(),
});
export type Account = z.infer<typeof accountSchema>;

export const companySchema = z.object({ id: z.string(), name: z.string() });
export type Company = z.infer<typeof companySchema>;

export const whoamiSchema = z.object({
  user: z.object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable() }),
  companies: z.array(companySchema),
  activeCompany: z.string().nullable(),
  profile: z.string(),
  authSource: z.enum(['env', 'password', 'token']),
  /** Where the token is kept: an OS credential store, the config file, or COMPTA_SESSION. */
  sessionStorage: z.string(),
  sessionExpiresAt: z.string().nullable(),
});
export type Whoami = z.infer<typeof whoamiSchema>;
