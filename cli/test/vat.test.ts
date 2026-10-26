import { describe, expect, it } from 'vitest';
import { normalizeCategory, normalizeOperation } from '../src/api/normalize.js';
import { rawTransactionSchema } from '../src/api/schemas.js';
import type { CategoryIndex } from '../src/workflows/findings.js';
import {
  checkVat,
  compareWithDeclaration,
  type DocumentEvidence,
  estimateCa3,
  evidenceFromPurchaseInvoice,
} from '../src/workflows/vat.js';
import { VendorRegistry } from '../src/workflows/vendors.js';
import {
  COMPANY,
  type OpOptions,
  type RawOpFixture,
  rawCategories,
  rawCategoryMap,
  rawOp,
} from './helpers/fixtures.js';

const toOp = (raw: RawOpFixture) =>
  normalizeOperation(rawTransactionSchema.parse(raw), {
    company: COMPANY,
    apiBase: 'https://compta.example.test',
    categories: rawCategoryMap(),
  });
const op = (o: OpOptions) => toOp(rawOp(o));
const categories: CategoryIndex = new Map(rawCategories().map((c) => [c.id, normalizeCategory(c)]));
const vendors = new VendorRegistry();
const codes = (o: ReturnType<typeof op>, evidence?: DocumentEvidence | null) =>
  checkVat(o, { vendors, categories, evidence }).map((f) => f.code);

function evidence(partial: Partial<DocumentEvidence>): DocumentEvidence {
  return {
    source: 'vendor-invoice',
    zone: null,
    vatAmount: null,
    chargesVat: false,
    reverseCharge: false,
    totals: [],
    currency: 'EUR',
    ...partial,
  };
}

describe('vat check rules', () => {
  it('flags a built-in foreign vendor booked with French VAT as a warning (weak evidence)', () => {
    const cloud = op({ id: 1, wording: 'CLOUDFLARE', amount: 24, vatRate: 20 });
    const [finding] = checkVat(cloud, { vendors, categories });
    expect(finding).toMatchObject({
      code: 'REVERSE_CHARGE_SUSPECT',
      severity: 'warning',
      detail:
        '4.00 € of deductible French VAT booked, but Cloudflare is established outside the EU',
      fix: {
        op: '1',
        action: 'set',
        set: { vatExempt: 'outside-eu' },
        expect: { vatAmount: 4, category: 77, vatRate: 20, vatExemptReason: null },
      },
    });
  });

  it('uses document evidence: foreign supplier country and zero VAT', () => {
    const o = op({ wording: 'CB UNKNOWN SAAS', amount: 30, vatRate: 20 });
    expect(codes(o, evidence({ zone: 'inside-eu', country: 'DE', vatAmount: 0 }))).toEqual([
      'REVERSE_CHARGE_SUSPECT',
    ]);
  });

  it('trusts an invoice that itself charges VAT (no reverse charge)', () => {
    const o = op({ wording: 'CLOUDFLARE', amount: 24, vatRate: 20 });
    expect(
      codes(o, evidence({ zone: 'outside-eu', country: 'US', vatAmount: 4, totals: [24] })),
    ).toEqual([]);
  });

  it('flags an exemption that names the wrong zone', () => {
    const o = op({
      wording: 'HETZNER ONLINE',
      exemption: 'purchase_non_eu',
    });
    const [finding] = checkVat(o, { vendors, categories });
    expect(finding).toMatchObject({
      code: 'REVERSE_CHARGE_SUSPECT',
      fix: { set: { vatExempt: 'inside-eu' } },
    });
  });

  it('flags zero VAT without a reason when the category normally carries VAT', () => {
    expect(codes(op({ wording: 'CB LOCAL SHOP', vatRate: 0 }))).toEqual(['ZERO_VAT_NO_REASON']);
    expect(codes(op({ wording: 'BANK FEE', category: 'bankFees', vatRate: 0 }))).toEqual([]);
  });

  it('flags TTC ≠ HT + VAT and non-French rates', () => {
    const raw = rawOp({ amount: 100 });
    raw.lines[0]!.tax = { ...raw.lines[0]!.tax, amount: 10, deductible: 10, rate: 0.19 };
    const op = toOp(raw);
    expect(codes(op)).toEqual(['VAT_RATE_INVALID']);
    // HT is derived from the deductible VAT, so only an inconsistent operation can mismatch.
    op.breakdowns[0]!.amountExcludingVat = 83.33;
    expect(codes(op)).toEqual(['VAT_TOTAL_MISMATCH', 'VAT_RATE_INVALID']);
  });

  it('compares invoice VAT only when the invoice is for this amount', () => {
    const o = op({ wording: 'CB LOCAL SHOP', amount: 60, vatRate: 20 });
    expect(codes(o, evidence({ zone: 'domestic', vatAmount: 5, totals: [60] }))).toEqual([
      'DOCUMENT_VAT_MISMATCH',
    ]);
    expect(codes(o, evidence({ zone: 'domestic', vatAmount: 5, totals: [120] }))).toEqual([]);
  });

  it('reads Compta purchase-invoice data as evidence', () => {
    expect(
      evidenceFromPurchaseInvoice({
        id: 'v',
        extraction_status: 'done',
        supplier: { country: 'IE' },
        vat_amount: 0,
        total_amount: 30,
        currency: 'EUR',
        vat_lines: [{ tax_category: 'AE' }],
      }),
    ).toMatchObject({ zone: 'inside-eu', reverseCharge: true, totals: [30] });
    expect(evidenceFromPurchaseInvoice({ id: 'v', supplier: { country: 'US' } })).toMatchObject({
      zone: 'outside-eu',
    });
    expect(evidenceFromPurchaseInvoice({ id: 'v', supplier: { country: 'FR' } })).toMatchObject({
      zone: 'domestic',
    });
    expect(evidenceFromPurchaseInvoice({ id: 'v', extraction_status: 'pending' })).toBeNull();
  });

  it('lets the rules file add vendors', () => {
    const custom = new VendorRegistry([
      { name: 'Fictional Cloud', match: '/FICTICLOUD/i', zone: 'outside-eu' },
    ]);
    const o = op({ wording: 'Ficticloud Inc', amount: 12, vatRate: 20 });
    expect(checkVat(o, { vendors: custom, categories }).map((f) => f.code)).toEqual([
      'REVERSE_CHARGE_SUSPECT',
    ]);
  });
});

