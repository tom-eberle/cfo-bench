import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeCompta } from './helpers/fake-api.js';
import { COMPANY, rawOp } from './helpers/fixtures.js';
import { runCli, tempHome } from './helpers/run.js';

const sample = () =>
  new FakeCompta([
    rawOp({ id: 101, date: '2026-08-20', wording: 'CB ORBIT TOOLS', amount: 120 }),
    rawOp({
      id: 102,
      date: '2026-08-18',
      wording: 'PRLV NIMBUS HOSTING',
      amount: 30,
      validated: false,
      category: 'uncategorized',
      vatRate: null,
    }),
    rawOp({
      id: 103,
      date: '2026-08-10',
      wording: 'CLIENT ACME',
      amount: 1200,
      income: true,
      category: 'sales',
    }),
  ]);

describe('output modes', () => {
  it('prints JSON when stdout is not a terminal', async () => {
    const r = await runCli(sample(), ['ops', 'list']);
    expect(r.code).toBe(0);
    const ops = r.json() as { id: string }[];
    expect(ops.map((o) => o.id)).toEqual(['101', '102', '103']);
  });

  it('prints an aligned table in a terminal, and logs to stderr only', async () => {
    const r = await runCli(sample(), ['ops', 'list', '--no-color'], { stdoutIsTTY: true });
    expect(r.stdout).toMatch(/^ID\s+DATE\s+WORDING\s+AMOUNT/);
    expect(r.stdout).toContain('-120.00');
    expect(r.stdout).toContain('+1200.00');
    expect(r.stdout).toContain('uncategorized');
    expect(r.stderr).toContain('Fetching operations');
  });

  it('streams JSON lines with --jsonl', async () => {
    const r = await runCli(sample(), ['ops', 'list', '--jsonl']);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).id).toBe('101');
  });

  it('--json forces JSON even in a terminal; --quiet silences progress', async () => {
    const r = await runCli(sample(), ['ops', 'get', '101', '--json', '--quiet'], {
      stdoutIsTTY: true,
    });
    expect((r.json() as { id: string }).id).toBe('101');
    expect(r.stderr).toBe('');
  });
});

describe('errors and exit codes', () => {
  it('reports structured JSON errors on stderr', async () => {
    const r = await runCli(sample(), ['ops', 'get', '424242']);
    expect(r.code).toBe(4);
    expect(r.stdout).toBe('');
    expect(r.error()).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('exit 3 with a login hint when not logged in', async () => {
    const r = await runCli(sample(), ['ops', 'list'], { loggedIn: false });
    expect(r.code).toBe(3);
    expect(r.error()).toEqual({
      code: 'AUTH_MISSING',
      message: 'Not logged in (profile "default")',
      hint: 'run: compta login (or: compta login --with-token)',
    });
  });

  it('exit 3 when the session expired', async () => {
    const api = sample();
    api.session = 'rotated';
    const r = await runCli(api, ['ops', 'list'], {
      home: tempHome(),
      loggedIn: false,
      env: { COMPTA_SESSION: 'stale', COMPTA_COMPANY: COMPANY },
    });
    expect(r.code).toBe(3);
    expect(r.error().code).toBe('AUTH_EXPIRED');
  });

  it('exit 2 for usage errors, with human output in a terminal', async () => {
    const json = await runCli(sample(), ['ops', 'list', '--limit', 'many']);
    expect(json.code).toBe(2);
    expect(json.error().code).toBe('USAGE');
    const human = await runCli(sample(), ['nope'], { stdoutIsTTY: true });
    expect(human.code).toBe(2);
    expect(human.stderr).toMatch(/error Unknown command 'nope'/);
  });

  it('never prints the token, even with --verbose', async () => {
    const api = sample();
    const r = await runCli(api, ['ops', 'list', '--verbose', '--json'], { stdoutIsTTY: true });
    expect(r.stderr).toContain('GET /v1/companies/999999/transactions');
    expect(r.stdout + r.stderr).not.toContain(api.session);
  });
});

describe('mutations', () => {
  it('refuses to mutate without --yes when not interactive (exit 2, no writes)', async () => {
    const api = sample();
    const r = await runCli(api, ['ops', 'set', '101', '--category', '69']);
    expect(r.code).toBe(2);
    expect(r.error()).toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
      hint: expect.stringContaining('--yes'),
    });
    expect(api.writes).toHaveLength(0);
  });

  it('applies with --yes and returns the apply report', async () => {
    const api = sample();
    const r = await runCli(api, [
      'ops',
      'set',
      '102',
      '--category',
      '77',
      '--vat-exempt',
      'outside-eu',
      '--yes',
    ]);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      meta: { applied: 1 },
      results: [{ op: '102', status: 'applied' }],
    });
  });

  it('asks once in a terminal and cancels on "n"', async () => {
    const api = sample();
    const r = await runCli(api, ['ops', 'set', '101', '--memo', 'checked'], {
      stdoutIsTTY: true,
      stdinIsTTY: true,
      answer: 'n',
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('CANCELLED');
    expect(api.writes).toHaveLength(0);
  });

  it('--dry-run shows the diff without writing', async () => {
    const api = sample();
    const r = await runCli(api, ['ops', 'set', '101', '--vat-rate', '10', '--dry-run']);
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({
      meta: { dryRun: true, planned: 1 },
      // 101 is validated: the preview shows the reopen / validate-again around the edit.
      results: [
        {
          changes: [
            { field: 'validated', from: true, to: false },
            { field: 'vatRate', from: 20, to: 10 },
            { field: 'vatAmount' },
            { field: 'validated', from: false, to: true },
          ],
        },
      ],
    });
    expect(api.writes).toHaveLength(0);
  });

  it('rejects invalid VAT rates before touching the API', async () => {
    const api = sample();
    const r = await runCli(api, ['ops', 'set', '101', '--vat-rate', '19', '--yes']);
    expect(r.code).toBe(2);
    expect(r.error().message).toContain('vatRate must be one of');
  });

  it('apply: executes a plan file, writes a report, exits 7 on partial failure', async () => {
    const api = sample();
    const dir = tempHome();
    const plan = join(dir, 'fix.plan.json');
    writeFileSync(
      plan,
      JSON.stringify({
        version: 1,
        company: COMPANY,
        createdAt: '2026-09-01T00:00:00.000Z',
        createdBy: 'test',
        steps: [
          { id: 's1', op: '101', action: 'set', set: { memo: 'reviewed' }, why: 'reviewed' },
          { id: 's2', op: '424242', action: 'validate', why: 'does not exist' },
        ],
      }),
    );
    const report = join(dir, 'fix.report.json');
    const r = await runCli(api, [
      'apply',
      plan,
      '--yes',
      '--continue-on-error',
      '--report',
      report,
    ]);
    expect(r.code).toBe(7);
    expect(r.json()).toMatchObject({ meta: { applied: 1, failed: 1 } });
    expect(JSON.parse(readFileSync(report, 'utf8')).results).toHaveLength(2);
    const again = await runCli(api, ['apply', plan, '--dry-run']);
    expect(again.json()).toMatchObject({
      results: [{ status: 'skipped', reason: 'already satisfied' }, { status: 'failed' }],
    });
  });

  it('apply: invalid plans are usage errors', async () => {
    const dir = tempHome();
    const plan = join(dir, 'bad.plan.json');
    writeFileSync(plan, JSON.stringify({ version: 2, steps: [] }));
    const r = await runCli(sample(), ['apply', plan]);
    expect(r.code).toBe(2);
    expect(r.error()).toMatchObject({ code: 'PLAN_INVALID', hint: 'see: compta schema plan' });
  });
});

