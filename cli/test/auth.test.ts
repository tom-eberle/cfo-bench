import { readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { daysLeft } from '../src/auth/credentials.js';
import { chooseFactor } from '../src/auth/password-login.js';
import {
  type Exec,
  keychainStore,
  libsecretStore,
  platformSecretStore,
} from '../src/auth/secrets.js';
import { FakeCompta } from './helpers/fake-api.js';
import { COMPANY } from './helpers/fixtures.js';
import { memoryStore, runCli, tempHome } from './helpers/run.js';

const configFile = (home: string) => join(home, 'config', 'compta-cli', 'config.json');
const readConfigFile = (home: string) => JSON.parse(readFileSync(configFile(home), 'utf8'));

async function writeProfile(home: string, profile: Record<string, unknown>): Promise<void> {
  await mkdir(join(home, 'config', 'compta-cli'), { recursive: true });
  await writeFile(
    configFile(home),
    JSON.stringify({ activeProfile: 'default', profiles: { default: profile } }),
    { mode: 0o600 },
  );
}

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe('password login', () => {
  it('asks for email and a hidden password, and keeps only the session, in the OS store', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    const secrets = memoryStore();
    const questions: string[] = [];
    const r = await runCli(api, ['login'], {
      home,
      loggedIn: false,
      stdinIsTTY: true,
      secrets,
      questions,
      answers: [api.account.email, api.account.password],
    });
    expect(r.code).toBe(0);
    expect(questions).toEqual(['Email: ', 'secret:Password: ']);
    expect(api.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/auth/login',
      body: { email: api.account.email, password: api.account.password },
    });
    expect(r.json()).toMatchObject({
      source: 'password',
      activeCompany: COMPANY,
      sessionStorage: 'macOS Keychain',
    });
    const expiresIn = daysLeft((r.json() as { sessionExpiresAt: string }).sessionExpiresAt);
    expect(expiresIn).toBeGreaterThan(29.9);
    expect(secrets.items.get('default')).toBe(api.session);
    const config = readFileSync(configFile(home), 'utf8');
    expect(config).not.toContain(api.session);
    expect(config).not.toContain(api.account.password);
    expect(readConfigFile(home).profiles.default).toMatchObject({
      sessionStore: 'keychain',
      source: 'password',
      email: api.account.email,
    });
    expect(r.stdout + r.stderr).not.toContain(api.account.password);

    const who = await runCli(api, ['whoami'], { home, loggedIn: false, secrets });
    expect(who.json()).toMatchObject({ authSource: 'password', sessionStorage: 'macOS Keychain' });
  });

  it('offers the last email as the default', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    await writeProfile(home, { email: api.account.email });
    const questions: string[] = [];
    const r = await runCli(api, ['login'], {
      home,
      loggedIn: false,
      stdinIsTTY: true,
      questions,
      answers: ['', api.account.password],
    });
    expect(r.code).toBe(0);
    expect(questions[0]).toBe(`Email [${api.account.email}]: `);
  });

  it('asks for the authenticator code, sending back the challenge, and retries a wrong code', async () => {
    const api = new FakeCompta();
    api.account.factors = [{ type: 'totp' }, { type: 'email' }];
    const questions: string[] = [];
    const r = await runCli(api, ['login', '--email', api.account.email], {
      loggedIn: false,
      stdinIsTTY: true,
      questions,
      answers: [api.account.password, '000000', ' 123 456 '],
    });
    expect(r.code).toBe(0);
    expect(questions.slice(1)).toEqual([
      'Code from your authenticator app: ',
      'Code from your authenticator app: ',
    ]);
    const verifies = api.requests.filter((q) => q.path === '/v1/auth/mfa/verify');
    expect(verifies.map((q) => q.body)).toEqual([
      { challenge: 'synthetic-mfa-challenge', factor: 'totp', code: '000000' },
      { challenge: 'synthetic-mfa-challenge', factor: 'totp', code: '123456' },
    ]);
    expect(verifies[0]!.headers.get('cookie')).toBeNull();
    expect(api.emailCodesSent).toBe(0);
    expect(r.stderr).toContain('That code was not accepted');
  });

  it('uses the most recently used factor; an email code is requested first', async () => {
    const api = new FakeCompta();
    api.account.factors = [
      { type: 'totp', last_used_at: '2026-01-01T00:00:00Z' },
      { type: 'email', last_used_at: '2026-09-01T00:00:00Z' },
    ];
    const r = await runCli(api, ['login', '--email', api.account.email], {
      loggedIn: false,
      stdinIsTTY: true,
      answers: [api.account.password, api.account.code],
    });
    expect(r.code).toBe(0);
    expect(api.emailCodesSent).toBe(1);
    expect(api.requests.find((q) => q.path === '/v1/auth/mfa/email')?.body).toEqual({
      challenge: 'synthetic-mfa-challenge',
    });
    expect(r.stderr).toContain('sent a verification code to your email');
  });

  it('--mfa picks a factor, and refuses one the account does not have', async () => {
    const api = new FakeCompta();
    api.account.factors = [{ type: 'totp' }, { type: 'email' }];
    const ok = await runCli(api, ['login', '--email', api.account.email, '--mfa', 'email'], {
      loggedIn: false,
      stdinIsTTY: true,
      answers: [api.account.password, api.account.code],
    });
    expect(ok.code).toBe(0);
    expect(api.emailCodesSent).toBe(1);
    expect(() => chooseFactor([{ type: 'email' }], 'totp')).toThrow(/no "totp" second factor/);
  });

  it('gives up after three wrong codes (exit 3)', async () => {
    const api = new FakeCompta();
    api.account.factors = [{ type: 'totp' }];
    const r = await runCli(api, ['login', '--email', api.account.email], {
      loggedIn: false,
      stdinIsTTY: true,
      answers: [api.account.password, '1', '2', '3'],
    });
    expect(r.code).toBe(3);
    expect(r.error().code).toBe('MFA_FAILED');
  });

  it('a wrong password is LOGIN_REJECTED (exit 3) and nothing is stored', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    const r = await runCli(api, ['login', '--email', api.account.email], {
      home,
      loggedIn: false,
      stdin: 'wrong\n',
    });
    expect(r.code).toBe(3);
    expect(r.error()).toMatchObject({
      code: 'LOGIN_REJECTED',
      message: 'Compta rejected this email and password: Invalid email or password',
    });
    expect(() => statSync(configFile(home))).toThrow();
  });

  it('an identity-provider account is pointed at an API token', async () => {
    const api = new FakeCompta();
    api.account.sso = true;
    const r = await runCli(api, ['login', '--email', api.account.email], {
      loggedIn: false,
      stdin: `${api.account.password}\n`,
    });
    expect(r.code).toBe(3);
    expect(r.error()).toMatchObject({ code: 'SSO_REQUIRED' });
    expect(r.error().hint).toContain('--with-token');
  });

  it('without a terminal, plain `compta login` exits 2 with a hint and sends nothing', async () => {
    const api = new FakeCompta();
    const r = await runCli(api, ['login'], { loggedIn: false });
    expect(r.code).toBe(2);
    expect(r.error().hint).toContain('--with-token');
    expect(r.error().hint).toContain('COMPTA_SESSION');
    expect(api.requests).toHaveLength(0);
  });

  it('--email reads the password from stdin for scripts; a second factor then needs a terminal', async () => {
    const api = new FakeCompta();
    const scripted = await runCli(api, ['login', '--email', api.account.email], {
      loggedIn: false,
      stdin: `${api.account.password}\n`,
    });
    expect(scripted.code).toBe(0);
    expect(scripted.json()).toMatchObject({ source: 'password' });

    api.account.factors = [{ type: 'totp' }];
    const mfa = await runCli(api, ['login', '--email', api.account.email], {
      loggedIn: false,
      stdin: `${api.account.password}\n`,
    });
    expect(mfa.code).toBe(2);
    expect(mfa.error().code).toBe('MFA_NEEDS_TERMINAL');
  });

  it('refuses two ways of logging in at once', async () => {
    const r = await runCli(new FakeCompta(), ['login', '--with-token', '--email', 'a@b.test'], {
      loggedIn: false,
    });
    expect(r.code).toBe(2);
  });
});

