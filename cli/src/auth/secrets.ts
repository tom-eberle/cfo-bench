import { spawn } from 'node:child_process';
import type { Env } from './config.js';

/**
 * Where a session lives when it is not in the config file: the OS credential store.
 * Every implementation verifies a write by reading it back, so a store that silently
 * fails (no D-Bus session, locked keychain…) is reported as unavailable, never as saved.
 */
export interface SecretStore {
  readonly id: 'keychain' | 'libsecret';
  /** Human name, e.g. "macOS Keychain". */
  readonly label: string;
  /** null when there is no such item; throws StoreUnavailableError when it cannot be read. */
  get(account: string): Promise<string | null>;
  /** Returns false when the store could not keep the secret. */
  set(account: string, secret: string): Promise<boolean>;
  delete(account: string): Promise<void>;
}

/** The store exists but cannot be read right now (locked keychain, no Secret Service…). */
export class StoreUnavailableError extends Error {
  constructor(readonly store: string) {
    super(`${store} could not be read`);
    this.name = 'StoreUnavailableError';
  }
}

/** Write, then read back: anything but the exact secret means it was not kept. */
async function writeVerified(
  store: SecretStore,
  account: string,
  secret: string,
  write: () => Promise<ExecResult>,
): Promise<boolean> {
  if ((await write()).code !== 0) return false;
  try {
    return (await store.get(account)) === secret;
  } catch {
    return false;
  }
}

export interface ExecResult {
  code: number;
  stdout: string;
}

/** Run a program with optional stdin; code -1 when it cannot be started. */
export type Exec = (command: string, args: string[], input?: string) => Promise<ExecResult>;

export const SERVICE = 'compta-cli';

export const exec: Exec = (command, args, input) =>
  new Promise((resolve) => {
    let stdout = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve({ code: -1, stdout: '' });
      return;
    }
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.on('error', () => resolve({ code: -1, stdout: '' }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });

/** Values we can pass through `security -i` quoting without escaping rules to get wrong. */
const PLAIN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

/** `security` exit status for errSecItemNotFound; anything else non-zero is a failure. */
const ITEM_NOT_FOUND = 44;

/** macOS Keychain through /usr/bin/security; the secret goes through stdin, never argv. */
export function keychainStore(run: Exec = exec): SecretStore {
  return {
    id: 'keychain',
    label: 'macOS Keychain',
    async get(account) {
      const r = await run('security', [
        'find-generic-password',
        '-s',
        SERVICE,
        '-a',
        account,
        '-w',
      ]);
      if (r.code === 0) return r.stdout.replace(/\n$/, '') || null;
      if (r.code === ITEM_NOT_FOUND) return null;
      throw new StoreUnavailableError(this.label);
    },
    async set(account, secret) {
      if (!PLAIN.test(account) || !PLAIN.test(secret)) return false;
      const command = `add-generic-password -U -s ${SERVICE} -l ${SERVICE} -a "${account}" -w "${secret}"\n`;
      return writeVerified(this, account, secret, () => run('security', ['-i'], command));
    },
    async delete(account) {
      await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
    },
  };
}

/** Linux Secret Service (GNOME Keyring, KWallet…) through libsecret's secret-tool. */
export function libsecretStore(run: Exec = exec): SecretStore {
  const attributes = (account: string) => ['service', SERVICE, 'account', account];
  return {
    id: 'libsecret',
    label: 'Secret Service (libsecret)',
    async get(account) {
      const r = await run('secret-tool', ['lookup', ...attributes(account)]);
      if (r.code === 0) return r.stdout.replace(/\n$/, '') || null;
      // secret-tool exits 1 both for "no such item" and for a store it cannot reach.
      if (r.code === 1) return null;
      throw new StoreUnavailableError(this.label);
    },
    async set(account, secret) {
      const label = `--label=${SERVICE} (${account})`;
      return writeVerified(this, account, secret, () =>
        run('secret-tool', ['store', label, ...attributes(account)], secret),
      );
    },
    async delete(account) {
      await run('secret-tool', ['clear', ...attributes(account)]);
    },
  };
}

/**
 * The OS store for this platform, or null to keep sessions in the 0600 config file
 * (Windows, or COMPTA_CREDENTIAL_STORE=file for containers and CI).
 */
export function platformSecretStore(
  platform: NodeJS.Platform,
  env: Env,
  run: Exec = exec,
): SecretStore | null {
  if (env.COMPTA_CREDENTIAL_STORE === 'file') return null;
  if (platform === 'darwin') return keychainStore(run);
  if (platform === 'linux') return libsecretStore(run);
  return null;
}
