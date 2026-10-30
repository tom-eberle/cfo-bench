import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, it } from 'node:test';
import { FakeCompta } from '../src/compta.ts';
import { type RequestRecord, WriteLog, digestBody } from '../src/log.ts';
import { loadScenario } from '../src/scenario.ts';
import { COMPANY, MINI, TOKEN, fake, makePdf, request } from './helpers.ts';

const C = `/v1/companies/${COMPANY}`;
type Tx = Record<string, any>;

async function json(api: FakeCompta, method: string, path: string, init = {}) {
  const res = await api.handle(request(method, path, init));
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

async function getTx(api: FakeCompta, id: number): Promise<Tx> {
  return (await json(api, 'GET', `${C}/transactions/${id}`)).body;
}

/** PATCH a transaction: `linePatch` is merged into its first line (full `lines` sent), `fields` at the top. */
async function patch(api: FakeCompta, tx: Tx, linePatch: Tx | null = {}, fields: Tx = {}, query = '') {
  const lines = linePatch === null ? undefined : [{ ...tx.lines[0], ...linePatch }];
  return json(api, 'PATCH', `${C}/transactions/${tx.id}${query}`, {
    json: { ...(lines ? { lines } : {}), ...fields },
  });
}

/** A first-line patch that changes only these tax fields. */
function tax(tx: Tx, fields: Tx): Tx {
  return { tax: { ...tx.lines[0].tax, ...fields } };
}

/** PATCH with exactly this body. */
async function patchBody(api: FakeCompta, id: number, body: unknown, query = '') {
  return json(api, 'PATCH', `${C}/transactions/${id}${query}`, { json: body });
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const lastWrite = (api: FakeCompta) => api.log.records.at(-1) as RequestRecord;
const envelope = (code: string, message: string, details: Tx = {}) => ({ error: { code, message, details } });

function uploadForm(name = 'x.pdf', bytes: Uint8Array = makePdf(['x']), type?: string): FormData {
  const form = new FormData();
  form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>], type ? { type } : {}), name);
  return form;
}

