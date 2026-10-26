import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeOperation } from '../src/api/normalize.js';
import { rawTransactionSchema } from '../src/api/schemas.js';
import {
  documentKey,
  matchReceipts,
  type ReceiptDocument,
  readReceipt,
  scoreMatch,
} from '../src/workflows/receipts.js';
import { COMPANY, type OpOptions, rawCategoryMap, rawOp } from './helpers/fixtures.js';
import { makePdf } from './helpers/pdf.js';
import { tempHome } from './helpers/run.js';

const op = (o: OpOptions) =>
  normalizeOperation(rawTransactionSchema.parse(rawOp(o)), {
    company: COMPANY,
    apiBase: 'https://compta.example.test',
    categories: rawCategoryMap(),
  });

function doc(partial: Partial<ReceiptDocument> & { name: string }): ReceiptDocument {
  return {
    path: `/inbox/${partial.name}`,
    text: partial.text ?? partial.name.toUpperCase(),
    totals: [],
    amounts: partial.totals ?? [],
    dates: [],
    dateSource: partial.dates?.length ? 'text' : null,
    currency: 'EUR',
    extracted: true,
    ...partial,
  };
}

describe('scoreMatch', () => {
  const nimbus = op({ id: 1, date: '2026-08-02', wording: 'PRLV NIMBUS HOSTING', amount: 48 });

  it('scores an exact amount, same-week date and vendor name highly, with reasons', () => {
    const s = scoreMatch(
      doc({
        name: 'nimbus.pdf',
        text: 'NIMBUS HOSTING GMBH INVOICE',
        totals: [48],
        dates: ['2026-08-01'],
      }),
      nimbus,
    );
    expect(s.total).toBeGreaterThanOrEqual(0.95);
    expect(s.reasons.join(', ')).toBe(
      "amount 48.00 = TTC, date +1d, vendor 'NIMBUS HOSTING' in wording",
    );
  });

  it('matches the HT amount and the original foreign-currency amount', () => {
    expect(scoreMatch(doc({ name: 'a.pdf', totals: [40] }), nimbus).reasons[0]).toBe(
      'amount 40.00 = HT',
    );
    const fx = op({ id: 2, amount: 46.2, original: { amount: 50, currency: 'USD' } });
    expect(scoreMatch(doc({ name: 'b.pdf', totals: [50], currency: 'USD' }), fx).reasons[0]).toBe(
      'amount 50.00 = USD',
    );
  });

  it('does not compare a foreign-currency total with the EUR amount (N3)', () => {
    const s = scoreMatch(doc({ name: 'c.pdf', totals: [48.9], currency: 'USD' }), nimbus);
    expect(s.amount).toBe(0);
  });

  it('rejects dates outside −10/+40 days and wrong amounts', () => {
    expect(
      scoreMatch(doc({ name: 'd.pdf', totals: [48], dates: ['2026-06-01'] }), nimbus).date,
    ).toBe(0);
    expect(scoreMatch(doc({ name: 'e.pdf', totals: [47.99] }), nimbus).amount).toBe(0);
  });
});

describe('matchReceipts', () => {
  const ops = [
    op({ id: 1, date: '2026-08-02', wording: 'PRLV NIMBUS HOSTING', amount: 48 }),
    op({ id: 2, date: '2026-08-05', wording: 'CB ORBIT TOOLS', amount: 19.99 }),
    op({ id: 3, date: '2026-08-06', wording: 'CB ORBIT TOOLS', amount: 19.99 }),
    op({
      id: 4,
      date: '2026-08-07',
      wording: 'CB PAPER CO',
      amount: 12,
      attachments: [{ name: 'paper-aug.pdf' }],
    }),
  ];

  it('separates confident, ambiguous, unmatched and already-attached files', () => {
    const { report, steps } = matchReceipts(
      [
        doc({
          name: '1001_nimbus-aug.pdf',
          text: 'NIMBUS HOSTING',
          totals: [48],
          dates: ['2026-08-01'],
        }),
        doc({ name: 'orbit.pdf', text: 'ORBIT TOOLS', totals: [19.99], dates: ['2026-08-05'] }),
        doc({ name: 'mystery.pdf', text: 'SOMETHING ELSE', totals: [999], dates: ['2026-08-05'] }),
        doc({ name: '2002_paper-aug.pdf', totals: [12] }),
      ],
      ops,
      { minScore: 0.8 },
    );
    expect(report.matched.map((m) => [m.file, m.best.op])).toEqual([
      ['/inbox/1001_nimbus-aug.pdf', '1'],
    ]);
    expect(report.ambiguous[0]).toMatchObject({
      file: '/inbox/orbit.pdf',
      candidates: [{ op: '2' }, { op: '3' }],
    });
    expect(report.unmatched[0]).toMatchObject({
      file: '/inbox/mystery.pdf',
      detected: { totals: [999] },
    });
    expect(report.alreadyAttached).toEqual([{ file: '/inbox/2002_paper-aug.pdf', op: '4' }]);
    expect(steps).toEqual([
      {
        op: '1',
        action: 'attach',
        file: '/inbox/1001_nimbus-aug.pdf',
        why: expect.stringContaining('score'),
      },
    ]);
  });

  it('never proposes two files for the same operation', () => {
    const { report, steps } = matchReceipts(
      [
        doc({ name: 'a.pdf', text: 'NIMBUS HOSTING', totals: [48], dates: ['2026-08-02'] }),
        doc({ name: 'b.pdf', text: 'NIMBUS HOSTING', totals: [48], dates: ['2026-08-02'] }),
      ],
      ops,
      { minScore: 0.8 },
    );
    expect(steps).toHaveLength(1);
    expect(report.ambiguous[0]!.reason).toContain('same operation as a.pdf');
  });

  it('respects --min-score', () => {
    const files = [doc({ name: 'x.pdf', totals: [48] })]; // amount only: score 0.65
    expect(matchReceipts(files, ops, { minScore: 0.6 }).steps).toHaveLength(1);
    expect(matchReceipts(files, ops, { minScore: 0.8 }).steps).toHaveLength(0);
  });
});

