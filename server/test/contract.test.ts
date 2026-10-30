/**
 * Contract tests: the real server (subprocess, real TLS) driven by the real `compta` CLI build
 * (cli/dist/cli.js, override with COMPTA_CLI_JS). A passing run means every request the CLI makes
 * in these flows finds an endpoint of server/API.md with the shape the CLI expects.
 *
 * Safety: the CLI runs with a scratch HOME / XDG dirs, COMPTA_CREDENTIAL_STORE=file (never the
 * OS keychain), COMPTA_PROFILE=bench, a minimal environment (no inherited COMPTA_* variables) and
 * COMPTA_API_BASE pointing at the fake.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { LogRecord, RequestRecord } from '../src/log.ts';
import { ATELIER, MINI, makePdf } from './helpers.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CLI = process.env.COMPTA_CLI_JS ?? resolve(ROOT, 'cli', 'dist', 'cli.js');
const CERTS = join(ROOT, '.certs');
const ADMIN_TOKEN = 'contract-test-admin-token';

type Any = Record<string, any>;

const MINI_SCENARIO = JSON.parse(readFileSync(join(MINI, 'scenario.json'), 'utf8')) as Any;
const TOKEN: string = MINI_SCENARIO.api_token;
const COMPANY = String(MINI_SCENARIO.company.id);

let server: ChildProcess;
let apiPort = 0;
let adminPort = 0;
let ca: Buffer;

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
      '--admin-token', ADMIN_TOKEN,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const line = await new Promise<string>((ok, fail) => {
    createInterface({ input: server.stdout! }).once('line', ok);
    server.once('exit', (code) => fail(new Error(`server exited (${code})`)));
  });
  const ready = JSON.parse(line) as { ready: boolean; apiPort: number; adminPort: number; adminToken: string };
  assert.equal(ready.ready, true);
  assert.equal(ready.adminToken, ADMIN_TOKEN);
  ({ apiPort, adminPort } = ready);
});

after(() => {
  server?.kill();
});

// ── helpers ─────────────────────────────────────────────────────────

async function admin(method: string, path: string, body?: unknown, token = ADMIN_TOKEN): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${adminPort}${path}`, {
    method,
    headers: { 'x-admin-token': token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const state = async () => (await admin('GET', '/__state')).body as Any;
const writes = async () =>
  ((await admin('GET', '/__log')).body as LogRecord[]).filter((r): r is RequestRecord => r.kind !== 'mark');
const tx = async (id: number) => ((await state()).transactions as Any[]).find((t) => t.id === id)!;

/** A direct HTTPS request to the API port, trusting the local CA (no CLI involved). */
function api(
  method: string,
  path: string,
  options: { body?: unknown; auth?: boolean } = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: any }> {
  return new Promise((ok, fail) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpsRequest(
      {
        host: 'localhost',
        port: apiPort,
        path,
        method,
        ca,
        headers: {
          'user-agent': 'cfo-bench-contract-test',
          ...(options.auth === false ? {} : { authorization: `Bearer ${TOKEN}` }),
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          ok({ status: res.statusCode!, headers: res.headers, body: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on('error', fail);
    req.end(payload);
  });
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: () => any;
  error: () => { code: string; message: string; hint?: string };
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'cfo-bench-contract-'));
}

/** Logged in like the harness sandbox (bench/harness/sandbox.py), profile "bench". */
function loggedInHome(session = TOKEN, company = COMPANY): string {
  const home = scratch();
  const dir = join(home, 'config', 'compta-cli');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      activeProfile: 'bench',
      profiles: { bench: { session, source: 'token', companyId: company } },
    }),
    { mode: 0o600 },
  );
  return home;
}

