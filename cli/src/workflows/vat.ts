import { z } from 'zod';
import type { Compta, OperationRecord } from '../api/compta.js';
import type { Breakdown, Operation, RawPurchaseInvoice } from '../api/schemas.js';
import { isEuCountry } from '../pdf/extract.js';
import { expectFor } from '../plan/diff.js';
import { mapLimit } from '../util/concurrency.js';
import { cents, FRENCH_VAT_RATES, sameCents } from '../util/money.js';
import type { CategoryIndex, Finding, VatRule } from './findings.js';
import type { VendorRegistry, VendorZone } from './vendors.js';

/** What the attached documents say about the supplier and its VAT. */
export interface DocumentEvidence {
  source: 'vendor-invoice' | 'pdf';
  zone: VendorZone | 'domestic' | 'foreign' | null;
  country?: string | null;
  vatAmount: number | null;
  /** The document charges VAT somewhere (any VAT line above zero). */
  chargesVat: boolean;
  reverseCharge: boolean;
  totals: number[];
  currency: string | null;
}

function zoneFromCountry(country: string | null | undefined): DocumentEvidence['zone'] {
  if (!country) return null;
  const c = country.toUpperCase();
  if (c === 'FR' || c === 'MC') return 'domestic';
  if (c === 'EU') return 'outside-eu'; // non-EU business registered under the OSS scheme
  return isEuCountry(c) ? 'inside-eu' : 'outside-eu';
}

/** Evidence from Compta's reading of a supplier invoice (null until the extraction is done). */
export function evidenceFromPurchaseInvoice(v: RawPurchaseInvoice): DocumentEvidence | null {
  if (v.extraction_status && v.extraction_status !== 'done') return null;
  const reverseCharge = (v.vat_lines ?? []).some((b) => b.tax_category === 'AE');
  const country = v.supplier?.country;
  return {
    source: 'vendor-invoice',
    zone: zoneFromCountry(country),
    country: country ?? null,
    vatAmount: v.vat_amount ?? null,
    chargesVat: (v.vat_amount ?? 0) > 0 && !reverseCharge,
    reverseCharge,
    totals: v.total_amount != null ? [v.total_amount] : [],
    currency: v.currency ?? null,
  };
}

/** Prefer Compta's own invoice reading (cheap JSON); fall back to PDF text. */
export async function documentEvidence(
  compta: Compta,
  op: Operation,
): Promise<DocumentEvidence | null> {
  for (const att of op.attachments) {
    if (!att.vendorInvoiceId) continue;
    const evidence = evidenceFromPurchaseInvoice(
      await compta.purchaseInvoice(att.vendorInvoiceId).catch(() => ({ id: '' })),
    );
    if (evidence) return evidence;
  }
  for (const att of op.attachments) {
    const facts = await compta.attachmentFacts(att).catch(() => null);
    if (!facts) continue;
    const foreign = facts.vatNumbers.filter((n) => n.country !== 'FR');
    const zone = foreign.some((n) => isEuCountry(n.country))
      ? 'inside-eu'
      : foreign.length
        ? 'outside-eu'
        : facts.reverseCharge
          ? 'foreign'
          : null;
    return {
      source: 'pdf',
      zone,
      country: foreign[0]?.country ?? null,
      // Several VAT lines: keep the amount only if they agree.
      vatAmount: new Set(facts.vatAmounts).size === 1 ? facts.vatAmounts[0]! : null,
      chargesVat: facts.vatAmounts.some((v) => v > 0),
      reverseCharge: facts.reverseCharge,
      totals: facts.totals,
      currency: facts.currency,
    };
  }
  return null;
}

function mainBreakdown(op: Operation): Breakdown | null {
  const mains = op.breakdowns.filter((b) => !b.isCounterpart);
  return mains.length === 1 ? mains[0]! : null;
}

function vatFinding(
  op: Operation,
  rule: VatRule,
  severity: Finding['severity'],
  detail: string,
  extra: Partial<Finding> = {},
): Finding {
  return { code: rule, severity, detail, op, ...extra };
}

export interface VatContext {
  vendors: VendorRegistry;
  categories?: CategoryIndex;
  evidence?: DocumentEvidence | null;
}

