import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeCompta } from './helpers/fake-api.js';
import { COMPANY, rawOp } from './helpers/fixtures.js';
import { makePdf } from './helpers/pdf.js';
import { runCli, tempHome } from './helpers/run.js';

function august() {
  const api = new FakeCompta([
    rawOp({ id: 201, date: '2026-08-02', wording: 'PRLV NIMBUS HOSTING', amount: 48, vatRate: 20 }),
    rawOp({
      id: 202,
      date: '2026-08-05',
      wording: 'CB FICTIONAL SAAS INC',
      amount: 120,
      vatRate: 20,
      attachments: [{ name: 'saas-aug.pdf', vendorInvoiceId: 'vi-202' }],
    }),
    rawOp({
      id: 203,
      date: '2026-08-09',
      wording: 'CLOUDFLARE',
      amount: 24,
      vatRate: 20,
      attachments: [{ name: 'cf.pdf' }],
    }),
    rawOp({
      id: 204,
      date: '2026-08-12',
      wording: 'CLIENT ACME',
      amount: 1200,
      income: true,
      category: 'sales',
      vatRate: 20,
    }),
    rawOp({
      id: 205,
      date: '2026-08-14',
      wording: 'CB PAPER CO',
      amount: 12,
      validated: false,
      category: 'uncategorized',
      vatRate: null,
    }),
  ]);
  api.purchaseInvoices.set('vi-202', {
    id: 'vi-202',
    extraction_status: 'done',
    total_amount: 120,
    vat_amount: 0,
    currency: 'EUR',
    supplier: { name: null, country: 'US', vat_number: null },
    vat_lines: [{ rate: 0.2, vat_amount: 20, tax_category: 'AE' }],
  });
  api.files.set(
    `/00000000-0000-4000-8000-${String(203 * 100).padStart(12, '0')}`,
    makePdf(['Synthetic invoice', 'Total 24.00 EUR', 'VAT 0.00 EUR', 'Reverse charge']),
  );
  return api;
}

describe('todo', () => {
  it('lists actionable operations and writes fixable ones to a plan', async () => {
    const api = august();
    const dir = tempHome();
    const plan = join(dir, 'todo.plan.json');
    const r = await runCli(api, ['todo', '--plan', plan]);
    expect(r.code).toBe(0);
    const items = r.json() as {
      op: { id: string } | null;
      reasons: { code: string; rule?: string }[];
    }[];
    const byId = Object.fromEntries(
      items.map((i) => [i.op?.id, i.reasons.map((x) => x.rule ?? x.code)]),
    );
    expect(byId['203']).toEqual(['REVERSE_CHARGE_SUSPECT']);
    expect(byId['205']).toEqual(['MISSING_RECEIPT', 'UNCATEGORIZED', 'UNVALIDATED']);
    expect(byId['201']).toEqual(['MISSING_RECEIPT']);
    expect(byId['204']).toBeUndefined();
    // The only VAT fix rests on the built-in vendor list (weak evidence): not planned by default.
    expect(JSON.parse(readFileSync(plan, 'utf8'))).toMatchObject({
      version: 1,
      company: COMPANY,
      steps: [],
    });
    await runCli(api, ['todo', '--plan', plan, '--include-warnings']);
    expect(JSON.parse(readFileSync(plan, 'utf8')).steps).toEqual([
      expect.objectContaining({
        id: 's1',
        op: '203',
        action: 'set',
        set: { vatExempt: 'outside-eu' },
      }),
    ]);
  });

  it('renders a grouped table in a terminal', async () => {
    const r = await runCli(august(), ['todo', '--no-color'], { stdoutIsTTY: true });
    expect(r.stdout).toContain('Missing receipt (2)');
    expect(r.stdout).toContain('VAT to check (1)');
    expect(r.stdout).toContain(
      '3 items need attention: 2 missing receipts · 1 uncategorized · 1 to validate · 1 VAT to check',
    );
  });
});

