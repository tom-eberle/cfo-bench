import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeOperation } from '../src/api/normalize.js';
import { rawTransactionSchema } from '../src/api/schemas.js';
import { documentAmountMismatch, findDuplicates } from '../src/workflows/close-check.js';
import { missingReceipt } from '../src/workflows/findings.js';
import {
  evaluateRules,
  inferRules,
  loadRules,
  planRules,
  type RulesFile,
  ruleMatches,
} from '../src/workflows/rules.js';
import { buildTodo, countByReason } from '../src/workflows/todo.js';
import { COMPANY, type OpOptions, rawCategoryMap, rawOp } from './helpers/fixtures.js';
import { tempHome } from './helpers/run.js';

const toRecord = (o: OpOptions) => {
  const raw = rawTransactionSchema.parse(rawOp(o));
  return {
    raw,
    op: normalizeOperation(raw, {
      company: COMPANY,
      apiBase: 'https://compta.example.test',
      categories: rawCategoryMap(),
      accounts: new Map([['501', 'Main account']]),
    }),
  };
};
const op = (o: OpOptions) => toRecord(o).op;

const rules: RulesFile = {
  rules: [
    {
      name: 'cloud',
      match: { wording: 'FICTICLOUD', direction: 'expense' },
      set: { category: 77, vatExempt: 'outside-eu' },
    },
    { match: { wording: '/^PRLV NIMBUS/i' }, set: { category: 77, vatExempt: 'inside-eu' } },
    { match: { amountMin: 1000, account: 'main' }, set: { memo: 'Large payment, check contract' } },
  ],
  vendors: [],
  noReceiptCategories: [],
};

describe('rule matching', () => {
  it('supports substrings (case/accent-insensitive), regexes, direction, amounts and account', () => {
    expect(ruleMatches(rules.rules[0]!, op({ wording: 'CB Ficticloud.com' }))).toBe(true);
    expect(ruleMatches(rules.rules[0]!, op({ wording: 'CB Ficticloud.com', income: true }))).toBe(
      false,
    );
    expect(ruleMatches(rules.rules[1]!, op({ wording: 'prlv nimbus hosting' }))).toBe(true);
    expect(ruleMatches(rules.rules[1]!, op({ wording: 'CB NIMBUS' }))).toBe(false);
    expect(ruleMatches(rules.rules[2]!, op({ amount: 1500 }))).toBe(true);
    expect(ruleMatches(rules.rules[2]!, op({ amount: 999 }))).toBe(false);
  });

  it('only proposes fields that differ, and the first matching rule wins', () => {
    const outcome = evaluateRules(
      rules,
      op({ wording: 'FICTICLOUD', category: 'software', vatRate: 20 }),
    );
    expect(outcome).toMatchObject({ index: 0, changes: { vatExempt: 'outside-eu' } });
    expect(outcome?.changes).not.toHaveProperty('category');
    expect(
      evaluateRules(rules, op({ wording: 'FICTICLOUD', exemption: 'purchase_non_eu' })),
    ).toMatchObject({
      changes: null,
    });
  });

  it('plans steps with expectations and reports compliant/blocked operations', () => {
    const result = planRules(
      { ...rules, rules: [{ match: { wording: 'NIMBUS' }, set: { vatExempt: 'inside-eu' } }] },
      [
        toRecord({ id: 1, wording: 'PRLV NIMBUS', vatRate: 20 }),
        toRecord({
          id: 2,
          wording: 'PRLV NIMBUS',
          exemption: 'purchase_eu',
        }),
        toRecord({ id: 3, wording: 'PRLV NIMBUS', category: 'uncategorized', vatRate: null }),
        toRecord({ id: 4, wording: 'SOMETHING ELSE' }),
      ],
    );
    expect(result).toMatchObject({
      matched: 3,
      compliant: 1,
      blocked: [{ op: '3', reason: expect.stringContaining('category') }],
    });
    expect(result.steps).toEqual([
      {
        op: '1',
        action: 'set',
        set: { vatExempt: 'inside-eu' },
        expect: expect.objectContaining({ vatAmount: 8 }),
        why: expect.stringContaining('PRLV NIMBUS'),
      },
    ]);
  });

  it('validates rules files with helpful errors', async () => {
    const dir = tempHome();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ rules: [{ match: {}, set: { category: 77 } }] }));
    await expect(loadRules(bad)).rejects.toMatchObject({
      code: 'RULES_INVALID',
      message: expect.stringContaining('match'),
    });
    await expect(loadRules(join(dir, 'missing.json'))).rejects.toMatchObject({
      hint: 'create one with: compta rules init',
    });
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ rules: rules.rules }));
    expect((await loadRules(good)).rules).toMatchObject({ vendors: [], noReceiptCategories: [] });
  });
});

