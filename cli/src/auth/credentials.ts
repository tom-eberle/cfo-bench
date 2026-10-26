import { ComptaError, ExitCode, LOGIN_HINT } from '../output/errors.js';
import {
  type Config,
  type CredentialSource,
  configPath,
  type Env,
  type Profile,
  writeConfig,
} from './config.js';
import type { SecretStore } from './secrets.js';

const STORE_LABELS: Record<NonNullable<Profile['sessionStore']>, string> = {
  keychain: 'macOS Keychain',
  libsecret: 'Secret Service (libsecret)',
};

/** Where this profile's session is kept, for humans. */
export function sessionLocation(profile: Profile, env: Env): string {
  return profile.sessionStore ? STORE_LABELS[profile.sessionStore] : configPath(env);
}

const STORE_HINTS: Record<NonNullable<Profile['sessionStore']>, string> = {
  keychain:
    'unlock it (security unlock-keychain), set COMPTA_SESSION, or log in again with: COMPTA_CREDENTIAL_STORE=file compta login',
  libsecret:
    'unlock your keyring, set COMPTA_SESSION, or log in again with: COMPTA_CREDENTIAL_STORE=file compta login',
};

/** Remove a profile's item from the OS store; true only once it is confirmed gone. */
async function removeFromStore(
  id: NonNullable<Profile['sessionStore']>,
  profileName: string,
  store: SecretStore | null,
): Promise<boolean> {
  if (store?.id !== id) return false;
  await store.delete(profileName);
  try {
    return (await store.get(profileName)) === null;
  } catch {
    return false;
  }
}

/**
 * The stored session of a profile. A session still in the config file is moved to
 * the OS store when one is available (transparently, once). A session in an OS store
 * that cannot be read here (locked keychain over SSH, store turned off) is
 * CREDENTIAL_STORE_LOCKED, not "not logged in".
 */
export async function readSession(
  config: Config,
  profileName: string,
  store: SecretStore | null,
  env: Env,
  log: (line: string) => void = () => {},
): Promise<string | null> {
  const profile = config.profiles[profileName];
  if (!profile) return null;
  if (profile.session) {
    const session = profile.session;
    if (store && (await store.set(profileName, session))) {
      config.profiles[profileName] = { ...profile, session: undefined, sessionStore: store.id };
      await writeConfig(config, env);
      log(`moved the session of profile "${profileName}" to the ${store.label}`);
    }
    return session;
  }
  if (!profile.sessionStore) return null;
  const label = STORE_LABELS[profile.sessionStore];
  const locked = (why: string) =>
    new ComptaError(
      'CREDENTIAL_STORE_LOCKED',
      `The session of profile "${profileName}" is in the ${label}, which ${why}`,
      { exitCode: ExitCode.auth, hint: STORE_HINTS[profile.sessionStore!] },
    );
  if (store?.id !== profile.sessionStore)
    throw locked(
      env.COMPTA_CREDENTIAL_STORE === 'file'
        ? 'is turned off (COMPTA_CREDENTIAL_STORE=file)'
        : 'is not available here',
    );
  let session: string | null;
  try {
    session = await store.get(profileName);
  } catch {
    throw locked('could not be read (is it locked?)');
  }
  if (!session)
    throw new ComptaError(
      'AUTH_MISSING',
      `The session of profile "${profileName}" is no longer in the ${label}`,
      { exitCode: ExitCode.auth, hint: LOGIN_HINT },
    );
  return session;
}

export interface NewSession {
  session: string;
  source: CredentialSource;
  expiresAt: string | null;
  email?: string;
  companyId?: string;
}

/**
 * Save a session in the OS store, or in the 0600 config file when there is none.
 * Returns where it went, whether that was the file fallback, and whether a previous
 * session could not be removed from the OS store on the way (`staleSecret`).
 */
export async function saveSession(
  config: Config,
  profileName: string,
  next: NewSession,
  store: SecretStore | null,
  env: Env,
): Promise<{ location: string; fileFallback: boolean; staleSecret: boolean }> {
  const previous = config.profiles[profileName] ?? {};
  const inStore = store ? await store.set(profileName, next.session) : false;
  const staleSecret =
    !inStore && previous.sessionStore
      ? !(await removeFromStore(previous.sessionStore, profileName, store))
      : false;
  config.profiles[profileName] = {
    ...previous,
    session: inStore ? undefined : next.session,
    sessionStore: inStore ? store?.id : undefined,
    sessionExpiresAt: next.expiresAt ?? undefined,
    source: next.source,
    email: next.email ?? previous.email,
    companyId: next.companyId ?? previous.companyId,
    savedAt: new Date().toISOString(),
  };
  await writeConfig(config, env);
  return {
    location: sessionLocation(config.profiles[profileName]!, env),
    fileFallback: !inStore,
    staleSecret,
  };
}

/**
 * Forget a profile's session everywhere; keeps its non-secret settings. When the OS store
 * item cannot be removed (locked, store unavailable), the profile keeps pointing at it and
 * `secretRemaining` is true: the session is not gone, and saying so would be wrong.
 */
export async function forgetSession(
  config: Config,
  profileName: string,
  store: SecretStore | null,
  env: Env,
): Promise<{ had: boolean; secretRemaining: boolean }> {
  const profile = config.profiles[profileName];
  if (!profile) return { had: false, secretRemaining: false };
  const had = !!(profile.session || profile.sessionStore);
  const secretRemaining = profile.sessionStore
    ? !(await removeFromStore(profile.sessionStore, profileName, store))
    : false;
  const { companyId, email } = profile;
  config.profiles[profileName] = secretRemaining
    ? { companyId, email, sessionStore: profile.sessionStore, source: profile.source }
    : { companyId, email };
  await writeConfig(config, env);
  return { had, secretRemaining };
}

/** Days until a known expiry (negative once expired); null when unknown. */
export function daysLeft(expiresAt: string | undefined | null, now = Date.now()): number | null {
  if (!expiresAt) return null;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? null : (at - now) / 86_400_000;
}