describe('vat check', () => {
  it('uses Compta invoice data and PDFs, and the plan fixes them through apply', async () => {
    const api = august();
    const dir = tempHome();
    const plan = join(dir, 'vat.plan.json');
    const r = await runCli(api, [
      'vat',
      'check',
      '--from',
      '2026-08-01',
      '--to',
      '2026-08-31',
      '--plan',
      plan,
    ]);
    expect(r.code).toBe(0);
    const report = r.json() as {
      meta: Record<string, unknown>;
      findings: {
        code: string;
        op: { id: string };
        evidence?: { document?: { source: string } };
      }[];
    };
    // 202: Compta read a US supplier with reverse-charge code AE (strong). 203: only the
    // built-in vendor list (the PDF says reverse charge but names no country): weak.
    expect(report.meta).toMatchObject({
      operations: 5,
      documentsChecked: 2,
      fixes: 1,
      weakFixes: 1,
    });
    const suspects = report.findings.filter((f) => f.code === 'REVERSE_CHARGE_SUSPECT');
    expect(suspects.map((f) => [f.op.id, f.evidence?.document?.source ?? null])).toEqual([
      ['203', 'pdf'],
      ['202', 'vendor-invoice'],
    ]);
    const apply = await runCli(api, ['apply', plan, '--yes']);
    expect(apply.code).toBe(0);
    expect(apply.json()).toMatchObject({ meta: { applied: 1 }, results: [{ op: '202' }] });
    const range = ['--from', '2026-08-01', '--to', '2026-08-31'];
    await runCli(api, ['vat', 'check', ...range, '--plan', plan, '--include-warnings']);
    expect((await runCli(api, ['apply', plan, '--yes'])).json()).toMatchObject({
      meta: { applied: 1 },
    });
    const after = await runCli(api, ['vat', 'check', ...range]);
    expect((after.json() as { findings: unknown[] }).findings).toEqual([]);
  });
});

describe('vat summary', () => {
  it('estimates the CA3 and compares with the filed declaration', async () => {
    const api = august();
    api.vatReturns.push(
      {
        summary: {
          id: 71,
          return_type: 'CA3',
          form_year: 2026,
          title: 'TVA - Août 2026',
          period_start: '2026-08-01',
          period_end: '2026-08-31',
        },
        boxes: { '08': 1000, '08_tax': 200, A1: 1000, '16': 200, '20': 50 },
      },
      {
        summary: {
          id: 70,
          return_type: 'CA3',
          form_year: 2026,
          title: 'TVA - Juillet 2026',
          period_start: '2026-07-01',
          period_end: '2026-07-31',
        },
        boxes: { '27': 30 },
      },
    );
    const r = await runCli(api, ['vat', 'summary', '--month', '2026-08']);
    expect(r.code).toBe(0);
    const s = r.json() as {
      meta: Record<string, unknown>;
      lines: {
        box: string;
        estimate: number | null;
        declared: number | null;
        difference: number | null;
      }[];
    };
    expect(s.meta).toMatchObject({
      month: '2026-08',
      estimate: true,
      operations: 5,
      unvalidated: 1,
      declaration: { id: '71', filed: true },
    });
    const line = (box: string) => s.lines.find((l) => l.box === box);
    expect(line('A1')).toMatchObject({ estimate: 1000, declared: 1000, difference: 0 });
    expect(line('08:VAT')).toMatchObject({ declared: 200 });
    expect(line('22')).toMatchObject({ estimate: 30 });
    expect(line('20')).toMatchObject({ estimate: 32, declared: 50, difference: -18 });
  });

  it('requires a valid --month', async () => {
    expect((await runCli(august(), ['vat', 'summary', '--month', '2026-13'])).code).toBe(2);
    expect((await runCli(august(), ['vat', 'summary'])).error().message).toContain('--month');
  });
});