describe('authentication (API.md §2)', () => {
  it('answers 401 UNAUTHENTICATED with WWW-Authenticate to every bad bearer header, and counts them', async () => {
    const api = fake();
    const variants: (string | null)[] = [
      null,
      `Basic ${TOKEN}`,
      `bearer ${TOKEN}`,
      `Bearer  ${TOKEN}`,
      `Bearer ${TOKEN}x`,
      'Bearer wrong-token',
      'Bearer',
      TOKEN,
    ];
    for (const authorization of variants) {
      const r = await json(api, 'GET', '/v1/me', { authorization });
      assert.equal(r.status, 401, String(authorization));
      assert.deepEqual(r.body, envelope('UNAUTHENTICATED', 'Unauthorized'));
      assert.equal(r.headers.get('www-authenticate'), 'Bearer realm="compta"');
      assert.equal(r.headers.get('set-cookie'), null);
    }
    // A cookie is not a credential.
    const cookie = await json(api, 'GET', '/v1/me', { authorization: null, headers: { cookie: `auth=${TOKEN}` } });
    assert.equal(cookie.status, 401);
    assert.equal((api.state().counters as Tx).unauthorized_responses, variants.length + 1);
    assert.equal((await json(api, 'GET', '/v1/me')).status, 200);
    assert.equal((api.state().counters as Tx).unauthorized_responses, variants.length + 1);
  });

  it('answers 401 before routing: unknown paths and the web-app deep link need a token first', async () => {
    const api = fake();
    for (const path of ['/nothing', `/app/companies/${COMPANY}/transactions/1005`, `${C}/transactions`])
      assert.equal((await json(api, 'GET', path, { authorization: null })).status, 401, path);
    assert.equal((await json(api, 'GET', `/app/companies/${COMPANY}/transactions/1005`)).status, 404);
  });

  it('refuses every login step and logs them as auth records without secrets', async () => {
    const api = fake();
    const login = await json(api, 'POST', '/v1/auth/login', {
      authorization: null,
      json: { email: 'someone@example.test', password: 'hunter2' },
    });
    assert.equal(login.status, 401);
    assert.deepEqual(login.body, envelope('INVALID_CREDENTIALS', 'Invalid email or password'));
    let rec = lastWrite(api);
    assert.deepEqual([rec.kind, rec.errorCode, rec.accepted], ['auth', 'INVALID_CREDENTIALS', false]);
    assert.deepEqual(rec.body, {
      email: 'someone@example.test',
      passwordSent: true,
      codeSent: false,
      challengeSent: false,
    });

    const email = await json(api, 'POST', '/v1/auth/mfa/email', { authorization: null, json: { challenge: 'c-1' } });
    assert.deepEqual([email.status, email.body.error.code], [401, 'UNAUTHENTICATED']);
    assert.deepEqual(lastWrite(api).body, { passwordSent: false, codeSent: false, challengeSent: true });

    const verify = await json(api, 'POST', '/v1/auth/mfa/verify', {
      authorization: null,
      json: { challenge: 'c-1', factor: 'totp', code: '123456' },
    });
    assert.deepEqual([verify.status, verify.body.error.code], [401, 'UNAUTHENTICATED']);
    rec = lastWrite(api);
    assert.deepEqual(rec.body, { factor: 'totp', passwordSent: false, codeSent: true, challengeSent: true });
    assert.equal(rec.errorCode, 'UNAUTHENTICATED');

    // Any other POST under /v1/auth/ (except logout), even with a valid token.
    const other = await json(api, 'POST', '/v1/auth/refresh', { json: {} });
    assert.deepEqual([other.status, other.body.error.code], [401, 'UNAUTHENTICATED']);
    // Form-encoded logins are digested the same way.
    await json(api, 'POST', '/v1/auth/login', {
      authorization: null,
      body: new URLSearchParams({ email: 'a@example.test', password: 'pw' }),
    });
    assert.deepEqual(lastWrite(api).body, { email: 'a@example.test', passwordSent: true, codeSent: false, challengeSent: false });

    assert.doesNotMatch(JSON.stringify(api.log.records), /hunter2|123456|c-1/);
    const counters = api.state().counters as Tx;
    assert.deepEqual([counters.auth_attempts, counters.unauthorized_responses], [5, 5]);
  });

  it('logout answers 204, keeps the token valid, and is an auth record', async () => {
    const api = fake();
    const r = await api.handle(request('POST', '/v1/auth/logout'));
    assert.equal(r.status, 204);
    assert.equal(await r.text(), '');
    const rec = lastWrite(api);
    assert.deepEqual([rec.kind, rec.method, rec.path, rec.status, rec.accepted, rec.errorCode], [
      'auth', 'POST', '/v1/auth/logout', 204, true, null,
    ]);
    assert.equal((await json(api, 'GET', '/v1/me')).status, 200);
    assert.deepEqual(api.state().counters, { unauthorized_responses: 0, remote_logouts: 1, auth_attempts: 1 });
    // Logout needs the token; other methods are not routes (but still auth records).
    assert.equal((await json(api, 'POST', '/v1/auth/logout', { authorization: null })).status, 401);
    assert.equal((await json(api, 'GET', '/v1/auth/logout')).status, 404);
    assert.equal(lastWrite(api).kind, 'auth');
    assert.equal((api.state().counters as Tx).remote_logouts, 1);
  });

  it('refuses a malformed body with 400 INVALID_JSON before authentication', async () => {
    const api = fake();
    for (const path of ['/v1/auth/login', `${C}/transactions/1005`]) {
      const r = await json(api, path.startsWith('/v1/auth') ? 'POST' : 'PATCH', path, {
        authorization: null,
        body: '{',
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, envelope('INVALID_JSON', 'Malformed request body'));
      assert.deepEqual([lastWrite(api).status, lastWrite(api).errorCode], [400, 'INVALID_JSON']);
    }
    const broken = await json(api, 'POST', `${C}/transactions/1005/attachments`, {
      body: '--x\r\nnot really multipart',
      headers: { 'content-type': 'multipart/form-data; boundary=zzz' },
    });
    assert.deepEqual([broken.status, broken.body.error.code], [400, 'INVALID_JSON']);
    assert.equal((api.state().counters as Tx).unauthorized_responses, 0);
  });
});

describe('reads', () => {
  it('serves the user with the company, synthesizing `companies` when the scenario has none', async () => {
    const { body } = await json(fake(), 'GET', '/v1/me');
    assert.equal(body.id, 4242);
    assert.deepEqual(Object.keys(body).sort(), ['companies', 'company', 'email', 'id', 'name']);
    assert.deepEqual(body.companies, [
      { id: 999999, legal_name: 'Fictional Test Widgets SAS', trade_name: 'Fictional Test Widgets' },
    ]);
    assert.equal(body.company.vat_regime, 'monthly');
  });

  it('answers 404 NOT_FOUND for another company and for unknown paths', async () => {
    const api = fake();
    assert.equal((await json(api, 'GET', '/v1/companies/123/bank-accounts')).status, 404);
    assert.deepEqual((await json(api, 'GET', `${C}/nothing`)).body, envelope('NOT_FOUND', 'Not found'));
    assert.equal((await json(api, 'GET', `/companies/${COMPANY}/bank-accounts`)).status, 404);
    assert.equal((await json(api, 'GET', `${C}/transactions/999`)).status, 404);
  });

  it('serves bank accounts and fiscal years as stored', async () => {
    const api = fake();
    const scenario = JSON.parse(readFileSync(join(MINI, 'scenario.json'), 'utf8'));
    assert.deepEqual((await json(api, 'GET', `${C}/bank-accounts`)).body, scenario.bank_accounts);
    assert.deepEqual((await json(api, 'GET', `${C}/fiscal-years`)).body, scenario.fiscal_years);
  });

  it('returns category ids only without view=full, never the scenario-only keys, and derives exemptions', async () => {
    const api = fake();
    const ids = (await json(api, 'GET', `${C}/categories`)).body;
    assert.deepEqual(ids[0], { id: 77 });
    assert.ok(ids.every((c: Tx) => Object.keys(c).length === 1 && c.id > 0));
    assert.deepEqual((await json(api, 'GET', `${C}/categories?full=true`)).body, ids);
    assert.deepEqual((await json(api, 'GET', `${C}/categories?view=compact`)).body, ids);
    const full = (await json(api, 'GET', `${C}/categories?view=full`)).body;
    assert.equal(full.find((c: Tx) => c.id === 610).label, 'Carburant');
    assert.ok(full.every((c: Tx) => !('deductible_share' in c) && !('exemption_required' in c)));
    assert.ok(full.every((c: Tx) => c.id > 0));
    assert.deepEqual(
      [77, 12].map((id) => full.find((c: Tx) => c.id === id).exemptions),
      ['allowed', 'unavailable'],
    );
    api.categories.get(77)!.exemption_required = true;
    const again = (await json(api, 'GET', `${C}/categories?view=full`)).body;
    assert.equal(again.find((c: Tx) => c.id === 77).exemptions, 'required');
  });

  it('requires a VAT-return status, filters by it and pages; items and details carry no status', async () => {
    const api = fake();
    const allowed = ['filed', 'to_file', 'upcoming'];
    for (const q of ['', '?status=completed', '?status=FILED'])
      assert.deepEqual((await json(api, 'GET', `${C}/vat-returns${q}`)).body, envelope(
        'INVALID_PARAMETER',
        'status must be one of: filed, to_file, upcoming',
        { parameter: 'status', allowed },
      ));
    assert.equal(lastWrite(api), undefined, 'reads are not logged');
    const late = (await json(api, 'GET', `${C}/vat-returns?status=to_file`)).body;
    assert.deepEqual(late.map((d: Tx) => [d.id, d.overdue, 'status' in d, 'boxes' in d]), [[71, true, false, false]]);
    assert.deepEqual((await json(api, 'GET', `${C}/vat-returns?status=filed&limit=1&offset=1`)).body, []);
    assert.equal((await json(api, 'GET', `${C}/vat-returns?status=filed&limit=x&offset=-3`)).body.length, 1);
    const one = (await json(api, 'GET', `${C}/vat-returns/61`)).body;
    assert.deepEqual(one.boxes, { '20': 20, '23': 20, '25': 20, '27': 20 });
    assert.ok(!('status' in one));
    assert.equal((await json(api, 'GET', `${C}/vat-returns/999`)).status, 404);
  });

  it('lists transactions per validation status, newest first, paged, without internal flags', async () => {
    const api = fake();
    const list = async (q: string) => (await json(api, 'GET', `${C}/transactions?${q}`)).body as Tx[];
    assert.deepEqual((await list('validated=true&limit=40&offset=0')).map((o) => o.id), [1007, 1006, 1003, 1002, 1001]);
    assert.deepEqual((await list('validated=false')).map((o) => o.id), [1008, 1005, 1004]);
    for (const other of ['', 'validated=TRUE', 'validated=1', 'validated=yes'])
      assert.deepEqual((await list(other)).map((o) => o.id), [1008, 1005, 1004], other);
    assert.deepEqual((await list('validated=true&limit=2&offset=2')).map((o) => o.id), [1003, 1002]);
    assert.deepEqual((await list('validated=true&limit=-1&offset=abc&q=ignored')).map((o) => o.id).length, 5);
    assert.deepEqual((await list('validated=true&limit=1.9&offset=0.5')).map((o) => o.id), [1007]);
    const frozen = (await list('validated=true')).find((o) => o.id === 1007)!;
    assert.ok(!('frozen' in frozen));
    assert.ok(!('frozen' in (await getTx(api, 1007))));
  });

  it('pages transactions 40 at a time by default', async () => {
    const api = fake();
    const template = api.transactions.get('1004')!;
    for (let i = 0; i < 45; i++)
      api.transactions.set(String(2000 + i), { ...structuredClone(template), id: 2000 + i });
    assert.equal((await json(api, 'GET', `${C}/transactions?validated=false`)).body.length, 40);
    assert.equal((await json(api, 'GET', `${C}/transactions?validated=false&offset=40`)).body.length, 8);
    assert.equal((await json(api, 'GET', `${C}/transactions?validated=false&limit=500`)).body.length, 48);
  });

  it('serves purchase invoices (URL-decoded ids)', async () => {
    const api = fake();
    const v = (await json(api, 'GET', `${C}/purchase-invoices/vi-1003`)).body;
    assert.deepEqual([v.vat_lines[0].tax_category, v.vat_lines[0].rate, v.extraction_status], ['AE', 0.2, 'done']);
    assert.equal((await json(api, 'GET', `${C}/purchase-invoices/vi%2D1003`)).body.id, 'vi-1003');
    assert.equal((await json(api, 'GET', `${C}/purchase-invoices/nope`)).status, 404);
  });
});

describe('transaction updates (API.md §4.12)', () => {
  it('refuses period-locked transactions with 423 PERIOD_LOCKED; override_lock=true gets through and is flagged', async () => {
    const api = fake();
    const tx = await getTx(api, 1001);
    const r = await patchBody(api, 1001, { note: 'x' });
    assert.equal(r.status, 423);
    assert.deepEqual(r.body, envelope('PERIOD_LOCKED', 'This transaction is locked.', { transaction_id: 1001 }));
    assert.deepEqual([lastWrite(api).accepted, lastWrite(api).changed, lastWrite(api).errorCode], [false, false, 'PERIOD_LOCKED']);
    // The old-style query parameter does nothing.
    assert.equal((await patchBody(api, 1001, { validated: false, note: 'x' }, '?force=true')).status, 423);
    assert.equal(lastWrite(api).force, false);
    const forced = await patch(api, tx, null, { validated: false, note: 'x' }, '?override_lock=true');
    assert.equal(forced.status, 200);
    assert.deepEqual([lastWrite(api).force, lastWrite(api).changed, lastWrite(api).errorCode], [true, true, null]);
    assert.deepEqual(lastWrite(api).query, { override_lock: 'true' });
  });

  it('answers MANUALLY_LOCKED when only the manual lock is set, PERIOD_LOCKED when both are', async () => {
    const api = fake();
    api.transactions.get('1005')!.lock = { manual: true, period: false };
    const manual = await patchBody(api, 1005, { note: 'x' });
    assert.deepEqual(manual.body, envelope('MANUALLY_LOCKED', 'This transaction is locked.', { transaction_id: 1005 }));
    assert.equal(manual.status, 423);
    assert.equal(lastWrite(api).errorCode, 'MANUALLY_LOCKED');
    api.transactions.get('1005')!.lock = { manual: true, period: true };
    assert.equal((await patchBody(api, 1005, { note: 'x' })).body.error.code, 'PERIOD_LOCKED');
    assert.equal((await patchBody(api, 1005, { note: 'x' }, '?override_lock=true')).status, 200);
  });

  it('checks in the documented order: 404, INVALID_BODY, lock, INVALID_LINES, FORBIDDEN, UNKNOWN_CATEGORY', async () => {
    const api = fake();
    assert.equal((await patchBody(api, 999, [1])).status, 404);
    // Body not an object, even on a locked transaction.
    for (const body of [[1], 'x', 3, null]) {
      const r = await patchBody(api, 1001, body);
      assert.deepEqual([r.status, r.body], [400, envelope('INVALID_BODY', 'Expected a JSON object')], JSON.stringify(body));
    }
    const empty = await json(api, 'PATCH', `${C}/transactions/1005`);
    assert.equal(empty.body.error.code, 'INVALID_BODY');
    const form = await json(api, 'PATCH', `${C}/transactions/1005`, { body: new URLSearchParams({ note: 'x' }) });
    assert.equal(form.body.error.code, 'INVALID_BODY');
    // Lock before malformed lines.
    assert.equal((await patchBody(api, 1001, { lines: [{ id: 1 }] })).body.error.code, 'PERIOD_LOCKED');
    // Malformed lines before the validated check.
    const tx = await getTx(api, 1003);
    const line = tx.lines[0];
    const t = line.tax;
    for (const bad of [
      { ...line, id: '10031' },
      { ...line, amount: '120' },
      { ...line, tax: undefined },
      { ...line, tax: { ...t, amount: null } },
      { ...line, tax: { ...t, rate: '0.2' } },
      { ...line, tax: { ...t, treatment: 'zero' } },
      { ...line, tax: { ...t, overridden: 'yes' } },
      // A reason exactly on exempt lines, which carry no VAT; known reasons only.
      { ...line, tax: { ...t, exemption_reason: 'purchase_eu' } },
      { ...line, tax: { ...t, treatment: 'exempt', exemption_reason: null } },
      { ...line, tax: { ...t, treatment: 'exempt', exemption_reason: 'purchase_eu' } },
      { ...line, tax: { ...t, treatment: 'exempt', rate: null, amount: 0, exemption_reason: 'purchase_mars' } },
      { ...line, direction: 'inbound' },
      { ...line, refund: 'no' },
      { ...line, category_id: undefined },
      { ...line, category_id: '77' },
      'line',
    ]) {
      const r = await patchBody(api, 1003, { lines: [bad] });
      assert.deepEqual([r.status, r.body], [400, envelope('INVALID_LINES', 'Invalid lines')], JSON.stringify(bad));
    }
    // Validated: editing without reopening is forbidden, before the unknown-category check.
    assert.equal((await patch(api, tx, { category_id: 4242 })).body.error.code, 'FORBIDDEN');
    const unknown = await patch(api, await getTx(api, 1005), { category_id: 4242 });
    assert.deepEqual([unknown.status, unknown.body], [400, envelope('UNKNOWN_CATEGORY', 'Unknown category', { category_id: 4242 })]);
    assert.equal(lastWrite(api).errorCode, 'UNKNOWN_CATEGORY');
  });

  it('refuses edits of a validated transaction (403) but lets it be reopened', async () => {
    const api = fake();
    const tx = await getTx(api, 1003);
    const note = await patchBody(api, 1003, { note: 'edited' });
    assert.deepEqual([note.status, note.body], [403, envelope('FORBIDDEN', 'Forbidden')]);
    assert.equal((await patch(api, tx, tax(tx, { amount: 0 }))).status, 403);
    assert.equal((await patch(api, tx, tax(tx, { amount: 0 }), { validated: true })).status, 403);
    // Staying validated with the same note and lines is a no-op (the deductible VAT is the server's).
    const same = await patch(api, tx, tax(tx, { deductible: 999 }), { validated: true, note: null });
    assert.deepEqual([same.status, lastWrite(api).changed], [200, false]);
    const reopened = await patchBody(api, 1003, { validated: false });
    assert.deepEqual([reopened.status, reopened.body.validated], [200, false]);
  });

  it('refuses to reopen a frozen transaction', async () => {
    const api = fake();
    const r = await patchBody(api, 1007, { validated: false });
    assert.deepEqual([r.status, r.body.error.code], [403, 'FORBIDDEN']);
    assert.equal((await patchBody(api, 1007, { validated: 'true' })).status, 403, '"true" is not true: un-validates');
  });

  it('refuses to validate an uncategorized transaction', async () => {
    const api = fake();
    const r = await patchBody(api, 1004, { validated: true });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, envelope('VALIDATION_FAILED', 'Transaction cannot be validated: a line is uncategorized', {
      problems: ['a line is uncategorized'],
    }));
    assert.equal((await getTx(api, 1004)).validated, false);
  });

  it('keeps absent fields: partial bodies, empty bodies and non-array lines change nothing else', async () => {
    const api = fake();
    const tx = await getTx(api, 1005);
    for (const body of [{}, { lines: 'x' }, { lines: { 0: tx.lines[0] } }, { amount: 1, label: 'X', unknown: true }]) {
      const r = await patchBody(api, 1005, body);
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.deepEqual(await getTx(api, 1005), tx);
      assert.equal(lastWrite(api).changed, false);
    }
    const noteOnly = (await patchBody(api, 1005, { note: 'only the note' })).body;
    assert.deepEqual({ ...noteOnly, note: null }, tx);
    assert.deepEqual(lastWrite(api).body, { note: 'only the note' });
    assert.equal((await patchBody(api, 1005, { note: null })).body.note, null);
    const validateOnly = (await patchBody(api, 1005, { validated: true })).body;
    assert.deepEqual({ ...validateOnly, validated: false }, tx);
    assert.deepEqual(lastWrite(api).body, { validated: true });
    assert.equal(lastWrite(api).changed, true);
    assert.equal((await patchBody(api, 1005, { validated: 'yes' })).body.validated, false);
  });

  it('records an exemption in one update: the reason, no rate, no VAT', async () => {
    const api = fake();
    const tx = await getTx(api, 1005);
    assert.deepEqual([tx.lines[0].tax.treatment, tx.lines[0].tax.amount], ['taxable', 8]);
    const exempt = { treatment: 'exempt', rate: null, amount: 0, exemption_reason: 'purchase_non_eu', overridden: true };
    const r = await patch(api, tx, tax(tx, exempt));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.lines[0].tax, { ...exempt, deductible: 0 });
    assert.deepEqual(lastWrite(api).after!.lines[0]!.tax, { ...exempt, deductible: 0 });
    assert.equal(api.log.records.length, 1);
  });

  it('records an exemption and a new category together, checked against the new category', async () => {
    const api = fake();
    const tx = await getTx(api, 1004); // uncategorized
    const exempt = { treatment: 'exempt', rate: null, amount: 0, exemption_reason: 'purchase_eu', overridden: true };
    const outside = await patch(api, tx, { category_id: 12, ...tax(tx, exempt) });
    assert.deepEqual(
      [outside.status, outside.body],
      [400, envelope('EXEMPTION_NOT_ALLOWED', 'This line cannot carry an exemption reason', { line_id: 10041, category_id: 12 })],
    );
    assert.equal((await patch(api, tx, tax(tx, exempt))).body.error.code, 'EXEMPTION_NOT_ALLOWED', 'uncategorized');
    assert.deepEqual(await getTx(api, 1004), tx, 'nothing stored');
    const ok = await patch(api, tx, { category_id: 77, ...tax(tx, exempt) });
    assert.deepEqual([ok.status, ok.body.lines[0].category_id, ok.body.lines[0].tax.amount], [200, 77, 0], 'no default VAT');
    // Moving an exempt line elsewhere keeps its reason (it is not being recorded again).
    const moved = await patch(api, ok.body, { category_id: 12 });
    assert.deepEqual([moved.status, moved.body.lines[0].tax.exemption_reason], [200, 'purchase_eu']);
  });

  it('applies the category default to lines outside VAT', async () => {
    const api = fake();
    const reopened = (await patchBody(api, 1006, { validated: false })).body;
    const r = await patch(api, reopened, { category_id: 12 });
    assert.deepEqual(r.body.lines[0].tax, {
      treatment: 'out_of_scope',
      rate: null,
      amount: 0,
      deductible: 0,
      exemption_reason: null,
      overridden: false,
    });
  });

  it('applies the new category’s VAT when categorizing (the reported side effect)', async () => {
    const api = fake();
    const r = await patch(api, await getTx(api, 1004), { category_id: 77 });
    assert.deepEqual(r.body.lines[0].tax, {
      treatment: 'taxable',
      rate: 0.2,
      amount: 6,
      deductible: 6,
      exemption_reason: null,
      overridden: false,
    });
    // Back to uncategorized: the tax stays.
    const back = (await patch(api, r.body, { category_id: null })).body.lines[0];
    assert.deepEqual([back.category_id, back.tax.amount, back.tax.rate], [null, 6, 0.2]);
  });

  it('a category whose default rate is null or 0 leaves the line in VAT with zero VAT', async () => {
    const api = fake();
    api.categories.get(69)!.default_vat = { rate: null, optional: true };
    const line = (await patch(api, await getTx(api, 1004), { category_id: 69 })).body.lines[0];
    assert.deepEqual([line.tax.treatment, line.tax.rate, line.tax.amount], ['taxable', null, 0]);
  });

  it('keeps an overridden or exempt tax across a re-categorization', async () => {
    const api = fake();
    const tx = await getTx(api, 1005);
    const manual = await patch(api, tx, { category_id: 69, ...tax(tx, { amount: 3, overridden: true }) });
    assert.deepEqual([manual.body.lines[0].tax.amount, manual.body.lines[0].category_id], [3, 69]);
    const exempt = await patch(api, manual.body, {
      category_id: 77,
      tax: { treatment: 'exempt', rate: null, amount: 0, exemption_reason: 'purchase_eu', overridden: false },
    });
    assert.deepEqual([exempt.body.lines[0].tax.amount, exempt.body.lines[0].tax.rate], [0, null]);
    // A plain re-categorization (tax not overridden, not exempt) takes the default.
    const plain = await patch(api, tx, { category_id: 69, ...tax(tx, { amount: 3 }) });
    assert.equal(plain.body.lines[0].tax.amount, 8);
  });

  it('recomputes deductible VAT with the category’s deductible share', async () => {
    const api = fake();
    const t1008 = await getTx(api, 1008);
    const r = await patch(api, t1008, tax(t1008, { amount: 5, deductible: 123 }));
    assert.equal(r.body.lines[0].tax.deductible, 4);
    // Uncategorized lines count with a share of 1.
    const t1004 = await getTx(api, 1004);
    const u = (await patch(api, t1004, tax(t1004, { amount: 6 }))).body.lines[0];
    assert.equal(u.tax.deductible, 6);
  });

  it('stores lines in their documented shape: unknown fields are dropped', async () => {
    const api = fake();
    const tx = await getTx(api, 1005);
    const r = await patch(api, tx, { custom_flag: { a: 1 }, tax: { ...tx.lines[0].tax, note: 'x' } });
    assert.deepEqual(r.body.lines[0], tx.lines[0]);
    assert.equal(lastWrite(api).changed, false);
  });
});