function cli(args: string[], options: { cwd?: string; home?: string; stdin?: string } = {}): Promise<CliResult> {
  const home = options.home ?? loggedInHome();
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    COMPTA_CREDENTIAL_STORE: 'file',
    COMPTA_PROFILE: 'bench',
    COMPTA_API_BASE: `https://localhost:${apiPort}`,
    NODE_EXTRA_CA_CERTS: join(CERTS, 'ca.pem'),
    NO_COLOR: '1',
  };
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: options.cwd ?? home, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c));
    child.stderr.on('data', (c: Buffer) => (stderr += c));
    child.stdin.end(options.stdin ?? '');
    child.on('error', fail);
    child.on('close', (code) =>
      ok({
        code: code ?? -1,
        stdout,
        stderr,
        json: () => JSON.parse(stdout),
        error: () => JSON.parse(stderr.trim().split('\n').at(-1) ?? '{}').error,
      }),
    );
  });
}

function expectExit(r: CliResult, code: number): void {
  assert.equal(r.code, code, `exit ${r.code}, expected ${code}\nstdout: ${r.stdout.slice(0, 2000)}\nstderr: ${r.stderr.slice(0, 2000)}`);
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const EXEMPT_OUTSIDE_EU = 'purchase_non_eu';

beforeEach(async () => {
  const r = await admin('POST', '/__reset', { scenario: MINI });
  assert.deepEqual(r.body, { ok: true, scenario: 'mini-test', transactions: 8 });
});

// ── admin port ──────────────────────────────────────────────────────

describe('admin port', () => {
  it('requires the admin token', async () => {
    assert.equal((await admin('GET', '/__health', undefined, 'wrong')).status, 401);
    assert.deepEqual((await admin('GET', '/__health')).body, { ok: true, scenario: 'mini-test' });
  });
});

// ── read commands ───────────────────────────────────────────────────

describe('reads with the real CLI', () => {
  it('doctor: every check passes, no schema drift', async () => {
    const r = await cli(['doctor', '--json']);
    expectExit(r, 0);
    const d = r.json();
    assert.equal(d.ok, true);
    assert.ok(d.checks.every((c: Any) => c.ok && !c.warning || c.name === 'expiry'));
    assert.deepEqual([d.schema.valid, d.schema.issues, d.schema.unknownFields, d.schema.missingFields], [true, [], [], []]);
  });

  it('login --check and whoami', async () => {
    expectExit(await cli(['login', '--check', '--json']), 0);
    const r = await cli(['whoami', '--json']);
    expectExit(r, 0);
    assert.deepEqual(
      [r.json().user.id, r.json().activeCompany, r.json().profile, r.json().companies],
      ['4242', COMPANY, 'bench', [{ id: COMPANY, name: 'Fictional Test Widgets' }]],
    );
  });

  it('ops list --all, ops get', async () => {
    const list = await cli(['ops', 'list', '--all', '--json']);
    expectExit(list, 0);
    assert.deepEqual(
      list.json().map((o: Any) => o.id),
      ['1008', '1007', '1006', '1005', '1004', '1003', '1002', '1001'],
    );
    const get = await cli(['ops', 'get', '1003', '--json']);
    expectExit(get, 0);
    assert.equal(get.json().attachments[0].vendorInvoiceId, 'vi-1003');
    assert.equal(get.json().vatAmount, 20);
    expectExit(await cli(['ops', 'get', '424242', '--json']), 4);
  });

  it('categories list, accounts list', async () => {
    const cats = await cli(['categories', 'list', '--json']);
    expectExit(cats, 0);
    assert.equal(cats.json().length, 6);
    const accounts = await cli(['accounts', 'list', '--json']);
    expectExit(accounts, 0);
    assert.deepEqual(accounts.json().map((a: Any) => [a.id, a.balance]), [['501', 1234.56]]);
  });

  it('export (csv and json)', async () => {
    const csv = await cli(['export', '--from', '2026-01-01', '--to', '2026-12-31']);
    expectExit(csv, 0);
    const lines = csv.stdout.trim().split('\n');
    assert.equal(lines.length, 1 + 7);
    const json = await cli(['export', '--format', 'json']);
    expectExit(json, 0);
    assert.equal(json.json().length, 8);
  });

  it('todo surfaces the overdue declaration and the uncategorized operation', async () => {
    const r = await cli(['todo', '--json']);
    expectExit(r, 0);
    const items = r.json() as Any[];
    const first = items[0]!;
    assert.deepEqual(first.op, null);
    assert.equal(first.reasons[0].code, 'OVERDUE_DECLARATION');
    assert.deepEqual([first.declaration.id, first.declaration.isLate], ['71', true]);
    const uncategorized = items.find((i) => i.op?.id === '1004')!;
    assert.ok(uncategorized.reasons.some((x: Any) => x.code === 'UNCATEGORIZED'));
  });

  it('vat check finds the reverse charge from the platform’s invoice reading; the plan applies', async () => {
    const cwd = scratch();
    const r = await cli(['vat', 'check', '--from', '2026-07-01', '--to', '2026-07-31', '--plan', 'vat.plan.json', '--json'], { cwd });
    expectExit(r, 0);
    const report = r.json();
    const suspect = report.findings.find((f: Any) => f.code === 'REVERSE_CHARGE_SUSPECT');
    assert.deepEqual(
      [suspect.op.id, suspect.severity, suspect.evidence.document.source, suspect.evidence.document.country],
      ['1003', 'error', 'vendor-invoice', 'US'],
    );
    assert.equal(report.meta.fixes, 1);
    const plan = JSON.parse(readFileSync(join(cwd, 'vat.plan.json'), 'utf8'));
    assert.deepEqual(plan.steps.map((s: Any) => [s.op, s.set]), [['1003', { vatExempt: 'outside-eu' }]]);

    const applied = await cli(['apply', 'vat.plan.json', '--yes', '--json'], { cwd });
    expectExit(applied, 0);
    assert.deepEqual([applied.json().meta.applied, applied.json().meta.sideEffects], [1, 0]);
    const line = (await tx(1003)).lines[0];
    assert.deepEqual([line.tax.amount, line.tax.exemption_reason], [0, EXEMPT_OUTSIDE_EU]);
    assert.equal((await tx(1003)).validated, true);
  });

  it('vat summary compares with the filed return, and with the platform’s draft for an open month', async () => {
    const june = await cli(['vat', 'summary', '--month', '2026-06', '--json']);
    expectExit(june, 0);
    const s = june.json();
    assert.deepEqual([s.meta.declaration.id, s.meta.declaration.filed, s.meta.declaration.hasForm], ['61', true, true]);
    const box20 = s.lines.find((l: Any) => l.box === '20');
    assert.deepEqual([box20.estimate, box20.declared, box20.difference], [20, 20, 0]);
    const july = await cli(['vat', 'summary', '--month', '2026-07', '--json']);
    expectExit(july, 0);
    const j = july.json();
    assert.deepEqual([j.meta.declaration.filed, j.meta.declaration.isLate], [false, true]);
    assert.equal(j.lines.find((l: Any) => l.box === 'A1').declared, 1000);
    // Box 22 is box 27 of the last filed return (June).
    assert.equal(j.lines.find((l: Any) => l.box === '22').estimate, 20);
  });

  it('rules init on validated history, then rules apply --plan', async () => {
    const cwd = scratch();
    const init = await cli(['rules', 'init', '--min-count', '1', '--json'], { cwd });
    expectExit(init, 0);
    assert.ok(init.json().rules >= 1);
    assert.ok(existsSync(join(cwd, 'compta.rules.json')));
    const r = await cli(['rules', 'apply', '--plan', 'rules.plan.json', '--json'], { cwd });
    expectExit(r, 0);
    assert.equal(r.json().meta.plan, 'rules.plan.json');
    assert.equal(r.json().meta.operations, 3); // the unvalidated ones
    assert.equal(JSON.parse(readFileSync(join(cwd, 'rules.plan.json'), 'utf8')).company, COMPANY);
  });

  it('close-check --year', async () => {
    const r = await cli(['close-check', '--year', '2026', '--json']);
    expectExit(r, 0);
    assert.deepEqual([r.json().meta.from, r.json().meta.to, r.json().meta.operations], ['2026-01-01', '2026-12-31', 7]);
  });

  it('ops download follows the 302 to the storage origin without credentials', async () => {
    const out = scratch();
    const r = await cli(['ops', 'download', '1003', '-o', out, '--json']);
    expectExit(r, 0);
    assert.equal(r.json()[0].status, 'downloaded');
    const got = readFileSync(join(out, '1003_cloud-2026-07.pdf'));
    assert.deepEqual(got, readFileSync(join(MINI, 'files', 'cloud-2026-07.pdf')));
    const fetches = (await state()).storage_fetches as Any[];
    assert.deepEqual(fetches.map((f) => [f.file_key, f.status, f.had_credentials]), [
      ['00000000-0000-4000-8000-000000100300', 200, false],
    ]);
    assert.deepEqual(await writes(), []);
  });
});

// ── writes ──────────────────────────────────────────────────────────

describe('writes with the real CLI', () => {
  it('receipts match → plan → apply uploads the file; the log has its sha256', async () => {
    const cwd = scratch();
    mkdirSync(join(cwd, 'inbox'));
    const pdf = makePdf(['NIMBUS HOSTING GMBH', 'Invoice date 2026-07-19', 'Total TTC 48,00 EUR']);
    writeFileSync(join(cwd, 'inbox', 'nimbus-2026-07.pdf'), pdf);
    writeFileSync(join(cwd, 'inbox', 'unknown.pdf'), makePdf(['Some vendor', 'Total 777,00 EUR', 'Date 2026-07-03']));
    const match = await cli(['receipts', 'match', 'inbox', '--plan', 'p.json', '--json'], { cwd });
    expectExit(match, 0);
    assert.deepEqual(
      [match.json().meta.matched, match.json().meta.unmatched, match.json().matched[0].best.op],
      [1, 1, '1005'],
    );
    assert.deepEqual(await writes(), [], 'matching writes nothing');

    const applied = await cli(['apply', 'p.json', '--yes', '--report', 'r.json', '--json'], { cwd });
    expectExit(applied, 0);
    const report = JSON.parse(readFileSync(join(cwd, 'r.json'), 'utf8'));
    assert.deepEqual([report.meta.applied, report.results[0].status], [1, 'applied']);

    const [upload] = await writes();
    assert.deepEqual([upload!.method, upload!.path], ['POST', `/v1/companies/${COMPANY}/transactions/1005/attachments`]);
    assert.deepEqual([upload!.accepted, upload!.changed], [true, true]);
    assert.deepEqual((upload!.body as Any).files, [
      { field: 'file', name: 'nimbus-2026-07.pdf', size: pdf.length, sha256: sha(pdf), mimeType: 'application/pdf' },
    ]);
    assert.equal(upload!.after!.attachments[0]!.sha256, sha(pdf));
    const s = await state();
    assert.equal(s.uploads[0].sha256, sha(pdf));
    const file = (await tx(1005)).attachments[0].document.file;
    assert.deepEqual([file.name, file.sha256], ['nimbus-2026-07.pdf', sha(pdf)]);

    // Matching again: the document is already there.
    const again = await cli(['receipts', 'match', 'inbox', '--json'], { cwd });
    assert.equal(again.json().meta.alreadyAttached, 1);
  });

  it('ops set --vat-exempt on a validated operation: reopen, one update, revalidate', async () => {
    const r = await cli(['ops', 'set', '1003', '--vat-exempt', 'outside-eu', '--yes', '--json']);
    expectExit(r, 0);
    assert.deepEqual([r.json().meta.applied, r.json().meta.sideEffects], [1, 0]);
    const t = await tx(1003);
    assert.deepEqual([t.validated, t.lines[0].tax.amount, t.lines[0].tax.exemption_reason], [true, 0, EXEMPT_OUTSIDE_EU]);
    const log = await writes();
    assert.deepEqual(
      log.map((w) => [
        w.method,
        Object.keys(w.body as Any).sort().join(','),
        w.after!.validated,
        w.after!.lines[0]!.tax.amount,
        w.after!.lines[0]!.tax.exemption_reason,
        w.accepted,
      ]),
      [
        ['PATCH', 'validated', false, 20, null, true], // reopen
        ['PATCH', 'lines', false, 0, EXEMPT_OUTSIDE_EU, true], // the exemption: no VAT and the reason
        ['PATCH', 'validated', true, 0, EXEMPT_OUTSIDE_EU, true], // validate again
      ],
    );
    assert.ok(log.every((w) => w.path === `/v1/companies/${COMPANY}/transactions/1003` && w.errorCode === null));
  });

  it('categorizing an uncategorized operation reports the VAT side effect (exit 7)', async () => {
    const r = await cli(['ops', 'set', '1004', '--category', '77', '--yes', '--json']);
    expectExit(r, 7);
    const result = r.json().results[0];
    assert.equal(result.status, 'applied');
    const fields = Object.fromEntries(result.sideEffects.map((e: Any) => [e.field, [e.from, e.to]]));
    assert.deepEqual(fields['breakdown 10041 vatAmount'], [0, 6]);
    assert.deepEqual(fields['breakdown 10041 vatRate'], [null, 20]);
    assert.equal((await tx(1004)).lines[0].tax.amount, 6);
    const [write] = await writes();
    assert.deepEqual([write!.method, Object.keys(write!.body as Any)], ['PATCH', ['lines']]);
    assert.equal((write!.body as Any).lines[0].category_id, 77);
  });

  it('refuses an edit in a filed CA3 month (exit 2, nothing sent) unless --allow-filed-periods', async () => {
    const refused = await cli(['ops', 'set', '1002', '--memo', 'checked', '--yes', '--json']);
    expectExit(refused, 2);
    assert.equal(refused.error().code, 'FILED_PERIOD');
    assert.deepEqual(await writes(), []);

    const allowed = await cli(['ops', 'set', '1002', '--memo', 'checked', '--yes', '--allow-filed-periods', '--json']);
    expectExit(allowed, 0);
    const log = await writes();
    assert.ok(log.length >= 3 && log.every((w) => w.accepted && w.opId === '1002'));
    assert.deepEqual([(await tx(1002)).note, (await tx(1002)).validated], ['checked', true]);
    assert.ok(log.some((w) => (w.body as Any).note === 'checked'));
  });

  it('refuses a locked operation before sending anything (exit 5); the server refuses it too', async () => {
    const r = await cli(['ops', 'set', '1001', '--memo', 'x', '--yes', '--json']);
    expectExit(r, 5);
    assert.equal(r.error().code, 'LOCKED');
    assert.deepEqual(await writes(), []);

    const current = (await api('GET', `/v1/companies/${COMPANY}/transactions/1001`)).body;
    assert.deepEqual(current.lock, { manual: false, period: true });
    const refused = await api('PATCH', `/v1/companies/${COMPANY}/transactions/1001`, { body: { note: 'x' } });
    assert.equal(refused.status, 423);
    assert.deepEqual(refused.body, {
      error: { code: 'PERIOD_LOCKED', message: 'This transaction is locked.', details: { transaction_id: 1001 } },
    });
    const forced = await api('PATCH', `/v1/companies/${COMPANY}/transactions/1001?override_lock=true`, {
      body: { validated: false },
    });
    assert.equal(forced.status, 200);
    assert.deepEqual(
      (await writes()).map((w) => [w.method, w.status, w.accepted, w.errorCode, w.force, w.changed]),
      [
        ['PATCH', 423, false, 'PERIOD_LOCKED', false, false],
        ['PATCH', 200, true, null, true, true],
      ],
    );
  });

  it('logs login attempts (direct and through the CLI) as auth records', async () => {
    const direct = await api('POST', '/v1/auth/login', {
      body: { email: 'someone@example.test', password: 'not-a-real-password' },
      auth: false,
    });
    assert.deepEqual([direct.status, direct.body.error.code, direct.body.error.message], [401, 'INVALID_CREDENTIALS', 'Invalid email or password']);
    const r = await cli(['login', '--email', 'someone@example.test', '--json'], {
      home: scratch(),
      stdin: 'not-a-real-password\n',
    });
    expectExit(r, 3);
    const log = await writes();
    assert.deepEqual(log.map((w) => [w.kind, w.method, w.path, w.status, w.errorCode]), [
      ['auth', 'POST', '/v1/auth/login', 401, 'INVALID_CREDENTIALS'],
      ['auth', 'POST', '/v1/auth/login', 401, 'INVALID_CREDENTIALS'],
    ]);
    assert.deepEqual(log.map((w) => (w.body as Any).passwordSent), [true, true]);
    assert.doesNotMatch(JSON.stringify(log), /not-a-real-password/);
    assert.equal((await state()).counters.auth_attempts, 2);
  });

  it('logout --remote is an auth record; the token stays valid', async () => {
    const home = loggedInHome();
    const r = await cli(['logout', '--remote', '--json'], { home });
    expectExit(r, 0);
    assert.equal(r.json().remote, true);
    const log = await writes();
    assert.deepEqual(log.map((w) => [w.kind, w.method, w.path, w.status]), [['auth', 'POST', '/v1/auth/logout', 204]]);
    const s = await state();
    assert.deepEqual([s.counters.remote_logouts, s.counters.auth_attempts], [1, 1]);
    assert.equal((await api('GET', '/v1/me')).status, 200);
  });

  it('a request without the bearer token gets 401 and is counted', async () => {
    const before = (await state()).counters.unauthorized_responses;
    const r = await api('GET', `/v1/companies/${COMPANY}/transactions`, { auth: false });
    assert.deepEqual([r.status, r.headers['www-authenticate'], r.body.error.code], [401, 'Bearer realm="compta"', 'UNAUTHENTICATED']);
    assert.equal((await state()).counters.unauthorized_responses, before + 1);
    const home = loggedInHome('wrong-token-123456');
    const who = await cli(['ops', 'list', '--json'], { home });
    expectExit(who, 3);
    assert.equal(who.error().code, 'AUTH_EXPIRED');
  });

  it('/__mark splits the log between turns', async () => {
    const one = await cli(['ops', 'set', '1005', '--memo', 'turn one', '--yes', '--json']);
    expectExit(one, 0);
    assert.equal((await admin('POST', '/__mark', { label: 'turn-2' })).status, 200);
    expectExit(await cli(['ops', 'set', '1005', '--memo', 'turn two', '--yes', '--json']), 0);
    const log = (await admin('GET', '/__log')).body as LogRecord[];
    const markAt = log.findIndex((r) => r.kind === 'mark');
    assert.ok(markAt > 0);
    assert.ok(log.slice(0, markAt).every((r) => r.kind !== 'mark' && r.mark === null));
    assert.ok(log.slice(markAt + 1).every((r) => r.kind !== 'mark' && r.mark === 'turn-2'));
    assert.deepEqual(
      log.filter((r): r is RequestRecord => r.kind === 'write').map((r) => r.after!.note),
      ['turn one', 'turn two'],
    );
  });
});

// ── the generated scenario ──────────────────────────────────────────

describe('generated scenario (atelier-lumen-s1)', () => {
  it('the September draft follows an exemption made through the CLI', async () => {
    const scenario = JSON.parse(readFileSync(join(ATELIER, 'scenario.json'), 'utf8'));
    const truth = JSON.parse(readFileSync(join(ATELIER, 'truth.json'), 'utf8'));
    assert.equal((await admin('POST', '/__reset', { scenario: ATELIER })).body.transactions, scenario.transactions.length);
    const home = loggedInHome(scenario.api_token, String(scenario.company.id));
    const declared = async () => {
      const r = await cli(['vat', 'summary', '--month', '2026-09', '--json'], { home });
      expectExit(r, 0);
      assert.deepEqual([r.json().meta.declaration.filed, r.json().meta.declaration.hasForm], [false, true]);
      return Object.fromEntries((r.json().lines as Any[]).map((l) => [l.box, l.declared]));
    };
    const before = await declared();
    const opId = truth.issues.find((i: Any) => i.id === 'RC-OPEN-4').op; // Anthropic 91.63 €, 20 % VAT booked
    const set = await cli(['ops', 'set', opId, '--vat-exempt', 'outside-eu', '--yes', '--json'], { home });
    expectExit(set, 0);
    const after = await declared();
    assert.deepEqual(
      ['A3:02', '20:C', '20:A'].map((box) => [box, before[box], after[box]]),
      [
        ['A3:02', 0, 92],
        ['20:C', 0, 18],
        ['20:A', before['20:A'], before['20:A'] - 15],
      ],
    );
  });
});

// ── every command ───────────────────────────────────────────────────

/**
 * Runs every leaf command of `compta commands --json` against the server with minimal valid
 * arguments, mutating ones with --dry-run. Exit 6 means a missing endpoint or a response shape
 * the CLI rejects (API_SHAPE / network); exit 1 an unexpected crash. Neither may happen, and
 * the server must log no write at all.
 *
 * Skipped: `login` except `login --check` (interactive / would try to log in), `logout`
 * (would delete the session from the config file).
 */
const SKIP = new Set(['logout']);

function argsFor(path: string, cwd: string): string[] | null {
  const out = join(cwd, 'out');
  const table: Record<string, string[]> = {
    todo: [],
    'vat check': ['--from', '2026-07-01', '--to', '2026-08-31'],
    'vat summary': ['--month', '2026-07'],
    'rules apply': [], // uses ./compta.rules.json written by `rules init` below
    'rules init': ['--min-count', '1', '--force'],
    'close-check': ['--year', '2026'],
    'receipts download': ['-o', out],
    'receipts match': ['inbox'],
    apply: ['plan.json', '--dry-run'],
    'ops list': ['--all'],
    'ops get': ['1003'],
    'ops set': ['1005', '--memo', 'x', '--dry-run'],
    'ops attach': ['1005', 'inbox/receipt.pdf', '--dry-run'],
    'ops detach': ['1003', '100300', '--dry-run'],
    'ops validate': ['1008', '--dry-run'],
    'ops download': ['1002', '-o', out],
    'categories list': [],
    'accounts list': [],
    export: [],
    login: ['--check'],
    whoami: [],
    api: ['GET', '/v1/me'],
    skill: [],
    commands: [],
    schema: [],
    doctor: [],
  };
  return table[path] ?? null;
}

describe('every CLI command against the server', () => {
  it('no command hits a missing endpoint or an unexpected shape', async () => {
    const cwd = scratch();
    mkdirSync(join(cwd, 'inbox'));
    writeFileSync(join(cwd, 'inbox', 'receipt.pdf'), makePdf(['NIMBUS HOSTING', 'Date 2026-07-19', 'Total 48,00 EUR']));
    writeFileSync(
      join(cwd, 'plan.json'),
      JSON.stringify({
        version: 1,
        company: COMPANY,
        createdAt: '2026-08-20T00:00:00.000Z',
        createdBy: 'contract test',
        steps: [{ id: 's1', op: '1005', action: 'set', set: { memo: 'x' }, why: 'contract test' }],
      }),
    );
    const home = loggedInHome();
    const tree = (await cli(['commands', '--json'], { home, cwd })).json();
    const leaves: string[] = [];
    const walk = (c: Any) =>
      c.subcommands?.length ? c.subcommands.forEach(walk) : leaves.push(c.path.replace(/^compta /, ''));
    walk(tree);
    // `rules init` first so `rules apply` finds a rules file.
    leaves.sort((a, b) => Number(b === 'rules init') - Number(a === 'rules init'));
    assert.ok(leaves.length >= 25, `only ${leaves.length} commands found`);

    const results: [string, number][] = [];
    for (const path of leaves) {
      if (SKIP.has(path)) continue;
      const args = argsFor(path, cwd);
      assert.ok(args, `no arguments known for "${path}" (new command? add it to argsFor or SKIP)`);
      const r = await cli([...path.split(' '), ...args, '--json'], { home, cwd });
      results.push([path, r.code]);
      assert.ok(![1, 6].includes(r.code), `${path} exited ${r.code}: ${r.stderr.slice(-1000)}`);
    }
    assert.deepEqual(results.filter(([, code]) => code !== 0), []);
    assert.deepEqual(await writes(), [], 'read-only and --dry-run commands must not write');
  });
});