describe('session storage', () => {
  it('falls back to the 0600 config file with a one-line notice when there is no OS store', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    const r = await runCli(api, ['login', '--with-token'], {
      home,
      loggedIn: false,
      stdin: api.session,
      secrets: memoryStore({ failWrites: true }),
    });
    expect(r.code).toBe(0);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toContain('No OS credential store in use');
    expect(readConfigFile(home).profiles.default.session).toBe(api.session);
    expect(statSync(configFile(home)).mode & 0o777).toBe(0o600);
  });

  it('moves a session found in the config file into the OS store, transparently', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    const secrets = memoryStore();
    await writeProfile(home, { session: api.session, source: 'token', companyId: COMPANY });
    const first = await runCli(api, ['ops', 'list'], { home, loggedIn: false, secrets });
    expect(first.code).toBe(0);
    expect(readConfigFile(home).profiles.default.session).toBeUndefined();
    expect(readConfigFile(home).profiles.default.sessionStore).toBe('keychain');
    expect(secrets.items.get('default')).toBe(api.session);
    expect((await runCli(api, ['ops', 'list'], { home, loggedIn: false, secrets })).code).toBe(0);
  });

  it('tokens do not rotate: cookies are never sent, and a Set-Cookie answer is ignored', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    await writeProfile(home, { session: api.session, source: 'token', companyId: COMPANY });
    api.overrides.push((req) => {
      if (req.path !== '/v1/me') return undefined;
      return Response.json(
        { id: 4242, email: 'someone@example.test', companies: [{ id: Number(COMPANY) }] },
        { headers: { 'set-cookie': 'session=synthetic-other-value; Max-Age=864000; Path=/' } },
      );
    });
    expect((await runCli(api, ['whoami'], { home, loggedIn: false })).code).toBe(0);
    const profile = readConfigFile(home).profiles.default;
    expect(profile.session).toBe(api.session);
    expect(profile.sessionExpiresAt).toBeUndefined();
    expect(api.requests.every((q) => !q.headers.get('cookie'))).toBe(true);
  });

  it('logout removes the session from the store; --remote also ends it on Compta', async () => {
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
    const r = await runCli(api, ['logout', '--remote'], { home, loggedIn: false, secrets });
    expect(r.json()).toEqual({ profile: 'default', loggedOut: true, remote: true });
    expect(api.remoteLogouts).toBe(1);
    expect(secrets.items.size).toBe(0);
    expect(readConfigFile(home).profiles.default).toEqual({ companyId: COMPANY });
  });
});

