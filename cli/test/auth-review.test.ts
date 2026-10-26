import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api/client.js';
import { keychainStore, StoreUnavailableError } from '../src/auth/secrets.js';
import { createAsk, createAskSecret, type ProcessHooks } from '../src/util/terminal.js';
import { FakeCompta } from './helpers/fake-api.js';
import { COMPANY } from './helpers/fixtures.js';
import { memoryStore, runCli, tempHome } from './helpers/run.js';

// Regression tests for the auth security review (review4: B1, S1, S2, N1–N5).

const configFile = (home: string) => join(home, 'config', 'compta-cli', 'config.json');
const profileOf = (home: string) =>
  JSON.parse(readFileSync(configFile(home), 'utf8')).profiles.default;

async function writeProfile(home: string, profile: Record<string, unknown>): Promise<void> {
  await mkdir(join(home, 'config', 'compta-cli'), { recursive: true });
  await writeFile(
    configFile(home),
    JSON.stringify({ activeProfile: 'default', profiles: { default: profile } }),
    { mode: 0o600 },
  );
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe('B1: a 401 never replaces or drops the stored token', () => {
  it('a transient 401 leaves the stored session and its expiry untouched', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    const expiresAt = inDays(20);
    await writeProfile(home, {
      session: api.session,
      source: 'password',
      companyId: COMPANY,
      sessionExpiresAt: expiresAt,
    });
    let failed = false;
    api.overrides.push((req) => {
      if (req.path !== '/v1/me' || failed) return undefined;
      failed = true;
      return api.unauthorized();
    });
    expect((await runCli(api, ['whoami'], { home, loggedIn: false })).code).toBe(3);
    expect(api.unauthorizedResponses).toBe(1);
    expect(profileOf(home)).toMatchObject({ session: api.session, sessionExpiresAt: expiresAt });
    expect((await runCli(api, ['whoami'], { home, loggedIn: false })).code).toBe(0);
  });

  it('the client never sends cookies nor adopts a Set-Cookie value', async () => {
    const sent: Headers[] = [];
    const responses = [
      new Response('{}', {
        status: 403,
        headers: { 'set-cookie': 'session=anon; Max-Age=600' },
      }),
      Response.json({}, { headers: { 'set-cookie': 'session=other; Max-Age=600' } }),
      Response.json({}),
    ];
    const client = new ApiClient({
      session: 'good-token-value',
      baseUrl: 'https://compta.example.test',
      fetch: (async (_url: string | URL, init: RequestInit = {}) => {
        sent.push(new Headers(init.headers));
        return responses.shift()!;
      }) as typeof fetch,
    });
    await expect(client.post('/x', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await client.get('/y');
    await client.get('/z');
    expect(client.currentSession).toBe('good-token-value');
    expect(sent.map((h) => h.get('cookie'))).toEqual([null, null, null]);
    expect(sent.map((h) => h.get('authorization'))).toEqual([
      'Bearer good-token-value',
      'Bearer good-token-value',
      'Bearer good-token-value',
    ]);
  });

  it('login sends the same MFA challenge again after a wrong code', async () => {
    const api = new FakeCompta();
    api.account.factors = [{ type: 'totp' }];
    const r = await runCli(api, ['login', '--email', api.account.email], {
      loggedIn: false,
      stdinIsTTY: true,
      answers: [api.account.password, '000000', api.account.code],
    });
    expect(r.code).toBe(0);
    const verifies = api.requests.filter((q) => q.path === '/v1/auth/mfa/verify');
    expect(verifies.map((q) => (q.body as { challenge: string }).challenge)).toEqual([
      'synthetic-mfa-challenge',
      'synthetic-mfa-challenge',
    ]);
  });
});

describe('S1: a session in an unreadable store is CREDENTIAL_STORE_LOCKED, not "not logged in"', () => {
  it('locked keychain: exit 3 with an unlock hint; login --check says locked', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    await writeProfile(home, { sessionStore: 'keychain', source: 'password', companyId: COMPANY });
    const secrets = memoryStore({ locked: true });
    const r = await runCli(api, ['ops', 'list'], { home, loggedIn: false, secrets });
    expect(r.code).toBe(3);
    expect(r.error()).toMatchObject({ code: 'CREDENTIAL_STORE_LOCKED' });
    expect(r.error().hint).toContain('security unlock-keychain');
    expect(r.error().hint).toContain('COMPTA_SESSION');

    const check = await runCli(api, ['login', '--check', '--json'], {
      home,
      loggedIn: false,
      secrets,
    });
    expect(check.code).toBe(3);
    expect(check.json()).toMatchObject({ valid: false, reason: 'locked' });
  });

  it('store turned off with COMPTA_CREDENTIAL_STORE=file: the error says so', async () => {
    const home = tempHome();
    await writeProfile(home, { sessionStore: 'keychain', source: 'token' });
    const r = await runCli(new FakeCompta(), ['whoami'], {
      home,
      loggedIn: false,
      env: { COMPTA_CREDENTIAL_STORE: 'file' },
    });
    expect(r.code).toBe(3);
    expect(r.error()).toMatchObject({
      code: 'CREDENTIAL_STORE_LOCKED',
      message: expect.stringContaining('turned off'),
    });
  });

  it('an item deleted from the store is AUTH_MISSING', async () => {
    const home = tempHome();
    await writeProfile(home, { sessionStore: 'keychain', source: 'token' });
    const r = await runCli(new FakeCompta(), ['whoami'], {
      home,
      loggedIn: false,
      secrets: memoryStore(),
    });
    expect(r.error()).toMatchObject({
      code: 'AUTH_MISSING',
      message: 'The session of profile "default" is no longer in the macOS Keychain',
    });
  });

  it('Keychain reads: exit 44 is "no item", any other failure is unavailable', async () => {
    const notFound = keychainStore(async () => ({ code: 44, stdout: '' }));
    expect(await notFound.get('default')).toBeNull();
    const locked = keychainStore(async () => ({ code: 36, stdout: '' }));
    await expect(locked.get('default')).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(await locked.set('default', 'abc')).toBe(false);
  });
});

describe('S2: a session that could not be removed is reported, not hidden', () => {
  it('logout with a locked keychain: loggedOut false, secretRemaining, exit 1, --remote suggested', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    const secrets = memoryStore();
    await runCli(api, ['login', '--with-token'], {
      home,
      loggedIn: false,
      stdin: api.session,
      secrets,
    });
    const locked = memoryStore({ locked: true });
    locked.items.set('default', api.session);
    const r = await runCli(api, ['logout'], { home, loggedIn: false, secrets: locked });
    expect(r.code).toBe(1);
    expect(r.json()).toEqual({ profile: 'default', loggedOut: false, secretRemaining: true });
    expect(r.stderr).toContain('compta logout --remote');
    expect(profileOf(home)).toMatchObject({ sessionStore: 'keychain' });
  });

  it('a login that falls back to the file removes the previous store item', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    const secrets = memoryStore();
    await runCli(api, ['login', '--with-token'], {
      home,
      loggedIn: false,
      stdin: api.session,
      secrets,
    });
    expect(secrets.items.size).toBe(1);
    const writesFail = memoryStore({ failWrites: true });
    writesFail.items.set('default', api.session);
    const r = await runCli(api, ['login', '--with-token'], {
      home,
      loggedIn: false,
      stdin: api.session,
      secrets: writesFail,
    });
    expect(r.code).toBe(0);
    expect(writesFail.items.size).toBe(0);
    expect(r.stderr).not.toContain('could not be removed');
    expect(profileOf(home)).toMatchObject({ session: api.session });
    expect(profileOf(home).sessionStore).toBeUndefined();
  });

  it('…and warns when the store is off and the old item cannot be removed', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    await writeProfile(home, { sessionStore: 'keychain', source: 'token', companyId: COMPANY });
    const r = await runCli(api, ['login', '--with-token'], {
      home,
      loggedIn: false,
      stdin: api.session,
      env: { COMPTA_CREDENTIAL_STORE: 'file' },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('security delete-generic-password -s compta-cli -a default');
  });
});