describe('auth commands', () => {
  it('login --with-token verifies the session and stores it with mode 0600', async () => {
    const api = sample();
    const home = tempHome();
    const r = await runCli(api, ['login', '--with-token'], {
      home,
      loggedIn: false,
      stdin: `Bearer ${api.session}\n`,
    });
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ profile: 'default', source: 'token', activeCompany: COMPANY });
    const path = join(home, 'config', 'compta-cli', 'config.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(r.stdout).not.toContain(api.session);
    const who = await runCli(api, ['whoami'], { home, loggedIn: false });
    expect(who.json()).toMatchObject({
      activeCompany: COMPANY,
      authSource: 'token',
      companies: [{ id: COMPANY }],
    });
  });

  it('login has no browser import any more; logout forgets the token', async () => {
    const api = sample();
    const home = tempHome();
    const old = await runCli(api, ['login', '--from-browser', 'chrome'], { home, loggedIn: false });
    expect(old.code).toBe(2);
    expect(old.error().code).toBe('USAGE');
    const login = await runCli(api, ['login', '--with-token'], {
      home,
      loggedIn: false,
      stdin: api.session,
    });
    expect(login.json()).toMatchObject({ source: 'token', sessionExpiresAt: null });
    expect(login.json()).not.toHaveProperty('browserProfile');
    expect((await runCli(api, ['logout'], { home, loggedIn: false })).json()).toEqual({
      profile: 'default',
      loggedOut: true,
    });
    expect((await runCli(api, ['ops', 'list'], { home, loggedIn: false })).code).toBe(3);
  });

  it('a rejected token is not retried and the stored one is kept', async () => {
    const api = sample();
    const home = tempHome();
    const r1 = await runCli(api, ['whoami'], { home });
    expect(r1.code).toBe(0);
    api.session = 'rotated-elsewhere';
    const r = await runCli(api, ['ops', 'get', '101'], { home, loggedIn: false });
    expect(r.code).toBe(3);
    expect(r.error().code).toBe('AUTH_EXPIRED');
    expect(api.requests.filter((q) => q.path.endsWith('/transactions/101'))).toHaveLength(1);
    const dir = join(home, 'config', 'compta-cli');
    expect(
      JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).profiles.default.session,
    ).toBe('synthetic-session-value');
  });

  it('API commands need COMPTA_API_BASE (exit 2)', async () => {
    const r = await runCli(sample(), ['ops', 'list'], { env: { COMPTA_API_BASE: '' } });
    expect(r.code).toBe(2);
    expect(r.error()).toMatchObject({ code: 'API_BASE_MISSING', hint: 'set COMPTA_API_BASE' });
    const login = await runCli(sample(), ['login', '--with-token'], {
      loggedIn: false,
      stdin: 'some-token-value',
      env: { COMPTA_API_BASE: '' },
    });
    expect(login.error().code).toBe('API_BASE_MISSING');
  });

  it('COMPTA_SESSION overrides stored credentials', async () => {
    const api = sample();
    const r = await runCli(api, ['whoami'], {
      loggedIn: false,
      env: { COMPTA_SESSION: api.session },
    });
    expect(r.json()).toMatchObject({ authSource: 'env', activeCompany: COMPANY });
  });
});