describe('real-use fixes', () => {
  it('targets only operations without a document by default; --include-attached opts in', () => {
    const stripe = op({
      id: 300,
      date: '2026-08-02',
      wording: 'STRIPE FICTIONAL',
      amount: 29,
      attachments: [{ name: 'Invoice-AB12-0007.pdf' }],
    });
    const other = op({
      id: 301,
      date: '2026-08-02',
      wording: 'ORBIT TOOLS',
      amount: 15,
      attachments: [{ name: 'orbit-aug.pdf' }],
    });
    const docs = [
      doc({
        name: 'Receipt-AB12-0007.pdf',
        text: 'STRIPE FICTIONAL',
        totals: [29],
        dates: ['2026-08-02'],
      }),
      doc({ name: 'orbit-receipt.pdf', text: 'ORBIT TOOLS', totals: [15], dates: ['2026-08-02'] }),
    ];
    const byDefault = matchReceipts(docs, [stripe, other], { minScore: 0.8 });
    // Invoice-N and Receipt-N with the same number are the same document.
    expect(byDefault.report.alreadyAttached).toEqual([
      { file: '/inbox/Receipt-AB12-0007.pdf', op: '300' },
    ]);
    expect(byDefault.report.alreadyDocumented).toEqual([
      expect.objectContaining({
        file: '/inbox/orbit-receipt.pdf',
        op: '301',
        existing: ['orbit-aug.pdf'],
      }),
    ]);
    expect(byDefault.steps).toEqual([]);
    const opted = matchReceipts(docs, [stripe, other], { minScore: 0.8, includeAttached: true });
    expect(opted.steps.map((s) => s.op)).toEqual(['301']);
  });

  it('documentKey treats invoice/receipt variants and opId prefixes as one document', () => {
    expect(documentKey('Invoice-AB12-0007.pdf')).toBe(documentKey('123_Receipt-AB12-0007.pdf'));
    expect(documentKey('facture_2026_0042.pdf')).toBe(documentKey('recu-2026-0042.pdf'));
    expect(documentKey('invoice.pdf')).toBeNull();
  });

  it('a date in the file name decides the billing period over dates in the text', async () => {
    const dir = tempHome();
    const file = join(dir, 'sentry-fictional-2026-07-20.pdf');
    // The text mentions the next period's date, as SaaS invoices do.
    writeFileSync(file, makePdf(['FICTIONAL SENTRY', 'Period ends 2026-08-19', 'Total 26,00 EUR']));
    const document = await readReceipt(file);
    expect(document).toMatchObject({ dates: ['2026-07-20'], dateSource: 'filename' });
    const july = op({ id: 310, date: '2026-07-20', wording: 'FICTIONAL SENTRY', amount: 26 });
    const august = op({ id: 311, date: '2026-08-20', wording: 'FICTIONAL SENTRY', amount: 26 });
    expect(scoreMatch(document, august).total).toBeLessThan(0.8);
    const { steps } = matchReceipts([document], [july, august], { minScore: 0.8 });
    expect(steps).toEqual([
      expect.objectContaining({ op: '310', why: expect.stringContaining('date +0d (file name)') }),
    ]);
  });

  it('honours the <opId>_ prefix: that operation, or a skip, never another one', () => {
    const named = op({ id: 320, date: '2026-01-05', wording: 'OLD THING', amount: 48 });
    const lookalike = op({ id: 321, date: '2026-08-02', wording: 'NIMBUS', amount: 48 });
    const attached = op({ id: 322, amount: 10, attachments: [{ name: 'inv-7.pdf' }] });
    const byId = new Map([named, attached].map((o) => [o.id, o]));
    const docs = [
      doc({ name: '320_nimbus.pdf', text: 'NIMBUS', totals: [48], dates: ['2026-08-02'] }),
      doc({ name: '322_inv-7.pdf', totals: [10] }),
      doc({ name: '999_nimbus.pdf', text: 'NIMBUS', totals: [48], dates: ['2026-08-02'] }),
    ];
    const { report, steps } = matchReceipts(docs, [named, lookalike, attached], {
      minScore: 0.8,
      byId,
    });
    expect(steps[0]).toMatchObject({ op: '320', why: expect.stringContaining('prefix') });
    expect(report.alreadyAttached).toEqual([{ file: '/inbox/322_inv-7.pdf', op: '322' }]);
    // 999 is not an operation: ordinary matching applies.
    expect(steps[1]).toMatchObject({ op: '321' });
  });
});

describe('opId prefix sanity check (N1)', () => {
  it('does not pin a file whose amount and date both disagree with the prefixed operation', () => {
    const named = op({ id: 330, date: '2026-01-05', wording: 'OLD THING', amount: 99 });
    const byId = new Map([[named.id, named]]);
    const unrelated = doc({
      name: '330_nimbus.pdf',
      text: 'NIMBUS',
      totals: [48],
      dates: ['2026-08-02'],
    });
    const related = doc({ name: '330_old-thing.pdf', totals: [99] });
    const { report, steps } = matchReceipts([unrelated, related], [named], { minScore: 0.8, byId });
    expect(report.ambiguous[0]).toMatchObject({
      file: '/inbox/330_nimbus.pdf',
      reason: expect.stringContaining("don't match"),
    });
    expect(steps).toEqual([
      expect.objectContaining({ op: '330', file: '/inbox/330_old-thing.pdf' }),
    ]);
  });
});