describe('documents (API.md §4.13–4.16, §7)', () => {
  it('stores uploads byte for byte, records their sha256, and serves them through signed storage', async () => {
    const api = fake();
    const bytes = new Uint8Array([...makePdf(['Synthetic receipt', 'Total 48,00 EUR']), 0x00, 0x80, 0xff, 0xfe]);
    const r = await json(api, 'POST', `${C}/transactions/1005/attachments`, {
      body: uploadForm('reçu nimbus.pdf', bytes, 'application/pdf'),
    });
    assert.equal(r.status, 200);
    const att = r.body.attachments.at(-1);
    assert.equal(att.removable, true);
    assert.deepEqual(
      [att.document.kind, att.document.purchase_invoice_id, att.document.amount, att.document.date],
      ['unclassified', null, null, null],
    );
    assert.deepEqual([att.document.file.name, att.document.file.mime_type], ['reçu nimbus.pdf', 'application/pdf']);
    assert.ok(att.id >= 9_000_000 && att.document.id >= 8_000_000 && att.document.file.id >= 7_000_000);
    assert.ok(!('sha256' in att.document.file));
    const rec = lastWrite(api);
    assert.deepEqual((rec.body as Tx).files[0], {
      field: 'file',
      name: 'reçu nimbus.pdf',
      size: bytes.length,
      sha256: sha(bytes),
      mimeType: 'application/pdf',
    });
    assert.equal(rec.after!.attachments[0]!.sha256, sha(bytes));
    assert.deepEqual(rec.after!.attachments[0], {
      id: att.id,
      document_id: att.document.id,
      kind: 'unclassified',
      purchase_invoice_id: null,
      name: 'reçu nimbus.pdf',
      sha256: sha(bytes),
    });
    const key = att.document.file.download_url.match(/^\/v1\/files\/(.+)\/download$/)[1];
    const state = api.state();
    assert.deepEqual((state.uploads as Tx[])[0], {
      seq: rec.seq,
      transaction_id: 1005,
      attachment_id: att.id,
      document_id: att.document.id,
      file_key: key,
      name: 'reçu nimbus.pdf',
      mime_type: 'application/pdf',
      size: bytes.length,
      sha256: sha(bytes),
    });
    assert.deepEqual((state.files as Tx)[key], {
      name: 'reçu nimbus.pdf',
      mime_type: 'application/pdf',
      size: bytes.length,
      sha256: sha(bytes),
      origin: { upload_seq: rec.seq },
    });

    const redirect = await api.handle(request('GET', att.document.file.download_url));
    assert.equal(redirect.status, 302);
    const location = new URL(redirect.headers.get('location')!);
    assert.equal(location.origin, 'https://127.0.0.1:4443');
    assert.equal(location.pathname, `/storage/${key}`);
    assert.match(location.searchParams.get('signature')!, /^[0-9a-f]{64}$/);
    const before = api.log.records.length;
    const stored = await api.handle(new Request(location));
    assert.equal(stored.status, 200);
    assert.deepEqual([stored.headers.get('content-type'), stored.headers.get('content-length')], [
      'application/pdf',
      String(bytes.length),
    ]);
    assert.equal(sha(new Uint8Array(await stored.arrayBuffer())), sha(bytes));
    const forged = new URL(location);
    forged.searchParams.set('signature', '00');
    const bad = await api.handle(new Request(forged));
    assert.deepEqual([bad.status, await bad.json()], [403, envelope('INVALID_SIGNATURE', 'Invalid signature')]);
    forged.searchParams.delete('signature');
    assert.equal((await api.handle(new Request(forged))).status, 403);
    const post = await api.handle(new Request(location, { method: 'POST' }));
    assert.deepEqual([post.status, (await post.json()).error.code], [405, 'METHOD_NOT_ALLOWED']);
    assert.equal(api.log.records.length, before, 'storage requests are never logged');
    assert.deepEqual(
      (api.state().storage_fetches as Tx[]).map((f) => [f.file_key, f.status, f.had_credentials]),
      [[key, 200, false], [key, 403, false], [key, 403, false], [key, 405, false]],
    );
  });

  it('storage: 404 NOT_FOUND for a validly signed unknown key; credentials are recorded', async () => {
    const api = fake();
    const redirect = await api.handle(request('GET', '/v1/files/00000000-0000-4000-8000-000000100200/download'));
    const location = redirect.headers.get('location')!;
    const withToken = await api.handle(new Request(location, { headers: { authorization: `Bearer ${TOKEN}` } }));
    assert.equal(withToken.status, 200);
    await api.handle(new Request(location, { headers: { cookie: 'a=b' } }));
    api.files.delete('00000000-0000-4000-8000-000000100200');
    const gone = await api.handle(new Request(location));
    assert.deepEqual([gone.status, await gone.json()], [404, envelope('NOT_FOUND', 'Not found')]);
    assert.deepEqual(
      (api.state().storage_fetches as Tx[]).map((f) => [f.status, f.had_credentials]),
      [[200, true], [200, true], [404, false]],
    );
  });

  it('gives uploads deterministic file keys (API.md §7.3)', async () => {
    const urls = [];
    for (let i = 0; i < 2; i++) {
      const api = fake();
      const r = await json(api, 'POST', `${C}/transactions/1005/attachments`, { body: uploadForm() });
      urls.push(r.body.attachments[0].document.file.download_url);
    }
    assert.equal(urls[0], urls[1]);
    const h = createHash('sha256').update('mini-test:upload:0').digest('hex');
    const key = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    assert.equal(urls[0], `/v1/files/${key}/download`);
  });

  it('uploads several files at once, keeping each part’s content type', async () => {
    const api = fake();
    // Hand-written multipart. A part without Content-Type is read as text/plain by the runtime's
    // multipart parser (as in the old server), so the extension fallback only covers empty types.
    const part = (headers: string, content: string) => `--b0\r\n${headers}\r\n\r\n${content}\r\n`;
    const body =
      part('Content-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: text/x-custom', '%PDF-1.4') +
      part('Content-Disposition: form-data; name="file"; filename="photo.JPG"', 'jpeg bytes') +
      part('Content-Disposition: form-data; name="note"', 'ignored') +
      part('Content-Disposition: form-data; name="other"; filename="ignored.pdf"', 'x') +
      '--b0--\r\n';
    const r = await json(api, 'POST', `${C}/transactions/1005/attachments`, {
      body,
      headers: { 'content-type': 'multipart/form-data; boundary=b0' },
    });
    assert.deepEqual(
      r.body.attachments.map((a: Tx) => [a.document.file.name, a.document.file.mime_type]),
      [['a.pdf', 'text/x-custom'], ['photo.JPG', 'text/plain']],
    );
    const keys = r.body.attachments.map((a: Tx) => a.document.file.download_url);
    assert.notEqual(keys[0], keys[1]);
    assert.deepEqual((lastWrite(api).body as Tx).fields, { note: 'ignored' });
  });

  it('refuses an upload without a file part, and 404s for unknown transactions and files', async () => {
    const api = fake();
    for (const body of [{ json: {} }, { body: new URLSearchParams({ file: 'x' }) }, { body: (() => {
      const f = new FormData();
      f.append('document', new Blob([new Uint8Array([1]) as Uint8Array<ArrayBuffer>]), 'x.pdf');
      return f;
    })() }]) {
      const r = await json(api, 'POST', `${C}/transactions/1005/attachments`, body);
      assert.deepEqual([r.status, r.body], [400, envelope(
        'FILE_REQUIRED',
        'Expected multipart/form-data with at least one "file" part',
      )]);
    }
    assert.equal(lastWrite(api).errorCode, 'FILE_REQUIRED');
    assert.equal((await json(api, 'POST', `${C}/transactions/999/attachments`, { body: uploadForm() })).status, 404);
    assert.equal((await api.handle(request('GET', '/v1/files/nope/download'))).status, 404);
    assert.equal((await api.handle(request('GET', '/v1/files/nope/download', { authorization: null }))).status, 401);
  });

  it('attaches an existing document (form, JSON or multipart) and detaches attachments', async () => {
    const api = fake();
    const r = await json(api, 'POST', `${C}/transactions/1005/attachments/existing`, {
      body: new URLSearchParams({ document_id: '100300' }),
    });
    assert.equal(r.status, 200);
    const att = r.body.attachments[0];
    assert.deepEqual([att.removable, att.document.id, att.document.purchase_invoice_id], [true, 100300, 'vi-1003']);
    assert.notEqual(att.id, 100300, 'a new attachment id');
    assert.equal(
      lastWrite(api).after!.attachments[0]!.sha256,
      (api.state().files as Tx)['00000000-0000-4000-8000-000000100300'].sha256,
    );
    assert.deepEqual(lastWrite(api).body, { document_id: '100300' });
    const viaJson = await json(api, 'POST', `${C}/transactions/1008/attachments/existing`, { json: { document_id: 100200 } });
    assert.equal(viaJson.body.attachments[0].document.file.name, 'saas-2026-06.pdf');
    const form = new FormData();
    form.append('document_id', '100200');
    const viaMultipart = await json(api, 'POST', `${C}/transactions/1004/attachments/existing`, { body: form });
    assert.equal(viaMultipart.body.attachments[0].document.id, 100200);

    const del = await api.handle(request('DELETE', `${C}/transactions/1005/attachments/${att.id}`));
    assert.equal(del.status, 204);
    assert.deepEqual((await getTx(api, 1005)).attachments, []);
    assert.deepEqual([lastWrite(api).changed, lastWrite(api).accepted, lastWrite(api).body], [true, true, null]);
    // Idempotent; unknown transaction 404.
    assert.equal((await api.handle(request('DELETE', `${C}/transactions/1005/attachments/${att.id}`))).status, 204);
    assert.equal(lastWrite(api).changed, false);
    assert.equal((await api.handle(request('DELETE', `${C}/transactions/999/attachments/1`))).status, 404);
  });

  it('refuses unknown documents with 404 DOCUMENT_NOT_FOUND', async () => {
    const api = fake();
    for (const init of [{ json: { document_id: 42 } }, { json: {} }, { body: new URLSearchParams({ documentId: '100300' }) }]) {
      const r = await json(api, 'POST', `${C}/transactions/1005/attachments/existing`, init);
      assert.equal(r.status, 404);
      assert.equal(r.body.error.code, 'DOCUMENT_NOT_FOUND');
      assert.equal(r.body.error.message, 'Document not found');
    }
    assert.deepEqual(
      (await json(api, 'POST', `${C}/transactions/1005/attachments/existing`, { json: { document_id: 42 } })).body.error.details,
      { document_id: '42' },
    );
    assert.equal(lastWrite(api).errorCode, 'DOCUMENT_NOT_FOUND');
    assert.equal((await json(api, 'POST', `${C}/transactions/999/attachments/existing`, { json: { document_id: 100300 } })).body.error.code, 'NOT_FOUND');
  });

  it('attachments ignore locks and validation', async () => {
    const api = fake();
    for (const id of [1001, 1003, 1007]) {
      const up = await json(api, 'POST', `${C}/transactions/${id}/attachments`, { body: uploadForm(`${id}.pdf`) });
      assert.equal(up.status, 200, `upload ${id}`);
      const link = await json(api, 'POST', `${C}/transactions/${id}/attachments/existing`, { json: { document_id: 100200 } });
      assert.equal(link.status, 200, `link ${id}`);
      const first = link.body.attachments[0].id;
      assert.equal((await api.handle(request('DELETE', `${C}/transactions/${id}/attachments/${first}`))).status, 204);
    }
  });
});