describe('nice-to-haves', () => {
  it('N1: never sends a password over plain HTTP, and says where it goes with --verbose', async () => {
    const api = new FakeCompta();
    const insecure = await runCli(api, ['login', '--email', api.account.email], {
      loggedIn: false,
      stdin: 'x\n',
      env: { COMPTA_API_BASE: 'http://compta.example.test' },
    });
    expect(insecure.code).toBe(2);
    expect(insecure.error().code).toBe('INSECURE_API_BASE');
    expect(api.requests).toHaveLength(0);

    const ok = await runCli(api, ['login', '--email', api.account.email, '--verbose'], {
      loggedIn: false,
      stdin: `${api.account.password}\n`,
    });
    expect(ok.code).toBe(0);
    expect(ok.stderr).toContain('sending the password to https://compta.example.test');
    expect(ok.stderr).not.toContain(api.account.password);
  });

  it('N2: profile names are restricted', async () => {
    const r = await runCli(new FakeCompta(), ['whoami', '--profile', 'my profile']);
    expect(r.code).toBe(2);
    expect(r.error().message).toBe('Invalid profile name "my profile"');
  });

  it('N3: Ctrl-C or end of input at a question is CANCELLED, an answer is returned', async () => {
    const answered = new PassThrough();
    const ask = createAsk(answered, new PassThrough());
    const answer = ask('Email: ');
    answered.write('someone@example.test\n');
    await expect(answer).resolves.toBe('someone@example.test');

    const closed = new PassThrough();
    const pending = createAsk(closed, new PassThrough())('Email: ');
    closed.end();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', exitCode: 2 });
  });

  it('N4: the hidden prompt restores the terminal on Enter, Ctrl-C, end of input and SIGTERM', async () => {
    const setup = () => {
      const input = Object.assign(new PassThrough(), { setRawMode: vi.fn() });
      const proc = Object.assign(new EventEmitter(), { exit: vi.fn() }) as unknown as ProcessHooks;
      const output = new PassThrough();
      return { input, proc, ask: createAskSecret(input, output, proc) };
    };

    const enter = setup();
    const typed = enter.ask('Password: ');
    enter.input.write('pa\u007fss\r');
    await expect(typed).resolves.toBe('pss');
    expect(enter.input.setRawMode.mock.calls).toEqual([[true], [false]]);
    expect(enter.proc.listenerCount('SIGTERM')).toBe(0);

    const ctrlC = setup();
    const interrupted = ctrlC.ask('Password: ');
    ctrlC.input.write('\u0003');
    await expect(interrupted).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(ctrlC.input.setRawMode).toHaveBeenLastCalledWith(false);

    const eof = setup();
    const ended = eof.ask('Password: ');
    eof.input.end();
    await expect(ended).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(eof.input.setRawMode).toHaveBeenLastCalledWith(false);

    const term = setup();
    const killed = term.ask('Password: ');
    term.proc.emit('SIGTERM');
    await expect(killed).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(term.input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(term.proc.exit).toHaveBeenCalledWith(143);
  });

  it('N5: login --check trusts Compta over a recorded expiry that has passed', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    await writeProfile(home, {
      session: api.session,
      source: 'token',
      sessionExpiresAt: inDays(-2),
    });
    const r = await runCli(api, ['login', '--check', '--json'], { home, loggedIn: false });
    expect(r.code).toBe(0);
    expect(r.json()).toMatchObject({ valid: true, sessionExpiresAt: null });
  });
});