describe('rules init', () => {
  it('infers the dominant category and exemption per merchant', () => {
    const history = [
      ...Array.from({ length: 4 }, (_, i) =>
        op({
          id: 100 + i,
          wording: `CB FICTICLOUD ${i}0/08`,
          exemption: 'purchase_non_eu',
        }),
      ),
      op({ id: 110, wording: 'CB FICTICLOUD', category: 'ads' }),
      op({ id: 120, wording: 'PRLV RANDOM ONE' }),
      ...Array.from({ length: 3 }, (_, i) =>
        op({ id: 130 + i, wording: 'CB MIXED SHOP', category: i ? 'ads' : 'software' }),
      ),
    ];
    const inferred = inferRules(history);
    expect(inferred).toEqual([
      {
        name: 'FICTICLOUD → Logiciels et abonnements',
        match: { wording: 'FICTICLOUD', direction: 'expense' },
        set: { category: 77, vatExempt: 'outside-eu' },
        stats: { operations: 5, agreement: 0.8 },
      },
    ]);
  });
});

describe('todo and close-check helpers', () => {
  it('builds a worklist with machine-readable reasons and suggestions', () => {
    const items = buildTodo(
      [
        toRecord({ id: 1, wording: 'CB FICTICLOUD', amount: 240, vatRate: 20, validated: false }),
        toRecord({
          id: 2,
          wording: 'CB SHOP',
          amount: 20,
          category: 'uncategorized',
          vatRate: null,
          attachments: [{ name: 'r.pdf' }],
        }),
        toRecord({ id: 3, wording: 'CB ALL GOOD', attachments: [{ name: 'ok.pdf' }] }),
      ],
      { rules },
    );
    expect(items.map((i) => i.op?.id)).toEqual(['1', '2']);
    expect(items[0]!.reasons.map((r) => r.code)).toEqual([
      'MISSING_RECEIPT',
      'UNVALIDATED',
      'RULE_MATCH',
    ]);
    expect(items[0]!.reasons[0]).toMatchObject({
      severity: 'error',
      detail: expect.stringContaining('150'),
    });
    expect(items[0]!.suggestion).toEqual([
      expect.objectContaining({ action: 'set', set: { vatExempt: 'outside-eu' } }),
    ]);
    expect(countByReason(items)).toMatchObject({
      MISSING_RECEIPT: 1,
      UNCATEGORIZED: 1,
      UNVALIDATED: 1,
      RULE_MATCH: 1,
    });
  });

  it('does not ask for receipts on income, tiny amounts or transfer categories', () => {
    const policy = { noReceiptCategories: new Set([77]) };
    expect(
      missingReceipt(op({ income: true, category: 'sales' }), { noReceiptCategories: new Set() }),
    ).toBeNull();
    expect(missingReceipt(op({ amount: 0.5 }), { noReceiptCategories: new Set() })).toBeNull();
    expect(missingReceipt(op({ amount: 50 }), policy)).toBeNull();
    expect(missingReceipt(op({ amount: 50 }), { noReceiptCategories: new Set() })).toMatchObject({
      severity: 'warning',
    });
  });

  it('finds possible duplicates: same merchant and amount within 3 days', () => {
    const dupes = findDuplicates([
      op({ id: 1, date: '2026-08-01', wording: 'CB ORBIT TOOLS', amount: 19.99 }),
      op({ id: 2, date: '2026-08-03', wording: 'CB ORBIT TOOLS 03/08', amount: 19.99 }),
      op({ id: 3, date: '2026-08-20', wording: 'CB ORBIT TOOLS', amount: 19.99 }),
      op({ id: 4, date: '2026-08-02', wording: 'CB ORBIT TOOLS', amount: 19.99, income: true }),
    ]);
    expect(dupes.map((d) => [d.op?.id, d.related, d.severity])).toEqual([['2', ['1'], 'info']]);
    const twin = findDuplicates([
      op({ id: 5, date: '2026-08-01', wording: 'CB ORBIT TOOLS', amount: 9 }),
      op({ id: 6, date: '2026-08-01', wording: 'CB ORBIT TOOLS', amount: 9 }),
    ]);
    expect(twin[0]).toMatchObject({
      severity: 'warning',
      detail: expect.stringContaining('same wording'),
    });
  });

  it('checks document totals in EUR, or against the original currency amount only', () => {
    const ev = (totals: number[], currency: string) => ({
      source: 'pdf' as const,
      zone: null,
      vatAmount: null,
      chargesVat: false,
      reverseCharge: false,
      totals,
      currency,
    });
    const eur = op({ amount: 120 });
    expect(documentAmountMismatch(eur, ev([100], 'EUR'))).toBeNull(); // HT
    expect(documentAmountMismatch(eur, ev([99], 'EUR'))).toMatchObject({
      code: 'DOCUMENT_AMOUNT_MISMATCH',
    });
    expect(documentAmountMismatch(eur, ev([130], 'USD'))).toBeNull(); // conversion unknown
    const fx = op({ amount: 92.4, original: { amount: 100, currency: 'USD' } });
    expect(documentAmountMismatch(fx, ev([100], 'USD'))).toBeNull();
    expect(documentAmountMismatch(fx, ev([400], 'USD'))).toMatchObject({
      detail: expect.stringContaining('400.00 USD'),
    });
  });
});