describe('vat summary (CA3 estimate)', () => {
  const month = [
    op({ income: true, category: 'sales', amount: 1200, vatRate: 20 }), // base 1000, VAT 200
    op({ income: true, category: 'sales', amount: 500, vatRate: 0 }), // non-taxable
    op({ amount: 120, vatRate: 20 }), // deductible 20
    op({ amount: 1200, category: 'equipment', vatRate: 20 }), // asset VAT 200
    op({ amount: 100, exemption: 'purchase_non_eu' }), // self-assessed 20
    op({ amount: 50, exemption: 'purchase_eu' }), // self-assessed 10
  ];

  it('computes collected, reverse-charge and deductible boxes', () => {
    const { boxes, byRate } = estimateCa3(month, categories, 100);
    expect(byRate).toEqual([{ rate: 20, base: 1000, vat: 200 }]);
    expect(boxes).toMatchObject({
      A1: 1000,
      A3: 150,
      'A3:01': 50,
      'A3:02': 100,
      E2: 500,
      '08': 1150,
      '08:VAT': 230,
      '16': 230,
      '19': 200,
      '20:A': 20,
      '20:B': 10,
      '20:C': 20,
      '20': 50,
      '22': 100,
      '23': 350,
      '25': 120,
      '28': 0,
    });
  });

  it('uses each breakdown’s own direction (fees inside a payout are purchases)', () => {
    const raw = rawOp({ income: true, category: 'sales', amount: 90, vatRate: 0 });
    raw.lines = [
      { ...raw.lines[0]!, id: 1, amount: 100 },
      {
        ...raw.lines[0]!,
        id: 2,
        amount: 10,
        direction: 'out',
        category_id: 77,
        tax: { ...raw.lines[0]!.tax, treatment: 'exempt', exemption_reason: 'purchase_eu' },
      },
    ];
    const { boxes } = estimateCa3([toOp(raw)], categories);
    expect(boxes).toMatchObject({ E2: 100, 'A3:01': 10, '20:B': 2 });
  });

  it('counts only revenue (PCG class 7) as non-taxable sales', () => {
    const transfer = rawOp({ income: true, category: 'bankFees', amount: 5000, vatRate: 0 });
    expect(estimateCa3([toOp(transfer)], categories).boxes.E2).toBe(0);
  });

  it('lines up with a filed declaration and shows differences in whole euros', () => {
    const { boxes } = estimateCa3(month, categories, 100);
    const lines = compareWithDeclaration(boxes, { '08': 1150, '16': 231, E1: 300, E2: 200 });
    expect(lines.find((l) => l.box === '08')).toMatchObject({
      estimate: 1150,
      declared: 1150,
      difference: 0,
    });
    expect(lines.find((l) => l.box === '16')).toMatchObject({ difference: -1 });
    expect(lines.find((l) => l.box === 'E2')).toMatchObject({ declared: 500, difference: 0 });
    expect(lines.find((l) => l.box === '19')).toMatchObject({ declared: null, difference: null });
  });
});