const EXEMPT_LABEL: Record<VendorZone, string> = {
  'outside-eu': 'outside the EU',
  'inside-eu': 'in another EU country',
};

interface SupplierAssessment {
  zone: VendorZone | null;
  why: string | null;
  strong: boolean;
  vendor: string | null;
  source: 'vendor-invoice' | 'pdf' | 'pdf-heuristic' | 'rules-vendor' | 'builtin-vendor' | null;
}

/**
 * Where the supplier is established, and how sure we are. The attached
 * invoice wins over the vendor list: billing entities vary by customer region
 * (many US SaaS vendors invoice EU businesses from an EU subsidiary).
 */
export function assessSupplier(
  op: Operation,
  ev: DocumentEvidence | null,
  vendors: VendorRegistry,
): SupplierAssessment {
  const match = vendors.match(op.wording);
  const vendor = match?.vendor.name ?? null;
  if (ev?.zone === 'domestic')
    return { zone: null, why: null, strong: false, vendor, source: ev.source };
  if (ev && (ev.zone === 'inside-eu' || ev.zone === 'outside-eu')) {
    const strong =
      ev.source === 'vendor-invoice' ? ev.reverseCharge : ev.reverseCharge && ev.vatAmount === 0;
    return {
      zone: ev.zone,
      why: `the invoice shows a supplier ${EXEMPT_LABEL[ev.zone]}${ev.country ? ` (${ev.country})` : ''}${ev.reverseCharge ? ' and reverse charge' : ''}`,
      strong,
      vendor,
      source: ev.source === 'pdf' && !ev.reverseCharge ? 'pdf-heuristic' : ev.source,
    };
  }
  if (match)
    return {
      zone: match.vendor.zone,
      why: `${match.vendor.name} is established ${EXEMPT_LABEL[match.vendor.zone]}${match.custom ? ' (your rules file)' : ''}`,
      strong: match.custom,
      vendor,
      source: match.custom ? 'rules-vendor' : 'builtin-vendor',
    };
  return { zone: null, why: null, strong: false, vendor, source: null };
}

