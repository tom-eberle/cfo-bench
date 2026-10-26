import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ComptaError, ExitCode } from '../output/errors.js';

export const credentialSourceSchema = z.enum(['password', 'token']);
export type CredentialSource = z.infer<typeof credentialSourceSchema>;

const profileSchema = z.object({
  /** Only when no OS credential store is available (or sessions saved by early 0.1.0 builds). */
  session: z.string().optional(),
  /** The OS store holding this profile's session, keyed by the profile name. */
  sessionStore: z.enum(['keychain', 'libsecret']).optional(),
  sessionExpiresAt: z.string().optional(),
  source: credentialSourceSchema.optional(),
  /** Last email used with password login, offered as the default next time. */
  email: z.string().optional(),
  companyId: z.string().optional(),
  savedAt: z.string().optional(),
});
export type Profile = z.infer<typeof profileSchema>;

const configSchema = z.object({
  profiles: z.record(z.string(), profileSchema).default({}),
  activeProfile: z.string().default('default'),
});
export type Config = z.infer<typeof configSchema>;

export type Env = Record<string, string | undefined>;

export function configDir(env: Env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'compta-cli');
}

export function cacheDir(env: Env = process.env): string {
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'compta-cli');
}

/**
 * The API origin, from COMPTA_API_BASE. There is no built-in default: every
 * command that talks to the API needs it.
 */
export function apiBase(env: Env = process.env): string {
  const base = env.COMPTA_API_BASE?.trim();
  if (!base)
    throw new ComptaError('API_BASE_MISSING', 'No Compta API address is configured', {
      exitCode: ExitCode.usage,
      hint: 'set COMPTA_API_BASE',
    });
  return base;
}

export function configPath(env: Env = process.env): string {
  return join(configDir(env), 'config.json');
}

export async function readConfig(env: Env = process.env): Promise<Config> {
  const path = configPath(env);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      return { profiles: {}, activeProfile: 'default' };
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = configSchema.safeParse(json);
  if (!parsed.success)
    throw new ComptaError('CONFIG_INVALID', `Config file is not valid: ${path}`, {
      exitCode: ExitCode.usage,
      hint: 'fix or delete the file, then run compta login again',
    });
  return parsed.data;
}

/** Atomic write with 0600 permissions; the file may hold an API token. */
export async function writeConfig(config: Config, env: Env = process.env): Promise<void> {
  const path = configPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

/** Profile names become credential-store attributes and file keys: keep them plain. */
const PROFILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function activeProfileName(
  config: Config,
  explicit: string | undefined,
  env: Env = process.env,
): string {
  const name = explicit || env.COMPTA_PROFILE || config.activeProfile || 'default';
  if (!PROFILE_NAME.test(name))
    throw new ComptaError('USAGE', `Invalid profile name "${name}"`, {
      exitCode: ExitCode.usage,
      hint: 'use letters, digits, ".", "_" or "-" (at most 64)',
    });
  return name;
}