describe('receipts', () => {
  it('matches local PDFs and attaches them through a plan', async () => {
    const api = august();
    const dir = tempHome();
    const inbox = join(dir, 'inbox');
    mkdirSync(inbox);
    writeFileSync(
      join(inbox, 'nimbus-2026-08.pdf'),
      makePdf(['NIMBUS HOSTING GMBH', 'Invoice date 2026-08-01', 'Total TTC 48,00 EUR']),
    );
    writeFileSync(
      join(inbox, 'unknown.pdf'),
      makePdf(['Some vendor', 'Total 777,00 EUR', 'Date 2026-08-03']),
    );
    writeFileSync(join(inbox, 'notes.txt'), 'ignored');
    const plan = join(dir, 'receipts.plan.json');
    const r = await runCli(api, ['receipts', 'match', inbox, '--plan', plan]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      meta: { files: 2, matched: 1, unmatched: 1, ambiguous: 0 },
      matched: [{ best: { op: '201' } }],
      unmatched: [{ detected: { totals: [777] } }],
    });
    const written = JSON.parse(readFileSync(plan, 'utf8'));
    expect(written.steps).toEqual([
      expect.objectContaining({ op: '201', action: 'attach', file: './inbox/nimbus-2026-08.pdf' }),
    ]);
    expect((await runCli(api, ['apply', plan, '--yes'])).code).toBe(0);
    expect(api.ops.get('201')!.attachments.map((a) => a.document.file?.name)).toEqual([
      'nimbus-2026-08.pdf',
    ]);
    const again = await runCli(api, ['receipts', 'match', inbox]);
    expect(again.json()).toMatchObject({ meta: { alreadyAttached: 1, matched: 0 } });
  });

  it('downloads attachments as <opId>_<filename> and skips existing files', async () => {
    const api = august();
    const out = join(tempHome(), 'receipts');
    const r = await runCli(api, ['receipts', 'download', '--from', '2026-08-01', '-o', out]);
    const results = r.json() as { status: string }[];
    expect(results.map((x) => x.status).sort()).toEqual(['downloaded', 'failed']); // vi-202 has no stored file
    expect(readdirSync(out)).toEqual(['203_cf.pdf']);
    const again = await runCli(api, ['ops', 'download', '203', '-o', out]);
    expect(again.json()).toEqual([expect.objectContaining({ status: 'skipped' })]);
    const storage = api.requests.filter((q) => q.path.startsWith('/storage/00000000-'));
    expect(storage.length).toBeGreaterThan(0);
    expect(storage.every((q) => !q.headers.get('authorization') && !q.headers.get('cookie'))).toBe(
      true,
    );
    expect(api.storageFetches.every((f) => !f.hadCredentials)).toBe(true);
  });
});

describe('rules', () => {
  it('init writes a starter file from history; apply turns it into a plan', async () => {
    const api = new FakeCompta([
      ...[1, 2, 3].map((i) =>
        rawOp({
          id: 300 + i,
          date: `2026-07-0${i}`,
          wording: 'CB FICTICLOUD',
          exemption: 'purchase_non_eu',
        }),
      ),
      rawOp({
        id: 310,
        date: '2026-08-20',
        wording: 'CB FICTICLOUD',
        vatRate: 20,
        validated: false,
      }),
    ]);
    const dir = tempHome();
    const file = join(dir, 'compta.rules.json');
    const init = await runCli(api, ['rules', 'init', '-o', file, '--from', '2026-01-01']);
    expect(init.json()).toMatchObject({ rules: 1, operations: 3 });
    expect(JSON.parse(readFileSync(file, 'utf8')).rules[0]).toEqual({
      name: 'FICTICLOUD → Logiciels et abonnements',
      match: { wording: 'FICTICLOUD', direction: 'expense' },
      set: { category: 77, vatExempt: 'outside-eu' },
    });
    expect((await runCli(api, ['rules', 'init', '-o', file])).code).toBe(2);

    const plan = join(dir, 'rules.plan.json');
    const apply = await runCli(api, [
      'rules',
      'apply',
      '--rules',
      file,
      '--unvalidated-only',
      '--plan',
      plan,
    ]);
    expect(apply.json()).toMatchObject({
      meta: { operations: 1, matched: 1, steps: 1 },
      steps: [{ op: '310', set: { vatExempt: 'outside-eu' } }],
    });
    expect(existsSync(plan)).toBe(true);
  });

  it('explains a missing rules file', async () => {
    const r = await runCli(new FakeCompta(), [
      'rules',
      'apply',
      '--rules',
      '/nonexistent/rules.json',
    ]);
    expect(r.code).toBe(2);
    expect(r.error()).toMatchObject({
      code: 'RULES_INVALID',
      hint: 'create one with: compta rules init',
    });
  });
});