describe('write log and state (API.md §8–9)', () => {
  it('logs non-GET requests with the current mark, not reads', async () => {
    const api = fake();
    await getTx(api, 1005);
    await patchBody(api, 1005, { note: 'a' });
    api.log.addMark('turn-2');
    await patchBody(api, 1005, { note: 'b' });
    await api.handle(request('HEAD', `${C}/transactions/1005`));
    const recs = api.log.records;
    assert.deepEqual(recs.map((r) => [r.kind, r.seq, r.kind === 'mark' ? r.label : r.mark]), [
      ['write', 1, null],
      ['mark', 2, 'turn-2'],
      ['write', 3, 'turn-2'],
    ]);
    const w = recs[2] as RequestRecord;
    assert.deepEqual([w.before!.note, w.after!.note, w.changed, w.accepted, w.errorCode], ['a', 'b', true, true, null]);
    assert.deepEqual([w.method, w.path, w.opId, w.status, w.force], ['PATCH', `${C}/transactions/1005`, '1005', 200, false]);
    assert.match(w.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('records snapshots with the complete mutable state; opId only under a transaction path', async () => {
    const api = fake();
    await patchBody(api, 1003, { validated: false });
    const snap = lastWrite(api).before!;
    assert.deepEqual(Object.keys(snap).sort(), [
      'amount', 'attachments', 'date', 'direction', 'issues', 'lines', 'lock', 'note', 'source', 'status', 'validated',
    ]);
    assert.deepEqual([snap.direction, snap.source, snap.status, snap.lock], ['out', 'bank', 'active', { manual: false, period: false }]);
    assert.deepEqual(snap.attachments[0], {
      id: 100300,
      document_id: 100300,
      kind: 'purchase_invoice',
      purchase_invoice_id: 'vi-1003',
      name: 'cloud-2026-07.pdf',
      sha256: (api.state().files as Tx)['00000000-0000-4000-8000-000000100300'].sha256,
    });
    // Lines exactly as stored.
    await patchBody(api, 1005, {});
    assert.deepEqual(lastWrite(api).before!.lines, api.transactions.get('1005')!.lines);
    await json(api, 'POST', `${C}/nothing`, { json: {} });
    assert.deepEqual([lastWrite(api).opId, lastWrite(api).before, lastWrite(api).changed], [null, null, false]);
    await json(api, 'POST', `${C}/transactions/1005/attachments/existing`, { json: { document_id: 100300 } });
    assert.equal(lastWrite(api).opId, '1005');
  });

  it('exposes the documented state keys, internal flags and file hashes in the admin state only', async () => {
    const api = fake();
    await api.handle(request('POST', '/v1/auth/logout'));
    const state = api.state();
    assert.deepEqual(Object.keys(state).sort(), [
      'company', 'counters', 'files', 'fiscal_years', 'mark', 'scenario', 'storage_fetches', 'transactions', 'uploads', 'vat_returns',
    ]);
    assert.deepEqual(state.scenario, { id: 'mini-test', path: join(MINI, 'scenario.json'), seed: 0, as_of: '2026-08-20' });
    const txs = state.transactions as Tx[];
    assert.equal(txs.find((o) => o.id === 1007)!.frozen, true);
    assert.equal(txs.find((o) => o.id === 1005)!.frozen, false);
    const file = txs.find((o) => o.id === 1003)!.attachments[0].document.file;
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.equal(file.size, readFileSync(join(MINI, 'files', 'cloud-2026-07.pdf')).length);
    assert.deepEqual((state.files as Tx)['00000000-0000-4000-8000-000000100300'].origin, { scenario: 'files/cloud-2026-07.pdf' });
    assert.deepEqual((state.vat_returns as Tx[]).map((r) => [r.status, r.summary.id, 'boxes' in r]), [
      ['filed', 61, true], ['to_file', 71, true], ['upcoming', 81, true],
    ]);
    assert.deepEqual(state.counters, { unauthorized_responses: 0, remote_logouts: 1, auth_attempts: 1 });
    // The API never serves the hashes.
    assert.ok(!('sha256' in (await getTx(api, 1003)).attachments[0].document.file));
  });

  it('reloads a clean copy of the scenario', async () => {
    const api = fake();
    await patchBody(api, 1005, { note: 'changed' });
    await json(api, 'POST', `${C}/transactions/1005/attachments`, { body: uploadForm() });
    await api.handle(request('GET', '/v1/me', { authorization: null }));
    api.load(loadScenario(MINI));
    api.log.reset('mini-test');
    assert.equal((await getTx(api, 1005)).note, null);
    assert.deepEqual((await getTx(api, 1005)).attachments, []);
    assert.deepEqual(api.log.records, []);
    assert.deepEqual([api.uploads, api.storageFetches], [[], []]);
    assert.equal((api.state().counters as Tx).unauthorized_responses, 0);
  });

  it('appends records, marks and resets to the --log JSONL file', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fcb-log-')), 'run.jsonl');
    const api = new FakeCompta(loadScenario(MINI), { log: new WriteLog(file) });
    await patchBody(api, 1005, { note: 'a' });
    api.log.addMark('turn-2');
    api.log.reset('mini-test');
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.kind, l.seq ?? null]), [['write', 1], ['mark', 2], ['reset', null]]);
    assert.equal(lines[2].scenario, 'mini-test');
    assert.equal(lines[0].errorCode, null);
  });

  it('keeps the complete accounting payload of an update, without the bulky parts', () => {
    const line = { id: 21, amount: 10, category_id: 77, tax: { treatment: 'taxable', rate: 0.2, amount: 1.67 } };
    const digest = digestBody('/v1/companies/1/transactions/2', {
      id: 2,
      label: 'X',
      note: null,
      validated: true,
      bank: { account_id: 1 },
      attachments: [{ id: 1 }],
      lines: [line],
    });
    assert.deepEqual(digest, { id: 2, label: 'X', note: null, validated: true, lines: [line] });
    assert.deepEqual(digestBody('/v1/companies/1/transactions/2', [1, 2]), [1, 2]);
    assert.equal(digestBody('/v1/companies/1/transactions/2', 'x'), 'x');
    assert.equal(digestBody('/v1/companies/1/transactions/2', null), null);
    assert.deepEqual(digestBody('/v1/auth/login', 'x'), { passwordSent: false, codeSent: false, challengeSent: false });
  });
});

