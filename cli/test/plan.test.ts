import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeOperation } from '../src/api/normalize.js';
import { rawTransactionSchema } from '../src/api/schemas.js';
import { applyPlan, executeStep } from '../src/plan/apply.js';
import { observe } from '../src/plan/diff.js';
import { buildPlan, type PlanStep, planSchema, type StepDraft } from '../src/plan/types.js';
import { FakeCompta } from './helpers/fake-api.js';
import { COMPANY, type RawOpFixture, rawCategoryMap, rawOp } from './helpers/fixtures.js';
import { comptaFor, tempHome } from './helpers/run.js';

const toOp = (raw: RawOpFixture) =>
  normalizeOperation(rawTransactionSchema.parse(raw), {
    company: COMPANY,
    apiBase: 'https://compta.example.test',
    categories: rawCategoryMap(),
  });

function step(draft: StepDraft, id = 's1'): PlanStep {
  return { id, ...draft } as PlanStep;
}

interface PatchBody {
  note?: string | null;
  validated?: boolean;
  lines?: RawOpFixture['lines'];
}

function opPatches(api: FakeCompta) {
  return api.writes.filter((r) => r.method === 'PATCH' && /\/transactions\/\d+$/.test(r.path));
}

describe('set: category + VAT exemption', () => {
  it('sets the category, no VAT and the reason in one update, via `lines`', async () => {
    const raw = rawOp({
      id: 1,
      category: 'uncategorized',
      vatRate: 20,
      amount: 84,
      validated: false,
    });
    const api = new FakeCompta([raw]);
    const result = await executeStep(
      comptaFor(api),
      step({
        op: '1',
        action: 'set',
        set: { category: 77, vatExempt: 'outside-eu' },
        why: 'synthetic US supplier',
        expect: observe(toOp(raw)),
      }),
    );
    expect(result.status).toBe('applied');
    const patches = opPatches(api);
    expect(patches).toHaveLength(1);
    const body = patches[0]!.body as PatchBody;
    // The update sends the full list of lines (it replaces them all), and nothing else.
    expect(Object.keys(body)).toEqual(['lines']);
    expect(body.lines![0]).toMatchObject({
      category_id: 77,
      tax: {
        treatment: 'exempt',
        rate: null,
        amount: 0,
        exemption_reason: 'purchase_non_eu',
        // The new category's default VAT would have applied: removing it is a manual override.
        overridden: true,
      },
    });
    // Never ?override_lock=true: that would unlock locked ledgers (see B1).
    expect(patches.every((p) => !p.query.has('override_lock'))).toBe(true);
    expect(toOp(api.ops.get('1')!)).toMatchObject({
      category: { id: 77 },
      vatAmount: 0,
      vatExemptReason: 'outside-eu',
    });
  });

  it('is idempotent: re-applying a satisfied step writes nothing', async () => {
    const api = new FakeCompta([rawOp({ id: 2, exemption: 'purchase_non_eu' })]);
    const result = await executeStep(
      comptaFor(api),
      step({ op: '2', action: 'set', set: { vatExempt: 'outside-eu' }, why: 'x' }),
    );
    expect(result).toMatchObject({ status: 'skipped', reason: 'already satisfied' });
    expect(api.writes).toHaveLength(0);
  });

  it('records an exemption on a line whose VAT is already zero despite its old expectation', async () => {
    const raw = rawOp({ id: 3, vatRate: 20, amount: 60, validated: false });
    const expectation = observe(toOp(raw));
    raw.lines[0] = {
      ...raw.lines[0]!,
      tax: { ...raw.lines[0]!.tax, amount: 0, rate: null, deductible: 0 },
    };
    const api = new FakeCompta([raw]);
    const result = await executeStep(
      comptaFor(api),
      step({
        op: '3',
        action: 'set',
        set: { vatExempt: 'inside-eu' },
        why: 'x',
        expect: expectation,
      }),
    );
    expect(result.status).toBe('applied');
    expect(opPatches(api)).toHaveLength(1);
    // No VAT was removed: the tax is not marked overridden.
    expect((opPatches(api)[0]!.body as PatchBody).lines![0]!.tax).toMatchObject({
      treatment: 'exempt',
      exemption_reason: 'purchase_eu',
      overridden: false,
    });
  });

  it('refuses an exemption on an uncategorized operation with an actionable error', async () => {
    const api = new FakeCompta([rawOp({ id: 4, category: 'uncategorized', vatRate: null })]);
    await expect(
      executeStep(
        comptaFor(api),
        step({ op: '4', action: 'set', set: { vatExempt: 'outside-eu' }, why: 'x' }),
      ),
    ).rejects.toMatchObject({
      code: 'CATEGORY_REQUIRED',
      hint: expect.stringContaining('category'),
    });
  });

  it('reports when Compta refuses the exemption, and nothing is saved', async () => {
    const api = new FakeCompta([rawOp({ id: 5, validated: false })]);
    api.overrides.push((req) =>
      req.method === 'PATCH' && (req.body as PatchBody).lines
        ? Response.json(
            { error: { code: 'EXEMPTION_NOT_ALLOWED', message: 'No', details: {} } },
            { status: 400 },
          )
        : undefined,
    );
    const before = structuredClone(api.ops.get('5'));
    await expect(
      executeStep(
        comptaFor(api),
        step({ op: '5', action: 'set', set: { vatExempt: 'inside-eu' }, why: 'x' }),
      ),
    ).rejects.toMatchObject({
      code: 'EXEMPTION_UNAVAILABLE',
    });
    expect(api.ops.get('5')).toEqual(before);
  });

  it('refuses an exemption in a category outside VAT before writing', async () => {
    const api = new FakeCompta([
      rawOp({ id: 7, category: 'uncategorized', vatRate: null, validated: false }),
      rawOp({ id: 8, category: 'bankFees', vatRate: null }),
    ]);
    const exempt = (op: string) =>
      executeStep(
        comptaFor(api),
        step({ op, action: 'set', set: { category: 12, vatExempt: 'inside-eu' }, why: 'x' }),
      );
    await expect(exempt('7')).rejects.toMatchObject({ code: 'EXEMPTION_UNAVAILABLE' });
    expect(api.writes).toHaveLength(0);
    // A validated operation is reopened first, then validated again: nothing is left changed.
    await expect(exempt('8')).rejects.toMatchObject({ code: 'EXEMPTION_UNAVAILABLE' });
    expect(opPatches(api).map((p) => p.body)).toEqual([{ validated: false }, { validated: true }]);
    expect(api.ops.get('8')!.validated).toBe(true);
  });

  it('detects a write the server silently ignored (VERIFY_FAILED)', async () => {
    const api = new FakeCompta([rawOp({ id: 6, category: 'ads' })]);
    api.overrides.push((req) =>
      req.method === 'PATCH' ? Response.json(api.ops.get('6')) : undefined,
    );
    await expect(
      executeStep(
        comptaFor(api),
        step({ op: '6', action: 'set', set: { category: 77 }, why: 'x' }),
      ),
    ).rejects.toMatchObject({
      code: 'VERIFY_FAILED',
      exitCode: 5,
    });
  });
});