describe('expiry and login --check', () => {
  it('--check is silent: exit 0 when the session works, 3 when missing or rejected', async () => {
    const api = new FakeCompta();
    const ok = await runCli(api, ['login', '--check']);
    expect([ok.code, ok.stdout, ok.stderr]).toEqual([0, '', '']);

    const missing = await runCli(api, ['login', '--check'], { loggedIn: false });
    expect([missing.code, missing.stdout, missing.stderr]).toEqual([3, '', '']);

    const home = tempHome();
    await writeProfile(home, { session: 'stale', source: 'token', companyId: COMPANY });
    const expired = await runCli(api, ['login', '--check', '--json'], { home, loggedIn: false });
    expect(expired.code).toBe(3);
    expect(expired.json()).toMatchObject({ valid: false, reason: 'expired', authSource: 'token' });
  });

  it('--check --json reports the expiry', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    const expiresAt = inDays(20);
    await writeProfile(home, {
      session: api.session,
      source: 'token',
      sessionExpiresAt: expiresAt,
    });
    const r = await runCli(api, ['login', '--check', '--json'], { home, loggedIn: false });
    expect(r.code).toBe(0);
    expect(r.json()).toEqual({
      valid: true,
      reason: null,
      profile: 'default',
      authSource: 'token',
      sessionExpiresAt: expiresAt,
    });
  });

  it('whoami shows the expiry; doctor warns under 7 days and fails once expired', async () => {
    const api = new FakeCompta();
    const home = tempHome();
    const soon = inDays(3);
    await writeProfile(home, {
      session: api.session,
      source: 'password',
      companyId: COMPANY,
      sessionExpiresAt: soon,
    });
    const who = await runCli(api, ['whoami'], { home, loggedIn: false });
    expect(who.json()).toMatchObject({ sessionExpiresAt: soon });

    const warned = await runCli(api, ['doctor', '--json'], { home, loggedIn: false });
    expect(warned.code).toBe(0);
    expect((warned.json() as { checks: unknown[] }).checks).toContainEqual({
      name: 'expiry',
      ok: true,
      warning: true,
      detail: expect.stringContaining('run compta login soon'),
    });

    await writeProfile(home, {
      session: api.session,
      source: 'password',
      companyId: COMPANY,
      sessionExpiresAt: inDays(-1),
    });
    const failed = await runCli(api, ['doctor', '--json'], { home, loggedIn: false });
    expect(failed.code).toBe(3);
    expect((failed.json() as { checks: unknown[] }).checks).toContainEqual({
      name: 'expiry',
      ok: false,
      detail: expect.stringContaining('the session expired on'),
    });
  });
});

