import { describe, expect, it } from 'vitest';
import {
  exemptionKind,
  normalizeCategory,
  normalizeOperation,
  percentToRate,
  rateToPercent,
} from '../src/api/normalize.js';
import { operationSchema, rawTransactionSchema } from '../src/api/schemas.js';
import { breakdown, COMPANY, rawCategories, rawCategoryMap, rawOp } from './helpers/fixtures.js';

const normalize = (raw: unknown) =>
  normalizeOperation(rawTransactionSchema.parse(raw), {
    company: COMPANY,
    apiBase: 'https://compta.example.test',
    categories: rawCategoryMap(),
    accounts: new Map([['501', 'Main account']]),
  });

describe('normalizeOperation', () => {
  it('produces the documented, schema-valid shape', () => {
    const op = normalize(
      rawOp({
        id: 101,
        amount: 120,
        attachments: [{ name: 'invoice.pdf', vendorInvoiceId: 'vi-1' }],
      }),
    );
    expect(operationSchema.parse(op)).toEqual(op);
    expect(op).toMatchObject({
      id: '101',
      amount: 120,
      direction: 'expense',
      vatRate: 20,
      vatAmount: 20,
      amountExcludingVat: 100,
      category: {
        id: 77,
        name: 'Logiciels et abonnements',
        path: ['Frais de fonctionnement', 'Logiciels et abonnements'],
      },
      account: { id: '501', name: 'Main account' },
      url: `https://compta.example.test/app/companies/${COMPANY}/transactions/101`,
    });
    expect(op.attachments[0]).toMatchObject({
      filename: 'invoice.pdf',
      type: 'vendorInvoice',
      vendorInvoiceId: 'vi-1',
    });
  });

  it('speaks percent and short exemption names', () => {
    expect(rateToPercent(0.055)).toBe(5.5);
    expect(rateToPercent(0.021)).toBe(2.1);
    expect(percentToRate(5.5)).toBe(0.055);
    expect(exemptionKind('purchase_non_eu')).toBe('outside-eu');
    expect(exemptionKind('sale_not_applicable')).toBe('not-applicable');
    expect(exemptionKind('purchase_some_future_reason')).toBe('purchase_some_future_reason');
    const op = normalize(rawOp({ exemption: 'purchase_eu' }));
    expect(op).toMatchObject({ vatRate: null, vatAmount: 0, vatExemptReason: 'inside-eu' });
  });

  it('marks uncategorized breakdowns with a null category', () => {
    expect(normalize(rawOp({ category: 'uncategorized' })).category).toBeNull();
  });

  it('nulls the convenience mirrors on split operations', () => {
    const raw = rawOp({ id: 7, amount: 100 });
    raw.lines = [breakdown(7, 60, { id: 1 }), breakdown(7, 40, { id: 2, category: 'ads' })];
    const op = normalize(raw);
    expect(op.breakdowns).toHaveLength(2);
    expect(op).toMatchObject({
      category: null,
      vatRate: null,
      vatAmount: null,
      amountExcludingVat: null,
    });
  });

  it('keeps the original currency amount of foreign card payments', () => {
    expect(
      normalize(rawOp({ amount: 46.2, original: { amount: 50, currency: 'USD' } })).original,
    ).toEqual({ amount: 50, currency: 'USD' });
  });
});

describe('normalizeCategory', () => {
  it('maps direction, PCG account and default VAT', () => {
    const [software, , , sales] = rawCategories().map((c) => normalizeCategory(c));
    expect(software).toMatchObject({
      id: 77,
      direction: 'expense',
      accountingNumber: '626100',
      defaultVatRate: 20,
    });
    expect(sales).toMatchObject({ direction: 'income', accountingNumber: '706000' });
  });

  it('falls back to the ledger account list and treats a VAT without rate as no rate', () => {
    const c = normalizeCategory({
      id: 900,
      label: 'Ventes exonérées',
      ledger_account: null,
      ledger_accounts: ['706230', '706240'],
      default_vat: { rate: null },
    });
    expect(c).toMatchObject({
      accountingNumber: '706230',
      defaultVatRate: null,
      direction: 'both',
    });
  });
});