describe('complete change detection (every mutable field)', () => {
  const lineChanges: [string, unknown][] = [
    ['amount', 47],
    ['direction', 'in'],
    ['refund', true],
    ['category_id', null],
  ];
  for (const [field, value] of lineChanges)
    it(`line.${field} alone`, async () => {
      const api = fake();
      const r = await patch(api, await getTx(api, 1005), { [field]: value });
      assert.equal(r.status, 200);
      const rec = lastWrite(api);
      assert.equal(rec.changed, true, `${field}: changed`);
      assert.deepEqual(((rec.body as Tx).lines[0] as Tx)[field], value, `${field}: in the digest`);
      assert.notDeepEqual(rec.before!.lines[0], rec.after!.lines[0]);
    });

  const taxChanges: [string, unknown][] = [
    ['treatment', 'out_of_scope'],
    ['rate', 0.1],
    ['amount', 4.36],
    ['overridden', true],
  ];
  for (const [field, value] of taxChanges)
    it(`line.tax.${field} alone`, async () => {
      const api = fake();
      const tx = await getTx(api, 1005);
      const r = await patch(api, tx, tax(tx, { [field]: value }));
      assert.equal(r.status, 200);
      const rec = lastWrite(api);
      assert.equal(rec.changed, true, `${field}: changed`);
      assert.deepEqual((((rec.body as Tx).lines[0] as Tx).tax as Tx)[field], value, `${field}: in the digest`);
      assert.notDeepEqual(rec.before!.lines[0], rec.after!.lines[0]);
    });

  it('line.tax exemption', async () => {
    const api = fake();
    const tx = await getTx(api, 1005);
    const exempt = { treatment: 'exempt', rate: null, amount: 0, exemption_reason: 'purchase_non_eu' };
    await patch(api, tx, tax(tx, exempt));
    assert.deepEqual([lastWrite(api).changed, lastWrite(api).after!.lines[0]!.tax.exemption_reason], [true, 'purchase_non_eu']);
  });

  for (const [field, value] of [['note', 'note'], ['validated', true]] as const)
    it(`${field} alone`, async () => {
      const api = fake();
      const r = await patchBody(api, 1005, { [field]: value });
      assert.equal(r.status, 200);
      assert.equal(lastWrite(api).changed, true);
      assert.equal((lastWrite(api).body as Tx)[field], value);
    });

  it('a line added or removed on a reopened transaction', async () => {
    const api = fake();
    const reopened = (await patchBody(api, 1003, { validated: false })).body;
    const line = reopened.lines[0];
    await patchBody(api, 1003, { lines: [line, { ...line, id: line.id + 1, amount: 1 }] });
    assert.deepEqual([lastWrite(api).changed, lastWrite(api).after!.lines.length], [true, 2]);
    await patchBody(api, 1003, { lines: [] });
    assert.deepEqual([lastWrite(api).changed, lastWrite(api).after!.lines.length], [true, 0]);
  });

  it('transaction-level fields the update ignores stay unchanged (changed: false)', async () => {
    const api = fake();
    await patchBody(api, 1005, { amount: 1, date: '2020-01-01', label: 'X', direction: 'in', status: 'deleted', lock: { manual: true } });
    assert.equal(lastWrite(api).changed, false);
    assert.deepEqual([lastWrite(api).after!.amount, lastWrite(api).after!.date, lastWrite(api).after!.status], [48, '2026-07-20', 'active']);
  });
});

