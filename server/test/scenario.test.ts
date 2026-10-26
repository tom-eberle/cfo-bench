/**
 * The server on the benchmark scenario (scenarios/atelier-lumen-s1): the CA3 computation against
 * the boxes stored in the scenario, and server recomputations on the scenario's data.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ca3Boxes } from '../src/ca3.ts';
import { FakeCompta, validationProblems } from '../src/compta.ts';
import { type Transaction, loadScenario } from '../src/scenario.ts';
import { ATELIER, BASE, MINI } from './helpers.ts';

const loaded = loadScenario(ATELIER);
const { scenario } = loaded;
const categories = new Map(scenario.categories.map((c) => [c.id, c]));
const C = `/v1/companies/${scenario.company.id}`;
type Any = Record<string, any>;

function fake(): FakeCompta {
  return new FakeCompta(loadScenario(ATELIER));
}

async function call(api: FakeCompta, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await api.handle(
    new Request(new URL(path, BASE), {
      method,
      headers: { authorization: `Bearer ${scenario.api_token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const month = (r: { summary: Any }) => String(r.summary.period_start).slice(0, 7);
const txsOf = (m: string) => scenario.transactions.filter((t) => t.date.startsWith(m)) as Transaction[];

describe('CA3: computed boxes = stored returns (atelier-lumen-s1)', () => {
  it('reproduces every stored return box by box (filed returns chained, open ones from the last filed)', () => {
    let previous: number | null = null;
    let lastFiled: number | null = null;
    assert.equal(scenario.vat_returns.length, 12);
    for (const r of scenario.vat_returns) {
      const filed = r.status === 'filed';
      const boxes = ca3Boxes(txsOf(month(r)), scenario.categories, filed ? previous : lastFiled);
      assert.deepEqual(boxes, r.boxes, `CA3 ${month(r)}`);
      if (filed) previous = lastFiled = boxes['27']!;
    }
  });

  it('serves the open months’ boxes recomputed from the transactions, equal to the stored ones initially', async () => {
    const api = fake();
    const open = scenario.vat_returns.filter((r) => r.status !== 'filed');
    assert.deepEqual(open.map(month), ['2026-07', '2026-08', '2026-09']);
    for (const r of open) {
      const served = (await call(api, 'GET', `${C}/vat-returns/${r.summary.id}`)).body;
      assert.deepEqual(served.boxes, r.boxes, `open ${month(r)}`);
      assert.equal(served.net_amount, r.summary.net_amount);
      assert.deepEqual({ ...served, boxes: undefined }, { ...r.summary, boxes: undefined });
    }
  });

  it('open boxes follow an edit; filed boxes never move', async () => {
    const api = fake();
    const truth = JSON.parse(readFileSync(join(ATELIER, 'truth.json'), 'utf8'));
    const txId = truth.issues.find((i: Any) => i.id === 'RC-OPEN-4').op as string; // Anthropic, 2026-09
    const sept = scenario.vat_returns.find((r) => month(r) === '2026-09')!;
    const before = (await call(api, 'GET', `${C}/vat-returns/${sept.summary.id}`)).body.boxes;
    const tx = (await call(api, 'GET', `${C}/transactions/${txId}`)).body;
    const line = tx.lines[0];
    assert.deepEqual([line.amount, line.tax.amount], [91.63, 15.27]);
    const exempt = {
      ...line,
      tax: { treatment: 'exempt', rate: null, amount: 0, exemption_reason: 'purchase_non_eu', overridden: true },
    };
    assert.equal((await call(api, 'PATCH', `${C}/transactions/${txId}`, { lines: [exempt] })).status, 200);

    const after = (await call(api, 'GET', `${C}/vat-returns/${sept.summary.id}`)).body;
    // 91.63 € of non-EU services self-assessed at 20 % (18.33 €), no longer 15.27 € of French VAT.
    assert.deepEqual(
      ['A3_non_eu', '20_non_eu_reverse_charge', '08', '20_domestic'].map((box) => [box, before[box], after.boxes[box]]),
      [
        ['A3_non_eu', 0, 92],
        ['20_non_eu_reverse_charge', 0, 18],
        ['08', before['08'], before['08'] + 92],
        ['20_domestic', before['20_domestic'], before['20_domestic'] - 15],
      ],
    );
    assert.equal(after.net_amount, after.boxes['28'] || -after.boxes['27']);
    const listed = (await call(api, 'GET', `${C}/vat-returns?status=upcoming&limit=200&offset=0`)).body;
    assert.equal(listed[0].net_amount, after.net_amount);
    const state = api.state().vat_returns as Any[];
    assert.deepEqual(state.find((r) => r.summary.id === sept.summary.id).boxes, after.boxes);
    const june = scenario.vat_returns.find((r) => month(r) === '2026-06')!;
    assert.deepEqual((await call(api, 'GET', `${C}/vat-returns/${june.summary.id}`)).body.boxes, june.boxes);
  });

  it('excluded and deleted transactions count nowhere', () => {
    const july = txsOf('2026-07');
    const base = ca3Boxes(july, scenario.categories, null);
    const sale = july.find((t) => t.direction === 'in' && t.lines.some((l) => l.tax.amount > 0))!;
    for (const status of ['excluded', 'deleted'] as const) {
      const edited = july.map((t) => (t === sale ? { ...t, status } : t));
      assert.notDeepEqual(ca3Boxes(edited, scenario.categories, null), base, status);
      const without = july.filter((t) => t !== sale);
      assert.deepEqual(ca3Boxes(edited, scenario.categories, null), ca3Boxes(without, scenario.categories, null));
    }
  });

  it('box 22 comes from the latest filed CA3 before the period (latest confirmation wins on ties)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fcb-mini-'));
    const mini = JSON.parse(readFileSync(join(MINI, 'scenario.json'), 'utf8'));
    // A second filed June return confirmed later, with another credit.
    const june = mini.vat_returns[0];
    mini.vat_returns.push({
      ...june,
      summary: { ...june.summary, id: 62, confirmed_at: '2026-07-19T09:00:00.000Z' },
      boxes: { ...june.boxes, '27': 33 },
    });
    mini.files = {};
    for (const t of mini.transactions) t.attachments = [];
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify(mini));
    const api = new FakeCompta(loadScenario(dir));
    const res = await api.handle(
      new Request(new URL(`/v1/companies/${mini.company.id}/vat-returns/71`, BASE), {
        headers: { authorization: `Bearer ${mini.api_token}` },
      }),
    );
    assert.equal((await res.json()).boxes['22'], 33);
  });
});

describe('the scenario loader (API.md §10)', () => {
  function write(mutate: (s: Any) => void): string {
    const dir = mkdtempSync(join(tmpdir(), 'fcb-scenario-'));
    const s = JSON.parse(readFileSync(join(MINI, 'scenario.json'), 'utf8'));
    s.files = {};
    mutate(s);
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify(s));
    return dir;
  }

  it('loads a directory or a .json path, and defaults optional maps', () => {
    const dir = write((s) => {
      delete s.purchase_invoices;
      delete s.files;
      delete s.transactions[0].attachments;
    });
    const fromDir = loadScenario(dir);
    assert.deepEqual([fromDir.scenario.purchase_invoices, fromDir.scenario.files], [{}, {}]);
    assert.deepEqual(fromDir.scenario.transactions[0]!.attachments, []);
    assert.equal(loadScenario(join(dir, 'scenario.json')).path, join(dir, 'scenario.json'));
  });

  it('refuses invalid scenarios', () => {
    const cases: [string, (s: Any) => void][] = [
      ['schema_version must be 2', (s) => (s.schema_version = 1)],
      ['schema_version must be 2', (s) => delete s.schema_version],
      ['api_token must be', (s) => (s.api_token = 'short')],
      ['api_token must be', (s) => delete s.api_token],
      ['company.id must be a number', (s) => (s.company.id = '999999')],
      ['user.id must be a number', (s) => delete s.user.id],
      ['transactions must be an array', (s) => (s.transactions = {})],
      ['vat_returns must be an array', (s) => delete s.vat_returns],
      ['duplicate transaction id', (s) => (s.transactions[1].id = s.transactions[0].id)],
      ['bad or duplicate transaction id', (s) => (s.transactions[0].id = '1001')],
      ['has no lines', (s) => delete s.transactions[0].lines],
      ['unknown status completed', (s) => (s.vat_returns[0].status = 'completed')],
      ['outside the scenario directory', (s) => (s.files = { k: '../escape.pdf' })],
    ];
    for (const [message, mutate] of cases) assert.throws(() => loadScenario(write(mutate)), new RegExp(message), message);
  });
});

describe('generated transactions under the server’s update rules', () => {
  it('the stored deductible VAT is what the server would recompute', () => {
    const share = new Map(scenario.categories.map((c) => [c.id, c.deductible_share ?? 1]));
    const off: string[] = [];
    for (const tx of scenario.transactions)
      for (const l of tx.lines) {
        const v = Math.round(l.tax.amount * (l.category_id === null ? 1 : share.get(l.category_id)!) * 100) / 100;
        if (v !== l.tax.deductible) off.push(`${tx.id}/${l.id}`);
      }
    assert.deepEqual(off, []);
  });

  it('every generated tax is coherent: a reason exactly on exempt lines, which carry no VAT', () => {
    const off: string[] = [];
    for (const tx of scenario.transactions)
      for (const { id, tax: t } of tx.lines) {
        const exempt = t.treatment === 'exempt';
        if (exempt !== (t.exemption_reason !== null) || (exempt && (t.amount !== 0 || t.rate !== null)))
          off.push(`${tx.id}/${id}`);
      }
    assert.deepEqual(off, []);
  });

  it('every validated transaction passes the validation rules', () => {
    const bad = scenario.transactions
      .filter((tx) => tx.validated)
      .map((tx) => [tx.id, validationProblems(tx, categories)] as const)
      .filter(([, problems]) => problems.length);
    assert.deepEqual(bad, []);
  });

  it('a no-op PATCH changes nothing on any generated transaction', async () => {
    const api = fake();
    for (const tx of scenario.transactions.filter((t) => !t.lock?.period).slice(0, 400)) {
      const r = await call(api, 'PATCH', `${C}/transactions/${tx.id}`, {});
      assert.equal(r.status, 200, String(tx.id));
      assert.equal((api.log.records.at(-1) as Any).changed, false, String(tx.id));
    }
  });

  it('serves categories without deductible_share, with their exemption policy', async () => {
    const api = fake();
    const full = (await call(api, 'GET', `${C}/categories?view=full`)).body as Any[];
    assert.equal(full.length, scenario.categories.length);
    assert.ok(full.every((c) => !('deductible_share' in c) && c.id > 0));
    assert.ok(full.every((c) => c.exemptions === (c.default_vat ? 'allowed' : 'unavailable')));
    assert.equal(full.find((c) => c.label === "Apport en compte courant d'associé").ledger_account, '455000');
    const me = (await call(api, 'GET', '/v1/me')).body;
    assert.deepEqual(me.companies, scenario.user.companies);
  });

  it('honours a 0 % deductible share (travel) when recomputing after an edit', async () => {
    const api = fake();
    const travel = scenario.categories.find((c) => c.label === 'Transports et déplacements')!;
    assert.equal(travel.deductible_share, 0);
    const tx = (await call(api, 'GET', `${C}/transactions/4100290`)).body; // CB SNCF CONNECT, 2026-07
    assert.equal(tx.lines[0].category_id, travel.id);
    const reopened = (await call(api, 'PATCH', `${C}/transactions/4100290`, { validated: false })).body;
    const line = { ...reopened.lines[0], tax: { ...reopened.lines[0].tax, amount: 30, overridden: true } };
    const edited = (await call(api, 'PATCH', `${C}/transactions/4100290`, { lines: [line] })).body;
    const e = edited.lines[0];
    assert.deepEqual([e.tax.amount, e.tax.deductible], [30, 0]);
  });
});