describe('close-check', () => {
  it('reports findings for the Compta fiscal year with counts in meta, exit 0', async () => {
    const api = new FakeCompta([
      rawOp({ id: 401, date: '2025-06-01', wording: 'CB ORBIT TOOLS', amount: 19.99 }),
      rawOp({ id: 402, date: '2025-06-02', wording: 'CB ORBIT TOOLS', amount: 19.99 }),
      rawOp({
        id: 403,
        date: '2025-07-01',
        wording: 'CB BIG LAPTOP',
        amount: 1800,
        category: 'equipment',
        attachments: [{ name: 'wrong.pdf' }],
      }),
      rawOp({ id: 404, date: '2024-12-01', wording: 'OUTSIDE YEAR', amount: 10 }),
    ]);
    api.files.set(
      `/00000000-0000-4000-8000-${String(403 * 100).padStart(12, '0')}`,
      makePdf(['Invoice', 'Total 49,00 EUR']),
    );
    const r = await runCli(api, ['close-check', '--year', '2025']);
    expect(r.code).toBe(0);
    const report = r.json() as {
      meta: { from: string; to: string; operations: number; counts: Record<string, number> };
    };
    expect(report.meta).toMatchObject({ from: '2025-03-01', to: '2025-12-31', operations: 3 });
    expect(report.meta.counts).toEqual({
      MISSING_RECEIPT: 2,
      POSSIBLE_DUPLICATE: 1,
      DOCUMENT_AMOUNT_MISMATCH: 1,
    });
  });
});

describe('resources', () => {
  it('exports CSV with the documented columns', async () => {
    const r = await runCli(august(), ['export', '--from', '2026-08-10']);
    const [header, ...rows] = r.stdout.trim().split('\n');
    expect(header).toBe(
      'date,wording,amount_ttc,amount_ht,vat,vat_rate,is_expense,category,category_group,memo,validated,has_receipt,compta_id',
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toBe(
      '2026-08-12,CLIENT ACME,1200,1000,200,20,false,Prestations de services,Ventes,,true,false,204',
    );
  });

  it('lists categories and accounts', async () => {
    const cats = (
      await runCli(august(), ['categories', 'list', '--search', 'logiciel'])
    ).json() as { id: number }[];
    expect(cats.map((c) => c.id)).toEqual([77]);
    const accounts = (await runCli(august(), ['accounts', 'list'])).json();
    expect(accounts).toEqual([
      expect.objectContaining({ id: '501', currency: 'EUR', balance: 1234.56 }),
    ]);
  });
});

describe('receipts match (real-use fixes, end to end)', () => {
  it('skips documented operations, looks up <opId>_ files, and says what it excluded', async () => {
    const api = new FakeCompta([
      rawOp({
        id: 501,
        date: '2026-08-02',
        wording: 'PRLV NIMBUS HOSTING',
        amount: 48,
        attachments: [{ name: 'nimbus-invoice.pdf' }],
      }),
      rawOp({ id: 502, date: '2025-11-03', wording: 'OLD FICTIONAL SUPPLIER', amount: 75 }),
    ]);
    const dir = tempHome();
    const inbox = join(dir, 'inbox');
    mkdirSync(inbox);
    writeFileSync(
      join(inbox, 'nimbus-copy.pdf'),
      makePdf(['NIMBUS HOSTING', 'Date 2026-08-02', 'Total 48,00 EUR']),
    );
    // Far outside the date window of the other document: found through its id prefix.
    writeFileSync(
      join(inbox, '502_old-supplier.pdf'),
      makePdf(['OLD FICTIONAL SUPPLIER', 'Total 75,00 EUR']),
    );
    const plan = join(dir, 'receipts.plan.json');
    const r = await runCli(api, ['receipts', 'match', inbox, '--plan', plan, '--no-color'], {
      stdoutIsTTY: true,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      '1 excluded: the matching operation already has a document (--include-attached to consider them)',
    );
    expect(JSON.parse(readFileSync(plan, 'utf8')).steps).toEqual([
      expect.objectContaining({
        op: '502',
        action: 'attach',
        file: './inbox/502_old-supplier.pdf',
      }),
    ]);
    const json = await runCli(api, ['receipts', 'match', inbox, '--plan', plan]);
    expect(json.json()).toMatchObject({ meta: { matched: 1, alreadyDocumented: 1 } });
    expect(json.stderr).toContain('1 excluded because the operation already has a document');
  });
});
