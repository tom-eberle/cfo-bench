import { describe, expect, it } from 'vitest';
import { addDays } from '../src/util/dates.js';
import { FakeCompta } from './helpers/fake-api.js';
import { rawOp } from './helpers/fixtures.js';
import { comptaFor } from './helpers/run.js';

/** 100 validated ops, one per day back from 2026-08-31, plus 5 pending ones. */
function history() {
  const ops = Array.from({ length: 100 }, (_, i) =>
    rawOp({
      id: 1000 + i,
      date: addDays('2026-08-31', -i),
      wording: i % 2 ? 'CB ORBIT TOOLS' : 'PRLV NIMBUS HOSTING',
    }),
  );
  const pending = Array.from({ length: 5 }, (_, i) =>
    rawOp({ id: 2000 + i, date: addDays('2026-09-05', -i), validated: false }),
  );
  return new FakeCompta([...ops, ...pending]);
}

describe('listOperations', () => {
  it('merges validated and pending lists, newest first', async () => {
    const api = history();
    const records = await comptaFor(api).listOperations();
    expect(records).toHaveLength(105);
    expect(records[0]!.op.date).toBe('2026-09-05');
    expect(records.map((r) => r.op.date)).toEqual(
      [...records.map((r) => r.op.date)].sort().reverse(),
    );
  });

  it('stops paging once a page ends before --from (lists are date-descending)', async () => {
    const api = history();
    const records = await comptaFor(api).listOperations({
      status: 'validated',
      from: '2026-08-20',
    });
    expect(records).toHaveLength(12);
    expect(api.pagesFetched(true)).toBe(1);
  });

  it('stops paging once --limit matches are certain', async () => {
    const api = history();
    const records = await comptaFor(api).listOperations({ status: 'validated', limit: 45 });
    expect(records).toHaveLength(45);
    expect(api.pagesFetched(true)).toBe(2);
  });

  it('filters locally by search (accent/case-insensitive), direction, category and receipts', async () => {
    const api = new FakeCompta([
      rawOp({ id: 1, wording: 'Café Étoile', category: 'ads' }),
      rawOp({ id: 2, wording: 'CAFE ETOILE', attachments: [{ name: 'r.pdf' }] }),
      rawOp({ id: 3, wording: 'Client payment', income: true, category: 'sales' }),
      rawOp({ id: 4, wording: 'Deleted thing', deleted: true }),
    ]);
    const compta = comptaFor(api);
    expect(
      (await compta.listOperations({ search: 'cafe etoile' })).map((r) => r.op.id).sort(),
    ).toEqual(['1', '2']);
    expect((await compta.listOperations({ direction: 'income' })).map((r) => r.op.id)).toEqual([
      '3',
    ]);
    expect((await compta.listOperations({ category: 69 })).map((r) => r.op.id)).toEqual(['1']);
    expect(
      (await compta.listOperations({ missingReceipt: true, direction: 'expense' }))
        .map((r) => r.op.id)
        .sort(),
    ).toEqual(['1']);
    expect((await compta.listOperations()).some((r) => r.op.id === '4')).toBe(false);
  });
});