describe('set: VAT rate, memo; validate; attach; detach', () => {
  it('sets a VAT rate from the gross amount and clears an exemption', async () => {
    const api = new FakeCompta([rawOp({ id: 10, amount: 120, exemption: 'purchase_non_eu' })]);
    await executeStep(
      comptaFor(api),
      step({ op: '10', action: 'set', set: { vatRate: 20 }, why: 'French supplier after all' }),
    );
    expect(toOp(api.ops.get('10')!)).toMatchObject({
      vatRate: 20,
      vatAmount: 20,
      amountExcludingVat: 100,
      vatExemptReason: null,
    });
  });

  it('updates the memo with a note-only update', async () => {
    const api = new FakeCompta([rawOp({ id: 11, validated: false })]);
    await executeStep(
      comptaFor(api),
      step({ op: '11', action: 'set', set: { memo: 'Annual plan' }, why: 'x' }),
    );
    expect(api.ops.get('11')!.note).toBe('Annual plan');
    expect(opPatches(api)[0]!.body).toEqual({ note: 'Annual plan' });
    expect(api.ops.get('11')!.lines[0]!.category_id).toBe(77);
  });

  it('validates an operation', async () => {
    const api = new FakeCompta([rawOp({ id: 12, validated: false })]);
    expect(
      (await executeStep(comptaFor(api), step({ op: '12', action: 'validate', why: 'x' }))).status,
    ).toBe('applied');
    expect(api.ops.get('12')!.validated).toBe(true);
    expect(opPatches(api)[0]!.body).toEqual({ validated: true });
  });

  it('uploads with the "<digits>_" prefix stripped, and skips once attached', async () => {
    const dir = tempHome();
    const file = join(dir, '12345_invoice-aug.pdf');
    writeFileSync(file, '%PDF-1.4 synthetic');
    const api = new FakeCompta([rawOp({ id: 13 })]);
    const compta = comptaFor(api);
    const s = step({ op: '13', action: 'attach', file, why: 'x' });
    expect((await executeStep(compta, s, { baseDir: dir })).status).toBe('applied');
    const form = api.writes[0]!.body as FormData;
    expect((form.get('file') as File).name).toBe('invoice-aug.pdf');
    expect((await executeStep(compta, s, { baseDir: dir })).status).toBe('skipped');
  });

  it('detaches an attachment', async () => {
    const raw = rawOp({ id: 14, attachments: [{ name: 'wrong.pdf' }], validated: false });
    const api = new FakeCompta([raw]);
    const attId = String(raw.attachments[0]!.id);
    await executeStep(
      comptaFor(api),
      step({ op: '14', action: 'detach', attachmentId: attId, why: 'x' }),
    );
    expect(api.ops.get('14')!.attachments).toHaveLength(0);
    expect(api.writes[0]).toMatchObject({
      method: 'DELETE',
      path: `/v1/companies/${COMPANY}/transactions/14/attachments/${attId}`,
    });
  });
});