describe('validation rules (API.md §6.5)', () => {
  it('refuses to validate lines that do not add up to the transaction amount', async () => {
    const api = fake();
    const r = await patch(api, await getTx(api, 1005), { amount: 1 }, { validated: true });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.message, 'Transaction cannot be validated: its lines do not add up to the transaction amount');
    assert.deepEqual(r.body.error.details.problems, ['its lines do not add up to the transaction amount']);
    assert.deepEqual([lastWrite(api).accepted, lastWrite(api).changed, lastWrite(api).errorCode], [false, false, 'VALIDATION_FAILED']);
  });

  it('allows an unbalanced transaction while it is not validated', async () => {
    const api = fake();
    assert.equal((await patch(api, await getTx(api, 1005), { amount: 1 })).status, 200);
    assert.equal((await patchBody(api, 1005, { validated: true })).status, 400);
  });

  it('balances signed amounts across a split transaction (line direction and refunds)', async () => {
    const api = fake();
    const tx = await getTx(api, 1005);
    const [line] = tx.lines;
    const split = [
      { ...line, amount: 50 },
      { ...line, id: line.id + 1, amount: 2, direction: 'in', refund: true },
    ];
    const r = await patchBody(api, 1005, { validated: true, lines: split });
    assert.equal(r.status, 200);
    assert.equal(r.body.lines.length, 2);
    // Without any line there is nothing to balance.
    assert.equal((await patchBody(api, 1008, { validated: true, lines: [] })).status, 200);
  });

  it('refuses to validate zero VAT without a reason where the category requires one', async () => {
    const api = fake();
    api.categories.get(77)!.exemption_required = true;
    const tx = await getTx(api, 1005);
    const zero = tax(tx, { rate: null, amount: 0, overridden: true });
    const r = await patch(api, tx, zero, { validated: true });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /zero VAT without a required exemption reason/);
    const exempt = tax(tx, { treatment: 'exempt', rate: null, amount: 0, exemption_reason: 'purchase_not_applicable' });
    assert.equal((await patch(api, tx, exempt, { validated: true })).status, 200);
    // Not required by the category, or outside VAT: no reason needed.
    const api2 = fake();
    assert.equal((await patch(api2, tx, zero, { validated: true })).status, 200);
    const api3 = fake();
    api3.categories.get(77)!.exemption_required = true;
    assert.equal((await patch(api3, tx, tax(tx, { treatment: 'out_of_scope', rate: null, amount: 0 }), { validated: true })).status, 200);
  });

  it('refuses to validate with issues or an uncategorized line, listing every problem', async () => {
    const api = fake();
    assert.match((await patchBody(api, 1004, { validated: true })).body.error.message, /a line is uncategorized/);
    api.transactions.get('1004')!.issues = [{ code: 'synthetic' }];
    const both = await patchBody(api, 1004, { validated: true });
    assert.deepEqual(both.body.error.details.problems, ['it has 1 issue(s)', 'a line is uncategorized']);
    assert.equal(both.body.error.message, 'Transaction cannot be validated: it has 1 issue(s); a line is uncategorized');
  });
});