describe('credential stores', () => {
  function recorder(results: Record<string, { code: number; stdout?: string }> = {}) {
    const calls: { command: string; args: string[]; input?: string }[] = [];
    const run: Exec = async (command, args, input) => {
      calls.push({ command, args, input });
      const r = results[args[0] ?? ''] ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? '' };
    };
    return { calls, run };
  }

  it('Keychain: the secret goes through stdin, never argv, and is read back to confirm', async () => {
    const { calls, run } = recorder({ 'find-generic-password': { code: 0, stdout: 's%3Aabc\n' } });
    expect(await keychainStore(run).set('default', 's%3Aabc')).toBe(true);
    expect(calls[0]).toMatchObject({ command: 'security', args: ['-i'] });
    expect(calls[0]!.input).toContain('-w "s%3Aabc"');
    expect(calls.flatMap((c) => c.args).join(' ')).not.toContain('s%3Aabc');
  });

  it('Keychain: a write that does not read back, or an unquotable value, is not saved', async () => {
    const missing = recorder({ 'find-generic-password': { code: 44 } });
    expect(await keychainStore(missing.run).set('default', 'abc')).toBe(false);
    const quoted = recorder();
    expect(await keychainStore(quoted.run).set('default', 'a"b')).toBe(false);
    expect(quoted.calls).toHaveLength(0);
  });

  it('libsecret: stores through stdin with service/account attributes', async () => {
    const { calls, run } = recorder({ lookup: { code: 0, stdout: 'abc' } });
    expect(await libsecretStore(run).set('work', 'abc')).toBe(true);
    expect(calls[0]).toEqual({
      command: 'secret-tool',
      args: ['store', '--label=compta-cli (work)', 'service', 'compta-cli', 'account', 'work'],
      input: 'abc',
    });
  });

  it('picks the platform store; Windows and COMPTA_CREDENTIAL_STORE=file use the config file', () => {
    expect(platformSecretStore('darwin', {})?.id).toBe('keychain');
    expect(platformSecretStore('linux', {})?.id).toBe('libsecret');
    expect(platformSecretStore('win32', {})).toBeNull();
    expect(platformSecretStore('darwin', { COMPTA_CREDENTIAL_STORE: 'file' })).toBeNull();
  });
});