describe('applyPlan', () => {
  it('skips steps whose operation changed since planning, unless forced', async () => {
    const raw = rawOp({ id: 20, category: 'ads' });
    const api = new FakeCompta([raw]);
    const plan = buildPlan(COMPANY, 'test', [
      { op: '20', action: 'set', set: { category: 77 }, why: 'x', expect: { category: 12 } },
    ]);
    const report = await applyPlan(comptaFor(api), plan);
    expect(report.results[0]).toMatchObject({
      status: 'conflict',
      reason: expect.stringContaining('category'),
    });
    expect(api.writes).toHaveLength(0);
    expect((await applyPlan(comptaFor(api), plan, { force: true })).meta.applied).toBe(1);
  });

  it('never writes in dry-run and reports before → after', async () => {
    const api = new FakeCompta([rawOp({ id: 21, category: 'ads', validated: false })]);
    const plan = buildPlan(COMPANY, 'test', [
      { op: '21', action: 'set', set: { category: 77 }, why: 'x' },
    ]);
    const report = await applyPlan(comptaFor(api), plan, { dryRun: true });
    expect(report.meta).toMatchObject({ dryRun: true, planned: 1, applied: 0 });
    expect(report.results[0]!.changes).toEqual([{ field: 'category', from: 69, to: 77 }]);
    expect(api.writes).toHaveLength(0);
  });

  it('stops at the first failure (remaining steps pending) unless continue-on-error', async () => {
    const api = new FakeCompta([
      rawOp({ id: 22, validated: false }),
      rawOp({ id: 23, validated: false }),
    ]);
    const plan = buildPlan(COMPANY, 'test', [
      { op: '999', action: 'validate', why: 'missing op' },
      { op: '22', action: 'validate', why: 'x' },
      { op: '23', action: 'validate', why: 'x' },
    ]);
    const stopped = await applyPlan(comptaFor(api), plan);
    expect(stopped.meta).toMatchObject({ failed: 1, pending: 2, applied: 0 });
    expect(stopped.results[0]!.error).toMatchObject({ code: 'NOT_FOUND' });
    const continued = await applyPlan(comptaFor(api), plan, { continueOnError: true });
    expect(continued.meta).toMatchObject({ failed: 1, applied: 2, pending: 0 });
  });

  it('refuses a plan for another company', async () => {
    const plan = buildPlan('123456', 'test', []);
    await expect(applyPlan(comptaFor(new FakeCompta()), plan)).rejects.toMatchObject({
      code: 'COMPANY_MISMATCH',
      exitCode: 2,
    });
  });

  it('asks for a breakdown id on split operations', async () => {
    const raw = rawOp({ id: 24, amount: 100 });
    raw.lines.push({ ...raw.lines[0]!, id: 999 });
    const report = await applyPlan(
      comptaFor(new FakeCompta([raw])),
      buildPlan(COMPANY, 't', [{ op: '24', action: 'set', set: { category: 69 }, why: 'x' }]),
    );
    expect(report.results[0]!.error).toMatchObject({
      code: 'SPLIT_OPERATION',
      hint: expect.stringContaining('breakdown'),
    });
  });
});

describe('plan schema', () => {
  it('accepts the documented example and rejects bad input', () => {
    const plan = {
      version: 1,
      company: COMPANY,
      createdAt: '2026-08-01T10:00:00.000Z',
      createdBy: 'compta-cli 0.1.0 receipts match',
      steps: [
        {
          id: 's1',
          op: '123',
          action: 'attach',
          file: './inbox/inv.pdf',
          why: 'amount 48.00 = op amount',
        },
        {
          id: 's2',
          op: '456',
          action: 'set',
          set: { category: 77, vatExempt: 'outside-eu' },
          expect: { vatAmount: 8, category: -1 },
          why: 'foreign supplier',
        },
      ],
    };
    expect(planSchema.parse(plan)).toEqual(plan);
    expect(planSchema.safeParse({ ...plan, steps: [plan.steps[0], plan.steps[0]] }).success).toBe(
      false,
    );
    expect(
      planSchema.safeParse({ ...plan, steps: [{ ...plan.steps[1], set: { vatRate: 19 } }] })
        .success,
    ).toBe(false);
    expect(
      planSchema.safeParse({
        ...plan,
        steps: [{ ...plan.steps[1], set: { vatRate: 20, vatExempt: 'inside-eu' } }],
      }).success,
    ).toBe(false);
    expect(
      planSchema.safeParse({ ...plan, steps: [{ ...plan.steps[0], extra: true }] }).success,
    ).toBe(false);
  });
});