/** All VAT findings for one operation. Pure: documents are fetched by the caller. */
export function checkVat(op: Operation, ctx: VatContext): Finding[] {
  const findings: Finding[] = [];
  for (const b of op.breakdowns) {
    if (b.isCounterpart) continue;
    // HT here already includes any non-recoverable VAT, so it pairs with the recoverable part.
    const drift = cents(b.amount - (b.amountExcludingVat + b.recoverableVat));
    if (Math.abs(drift) > 0.01)
      findings.push(
        vatFinding(
          op,
          'VAT_TOTAL_MISMATCH',
          'error',
          `TTC ${b.amount.toFixed(2)} ≠ HT ${b.amountExcludingVat.toFixed(2)} + VAT ${b.recoverableVat.toFixed(2)} (off by ${drift.toFixed(2)})`,
        ),
      );
    if (b.vatRate !== null && !(FRENCH_VAT_RATES as readonly number[]).includes(b.vatRate))
      findings.push(
        vatFinding(
          op,
          'VAT_RATE_INVALID',
          'error',
          `VAT rate ${b.vatRate}% is not a French rate (0, 2.1, 5.5, 10, 20)`,
        ),
      );
  }
  if (op.direction !== 'expense') return findings;
  const b = mainBreakdown(op);
  if (!b) return findings;

  const ev = ctx.evidence ?? null;
  const assessment = assessSupplier(op, ev, ctx.vendors);
  const { zone, why, strong } = assessment;
  const evidence = {
    vendor: assessment.vendor,
    document: ev,
    strength: strong ? 'strong' : 'weak',
  };
  // Strong evidence (Compta's reverse-charge code, an explicit reverse-charge invoice
  // with 0 VAT, or a vendor from the user's rules) is an error with a plannable fix;
  // anything else is a warning, and its fix is only planned with --include-warnings.
  // The PDF VAT-number heuristic alone never produces a fix.
  const severity = strong ? 'error' : 'warning';
  const fix = (kind: VendorZone) => {
    if (!b.category || assessment.source === 'pdf-heuristic') return undefined;
    const shape = { action: 'set' as const, set: { vatExempt: kind } };
    return {
      op: op.id,
      ...shape,
      expect: expectFor(op, shape),
      why: `${why}; reverse charge, no French VAT to deduct`,
    };
  };

  // An invoice that itself charges VAT is authoritative: the supplier billed VAT
  // (e.g. an EU company registered for French VAT), so this is not reverse charge.
  const invoiceChargesVat = !!ev && !ev.reverseCharge && (ev.chargesVat || (ev.vatAmount ?? 0) > 0);
  if (b.vatAmount > 0 && !invoiceChargesVat) {
    const docSaysZero = ev?.vatAmount === 0 || ev?.reverseCharge;
    if (zone && why) {
      findings.push(
        vatFinding(
          op,
          'REVERSE_CHARGE_SUSPECT',
          severity,
          `${b.vatAmount.toFixed(2)} € of deductible French VAT booked, but ${why}`,
          {
            evidence,
            fix: fix(zone),
          },
        ),
      );
    } else if (ev?.zone === 'foreign' && docSaysZero) {
      findings.push(
        vatFinding(
          op,
          'REVERSE_CHARGE_SUSPECT',
          'warning',
          `invoice mentions reverse charge but ${b.vatAmount.toFixed(2)} € of VAT is booked; supplier country unknown`,
          { evidence },
        ),
      );
    }
  } else if (
    b.vatExemptReason &&
    zone &&
    (b.vatExemptReason === 'outside-eu' || b.vatExemptReason === 'inside-eu') &&
    b.vatExemptReason !== zone
  ) {
    findings.push(
      vatFinding(
        op,
        'REVERSE_CHARGE_SUSPECT',
        severity,
        `exempted as ${b.vatExemptReason}, but ${why}`,
        {
          evidence,
          fix: fix(zone),
        },
      ),
    );
  } else if (!b.vatExemptReason && b.vatAmount === 0 && b.category && !invoiceChargesVat) {
    // Lines outside VAT (bank fees, insurance, salaries, transfers…) rightly have no VAT
    // and no exemption reason; Compta offers no exemption there. The line's own
    // treatment (vatApplicable) decides; the category’s VAT metadata is the fallback.
    const category = ctx.categories?.get(b.category.id);
    const outsideVat = !b.vatApplicable || (category ? !category.carriesVat : false);
    const expectsVat =
      !outsideVat &&
      (zone !== null ||
        (category ? (category.defaultVatRate ?? 0) > 0 && !category.vatOptional : false));
    if (expectsVat)
      findings.push(
        vatFinding(
          op,
          'ZERO_VAT_NO_REASON',
          zone ? severity : 'warning',
          zone && why
            ? `no VAT and no exemption reason; ${why}`
            : `no VAT and no exemption reason, but "${b.category.name}" normally carries VAT`,
          { evidence, fix: zone ? fix(zone) : undefined },
        ),
      );
  }

  // Only compare VAT when the document is for this exact amount: one invoice
  // often covers several bank lines (or the reverse), and then VAT differs legitimately.
  const sameDocument = ev?.totals.some((t) => sameCents(t, b.amount, 0.05));
  if (
    ev &&
    sameDocument &&
    ev.vatAmount !== null &&
    (ev.currency ?? 'EUR') === 'EUR' &&
    !ev.reverseCharge &&
    !sameCents(ev.vatAmount, b.vatAmount, 0.02)
  )
    findings.push(
      vatFinding(
        op,
        'DOCUMENT_VAT_MISMATCH',
        'warning',
        `invoice VAT ${ev.vatAmount.toFixed(2)} € ≠ booked VAT ${b.vatAmount.toFixed(2)} €`,
        { evidence },
      ),
    );
  return findings;
}

export interface VatCheckOptions {
  documents: boolean;
  categories?: CategoryIndex;
  vendors: VendorRegistry;
  onProgress?: (done: number, total: number) => void;
}