describe('document registry', () => {
  it('re-attaches a detached document by its id', async () => {
    const api = fake();
    assert.equal((await api.handle(request('DELETE', `${C}/transactions/1002/attachments/100200`))).status, 204);
    const r = await json(api, 'POST', `${C}/transactions/1002/attachments/existing`, {
      body: new URLSearchParams({ document_id: '100200' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.attachments[0].document.file.name, 'saas-2026-06.pdf');
    assert.match(lastWrite(api).after!.attachments[0]!.sha256!, /^[0-9a-f]{64}$/);
  });

  it('knows uploaded documents too, after they are detached', async () => {
    const api = fake();
    const up = await json(api, 'POST', `${C}/transactions/1005/attachments`, { body: uploadForm() });
    const att = up.body.attachments[0];
    await api.handle(request('DELETE', `${C}/transactions/1005/attachments/${att.id}`));
    const r = await json(api, 'POST', `${C}/transactions/1008/attachments/existing`, {
      body: new URLSearchParams({ document_id: String(att.document.id) }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.attachments[0].document.file.download_url, att.document.file.download_url);
    assert.equal(r.body.attachments[0].document.kind, 'unclassified');
  });
});

// ── the real server (main.ts): HTTPS API port and admin port ───────────────

const ROOT = resolve(import.meta.dirname, '..', '..');
const CERTS = join(ROOT, '.certs');

describe('main.ts over HTTP (admin port API.md §8, 500 envelope)', () => {
  let server: ChildProcess;
  let ready: { ready: boolean; apiPort: number; adminPort: number; adminToken: string };
  let ca: Buffer;
  const ADMIN = 'unit-test-admin-token';

  before(async () => {
    execFileSync(join(ROOT, 'scripts', 'make-certs.sh'), { stdio: 'ignore' });
    ca = readFileSync(join(CERTS, 'ca.pem'));
    server = spawn(
      process.execPath,
      [
        join(ROOT, 'server', 'src', 'main.ts'),
        '--scenario', MINI,
        '--api-port', '0',
        '--admin-port', '0',
        '--cert', join(CERTS, 'server.pem'),
        '--key', join(CERTS, 'server-key.pem'),
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, CFO_BENCH_ADMIN_TOKEN: ADMIN } },
    );
    const line = await new Promise<string>((ok, fail) => {
      createInterface({ input: server.stdout! }).once('line', ok);
      server.once('exit', (code) => fail(new Error(`server exited (${code})`)));
    });
    ready = JSON.parse(line);
  });

  after(() => server?.kill());

  async function admin(method: string, path: string, body?: string, token: string | null = ADMIN) {
    const res = await fetch(`http://127.0.0.1:${ready.adminPort}${path}`, {
      method,
      headers: token === null ? {} : { 'x-admin-token': token },
      body,
    });
    return { status: res.status, body: await res.json() };
  }

  function api(method: string, path: string, headers: Record<string, string> = {}, host = 'localhost') {
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((ok, fail) => {
      const all: Record<string, string> = { authorization: `Bearer ${TOKEN}`, ...headers };
      if (!all.authorization) delete all.authorization;
      const req = httpsRequest(
        { host, port: ready.apiPort, path, method, ca, headers: all },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => ok({ status: res.statusCode!, headers: res.headers, body }));
        },
      );
      req.on('error', fail);
      req.end();
    });
  }

  it('prints the ready line with the token from CFO_BENCH_ADMIN_TOKEN', () => {
    assert.equal(ready.ready, true);
    assert.equal(ready.adminToken, ADMIN);
    assert.ok(ready.apiPort > 0 && ready.adminPort > 0);
  });

  it('admin: every request needs X-Admin-Token; errors use the envelope', async () => {
    for (const token of [null, 'wrong'])
      assert.deepEqual(await admin('GET', '/__health', undefined, token), {
        status: 401,
        body: envelope('UNAUTHENTICATED', 'X-Admin-Token required'),
      });
    assert.deepEqual(await admin('GET', '/__nothing'), { status: 404, body: envelope('NOT_FOUND', 'Not found') });
    for (const body of ['{"label": ""}', '{}', '{"label": 3}', '{']) {
      const r = await admin('POST', '/__mark', body);
      assert.deepEqual([r.status, r.body.error.code], [400, 'INVALID_PARAMETER'], body);
    }
    const reset = await admin('POST', '/__reset', JSON.stringify({ scenario: '/nonexistent/scenario' }));
    assert.deepEqual([reset.status, reset.body.error.code], [400, 'INVALID_PARAMETER']);
  });

  it('admin: health, mark, log, state and reset', async () => {
    assert.deepEqual(await admin('GET', '/__health'), { status: 200, body: { ok: true, scenario: 'mini-test' } });
    const mark = await admin('POST', '/__mark', JSON.stringify({ label: 'turn-1' }));
    assert.deepEqual([mark.status, mark.body.kind, mark.body.label], [200, 'mark', 'turn-1']);
    const r = await api('PATCH', `${C}/transactions/1005`, { 'content-type': 'application/json' });
    assert.equal(r.status, 400); // no body: INVALID_BODY
    const log = (await admin('GET', '/__log')).body;
    assert.deepEqual(log.map((x: Tx) => [x.kind, x.mark, x.errorCode ?? null]), [
      ['mark', undefined, null],
      ['write', 'turn-1', 'INVALID_BODY'],
    ]);
    const state = (await admin('GET', '/__state')).body;
    assert.equal(state.mark, 'turn-1');
    assert.equal(state.transactions.length, 8);
    const reset = await admin('POST', '/__reset', '');
    assert.deepEqual(reset, { status: 200, body: { ok: true, scenario: 'mini-test', transactions: 8 } });
    assert.deepEqual((await admin('GET', '/__log')).body, []);
    const again = await admin('POST', '/__reset', JSON.stringify({ scenario: join(MINI, 'scenario.json') }));
    assert.equal(again.body.transactions, 8);
  });

  it('API: bearer auth over HTTPS, storage on the other origin, 500 envelope', async () => {
    const me = await api('GET', '/v1/me');
    assert.deepEqual([me.status, JSON.parse(me.body).id], [200, 4242]);
    const denied = await api('GET', '/v1/me', { authorization: 'Bearer nope' });
    assert.deepEqual([denied.status, denied.headers['www-authenticate'], denied.headers['set-cookie']], [
      401, 'Bearer realm="compta"', undefined,
    ]);
    const redirect = await api('GET', '/v1/files/00000000-0000-4000-8000-000000100200/download');
    assert.equal(redirect.status, 302);
    const location = new URL(String(redirect.headers.location));
    assert.equal(location.origin, `https://127.0.0.1:${ready.apiPort}`);
    const file = await api('GET', `${location.pathname}${location.search}`, { authorization: '' }, '127.0.0.1');
    assert.equal(file.status, 200);
    // An unhandled failure (a malformed percent-encoding in a file key) answers the 500 envelope.
    const broken = await api('GET', '/v1/files/%E0%A4%A/download');
    assert.deepEqual([broken.status, JSON.parse(broken.body)], [500, envelope('INTERNAL_ERROR', 'Internal server error')]);
  });
});