describe('self-description', () => {
  it('commands --json describes every command with flags and examples', async () => {
    const r = await runCli(sample(), ['commands', '--json']);
    type Info = {
      path: string;
      flags: { name: string; type: string }[];
      examples: string[];
      subcommands: Info[];
    };
    const tree = r.json() as Info;
    const leaves: Info[] = [];
    const walk = (c: Info) => (c.subcommands.length ? c.subcommands.forEach(walk) : leaves.push(c));
    walk(tree);
    const paths = leaves.map((c) => c.path);
    for (const expected of [
      'compta todo',
      'compta receipts match',
      'compta vat check',
      'compta vat summary',
      'compta rules apply',
      'compta close-check',
      'compta apply',
      'compta ops set',
    ])
      expect(paths).toContain(expected);
    for (const leaf of leaves) expect(leaf.examples.length, leaf.path).toBeGreaterThan(0);
    const list = leaves.find((c) => c.path === 'compta ops list')!;
    expect(list.flags).toContainEqual(expect.objectContaining({ name: 'limit', type: 'number' }));
    expect(tree.flags).toContainEqual(expect.objectContaining({ name: 'json', type: 'boolean' }));
  });

  it('schema prints JSON Schemas and lists the available types', async () => {
    const list = await runCli(sample(), ['schema']);
    expect((list.json() as { name: string }[]).map((s) => s.name)).toEqual(
      expect.arrayContaining(['operation', 'plan', 'todo-item', 'error']),
    );
    const plan = (await runCli(sample(), ['schema', 'plan'])).json() as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(plan.properties)).toEqual([
      'version',
      'company',
      'createdAt',
      'createdBy',
      'steps',
    ]);
    expect((await runCli(sample(), ['schema', 'nope'])).code).toBe(2);
  });

  it('api escape hatch substitutes {company} and gates writes', async () => {
    const api = sample();
    const r = await runCli(api, ['api', 'GET', '/v1/companies/{company}/bank-accounts']);
    expect((r.json() as { id: number }[])[0]!.id).toBe(501);
    const dry = await runCli(api, [
      'api',
      'POST',
      '/v1/companies/{company}/things',
      '-F',
      'count=2',
      '-F',
      'meta.tag=x',
      '--dry-run',
    ]);
    expect(dry.json()).toEqual({
      dryRun: true,
      method: 'POST',
      path: `/v1/companies/${COMPANY}/things`,
      body: { count: 2, meta: { tag: 'x' } },
    });
    expect((await runCli(api, ['api', 'DELETE', '/v1/companies/{company}/things/1'])).code).toBe(2);
    expect(api.writes).toHaveLength(0);
  });

  it('doctor reports healthy checks and schema drift', async () => {
    const api = sample();
    const raw = api.ops.get('101') as unknown as Record<string, unknown>;
    raw.brandNewField = true;
    const r = await runCli(api, ['doctor']);
    expect(r.code).toBe(0);
    const report = r.json() as { ok: boolean; schema: { valid: boolean; unknownFields: string[] } };
    expect(report.ok).toBe(true);
    expect(report.schema.unknownFields).toContain('brandNewField');
  });

  it('doctor fails with exit 6 when a required field disappears', async () => {
    const api = sample();
    delete (api.ops.get('102') as unknown as Record<string, unknown>).label;
    const r = await runCli(api, ['doctor']);
    expect(r.code).toBe(6);
    const report = r.json() as { ok: boolean; schema: { valid: boolean; missingFields: string[] } };
    expect(report).toMatchObject({
      ok: false,
      schema: { valid: false, missingFields: ['label'] },
    });
  });
});

describe('compta skill', () => {
  it('prints the agent guide as Markdown, or its location', async () => {
    const r = await runCli(sample(), ['skill']);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('---\nname: compta\n')).toBe(true);
    expect(r.stdout).toContain('## Working with the user');
    const path = await runCli(sample(), ['skill', '--path']);
    expect(path.stdout.trim()).toMatch(/skills\/compta\/SKILL\.md$/);
    const json = await runCli(sample(), ['skill', '--path', '--json']);
    expect(json.json()).toEqual({ path: path.stdout.trim() });
  });
});