export async function runVatCheck(
  compta: Compta,
  records: readonly OperationRecord[],
  options: VatCheckOptions,
) {
  const withDocs = options.documents
    ? records.filter((r) => r.op.direction === 'expense' && r.op.attachments.length)
    : [];
  const evidence = new Map<string, DocumentEvidence | null>();
  let done = 0;
  await mapLimit(withDocs, 4, async ({ op }) => {
    evidence.set(op.id, await documentEvidence(compta, op));
    options.onProgress?.(++done, withDocs.length);
  });
  const findings = records.flatMap(({ op }) =>
    checkVat(op, {
      vendors: options.vendors,
      categories: options.categories,
      evidence: evidence.get(op.id),
    }),
  );
  return { findings, documentsChecked: withDocs.length };
}

// ─────────────────────────── vat summary (CA3 estimate) ───────────────────────────

/** Official labels of the 3310-CA3 boxes the estimate fills. */
export const CA3_BOXES: Record<string, string> = {
  A1: 'Ventes, prestations de services',
  A3: 'Achats de prestations de services auprès d’un assujetti non établi en France',
  'A3:01': '… dont prestations autoliquidées, en UE',
  'A3:02': '… dont prestations autoliquidées, hors UE',
  E2: 'Autres opérations non imposables (E1/E2/F2 combined)',
  '08': 'Base hors taxe 20 %',
  '08:VAT': 'Taxe due 20 %',
  '9B': 'Base hors taxe 10 %',
  '9B:VAT': 'Taxe due 10 %',
  '09': 'Base hors taxe 5,5 %',
  '09:VAT': 'Taxe due 5,5 %',
  '16': 'Total de la TVA brute due',
  '19': 'TVA déductible – biens constituant des immobilisations',
  '20': 'TVA déductible – autres biens et services',
  '20:A': '… dont biens et services en France',
  '20:B': '… dont autoliquidés en UE',
  '20:C': '… dont autoliquidés hors UE',
  '22': 'Report du crédit',
  '23': 'Total TVA déductible',
  '25': 'Crédit de TVA',
  '28': 'TVA nette due',
};

export const vatSummaryLineSchema = z.object({
  box: z.string(),
  label: z.string(),
  estimate: z.number().nullable(),
  declared: z.number().nullable(),
  difference: z.number().nullable(),
});

export const vatSummarySchema = z
  .object({
    meta: z.object({
      month: z.string(),
      estimate: z.literal(true),
      operations: z.number(),
      unvalidated: z.number(),
      uncategorized: z.number(),
      declaration: z
        .object({
          id: z.string(),
          label: z.string().nullable(),
          status: z.enum(['completed', 'ready_to_complete', 'upcoming']),
          filed: z.boolean(),
          dueDate: z.string().nullable(),
          isLate: z.boolean(),
          hasForm: z
            .boolean()
            .describe('Compta computed figures (filed, or a draft for open months)'),
          corrective: z
            .boolean()
            .describe('Several filed returns exist for the month; the latest is used'),
        })
        .nullable()
        .describe('The Compta CA3 for this month, when one exists'),
    }),
    collectedByRate: z.array(z.object({ rate: z.number(), base: z.number(), vat: z.number() })),
    lines: z.array(vatSummaryLineSchema),
    notes: z.array(z.string()),
  })
  .describe(
    'Monthly CA3 estimate, side by side with Compta’s figures: the filed return, or its draft for open months (`declared`)',
  );
export type VatSummary = z.infer<typeof vatSummarySchema>;

const SELF_ASSESSED_RATE = 20;

/**
 * Only revenue (PCG class 7) counts as a non-taxable sale; other untaxed income
 * (transfers between accounts, capital, loans, refunds) is not a CA3 line.
 */
function isRevenue(categoryId: number | undefined, categories?: CategoryIndex): boolean {
  if (!categories) return true;
  const account = categoryId === undefined ? null : categories.get(categoryId)?.accountingNumber;
  return !!account?.startsWith('7');
}

/** Compute CA3 boxes (in EUR, cents) from the month's operations. */
export function estimateCa3(
  ops: readonly Operation[],
  categories?: CategoryIndex,
  previousCredit: number | null = null,
) {
  const collected = new Map<number, { base: number; vat: number }>();
  let nonTaxable = 0;
  const rc = { eu: 0, nonEu: 0 };
  let deductibleDomestic = 0;
  let deductibleAssets = 0;
  for (const op of ops) {
    for (const b of op.breakdowns) {
      if (b.isCounterpart) continue;
      // A refund reverses VAT of the opposite flow: money back from a supplier
      // reduces deductible VAT; money back to a customer reduces collected VAT.
      const sale = b.isRefund ? b.direction === 'expense' : b.direction === 'income';
      const sign = b.isRefund ? -1 : 1;
      if (sale) {
        if (b.vatAmount > 0 && b.vatRate) {
          const bucket = collected.get(b.vatRate) ?? { base: 0, vat: 0 };
          bucket.base += sign * b.amountExcludingVat;
          bucket.vat += sign * b.vatAmount;
          collected.set(b.vatRate, bucket);
        } else if (isRevenue(b.category?.id, categories)) nonTaxable += sign * b.amount;
        continue;
      }
      if (b.vatExemptReason === 'inside-eu') rc.eu += sign * b.amount;
      else if (b.vatExemptReason === 'outside-eu') rc.nonEu += sign * b.amount;
      else if (b.recoverableVat > 0) {
        // Only the recoverable part of the VAT is deductible.
        const account = b.category ? categories?.get(b.category.id)?.accountingNumber : null;
        if (account?.startsWith('2')) deductibleAssets += sign * b.recoverableVat;
        else deductibleDomestic += sign * b.recoverableVat;
      }
    }
  }
  const at = (rate: number) => collected.get(rate) ?? { base: 0, vat: 0 };
  const selfEu = (rc.eu * SELF_ASSESSED_RATE) / 100;
  const selfNonEu = (rc.nonEu * SELF_ASSESSED_RATE) / 100;
  const collectedVat = [...collected.values()].reduce((s, v) => s + v.vat, 0);
  const line16 = collectedVat + selfEu + selfNonEu;
  const line20 = deductibleDomestic + selfEu + selfNonEu;
  const line23 = deductibleAssets + line20 + (previousCredit ?? 0);
  const boxes: Record<string, number | null> = {
    A1: [...collected.values()].reduce((s, v) => s + v.base, 0),
    A3: rc.eu + rc.nonEu,
    'A3:01': rc.eu,
    'A3:02': rc.nonEu,
    E2: nonTaxable,
    '08': at(20).base + rc.eu + rc.nonEu,
    '08:VAT': at(20).vat + selfEu + selfNonEu,
    '9B': at(10).base,
    '9B:VAT': at(10).vat,
    '09': at(5.5).base,
    '09:VAT': at(5.5).vat,
    '16': line16,
    '19': deductibleAssets,
    '20': line20,
    '20:A': deductibleDomestic,
    '20:B': selfEu,
    '20:C': selfNonEu,
    '22': previousCredit,
    '23': line23,
    '25': Math.max(0, line23 - line16),
    '28': Math.max(0, line16 - line23),
  };
  for (const key of Object.keys(boxes)) if (boxes[key] != null) boxes[key] = cents(boxes[key]!);
  const byRate = [...collected.entries()]
    .map(([rate, v]) => ({ rate, base: cents(v.base), vat: cents(v.vat) }))
    .sort((a, b) => b.rate - a.rate);
  return { boxes, byRate };
}

/** A declared box value; `declared` is keyed by the CLI's box names (see boxesByName). */
function declaredValue(
  declared: Record<string, unknown> | null | undefined,
  box: string,
): number | null {
  if (!declared) return null;
  if (box === 'E2') {
    const parts = ['E1', 'E2', 'F2']
      .map((k) => declared[k])
      .filter((v): v is number => typeof v === 'number');
    return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  }
  const v = declared[box];
  return typeof v === 'number' ? v : null;
}

export function compareWithDeclaration(
  boxes: Record<string, number | null>,
  declaredBoxes: Record<string, unknown> | null | undefined,
): VatSummary['lines'] {
  return Object.entries(CA3_BOXES).map(([box, label]) => {
    const estimate = boxes[box] ?? null;
    const declared = declaredValue(declaredBoxes, box);
    const difference =
      estimate !== null && declared !== null ? Math.round(estimate) - declared : null;
    return { box, label, estimate, declared, difference };
  });
}
