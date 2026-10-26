import type { Fetch } from '../api/client.js';
import { ComptaError, ExitCode } from '../output/errors.js';
import { USER_AGENT } from '../version.js';

/**
 * Email + password login (API: §4.1 login steps):
 *
 *   POST /v1/auth/login {email, password}
 *     → {status: "authenticated", token, expires_at}
 *     → {status: "mfa_required", challenge, factors: [{type, last_used_at}]}
 *     → {status: "sso_required"}                      identity provider only: use a token
 *   POST /v1/auth/mfa/email {challenge}                 email factor: send a code
 *   POST /v1/auth/mfa/verify {challenge, factor, code}  → {status: "authenticated", token, …}
 *
 * The result is the API token. The password is only ever sent to Compta, never stored.
 */

export type AuthFactor = 'totp' | 'email';

export interface LoginPrompts {
  /** Ask for the second-factor code; `factor` says where it comes from. */
  code(factor: AuthFactor, attempt: number): Promise<string>;
  /** Tell the user something (e.g. "a code was sent by email"). */
  info(message: string): void;
}

export interface LoginOptions {
  email: string;
  password: string;
  prompts: LoginPrompts | null;
  /** Force a second factor instead of the default one (see chooseFactor). */
  factor?: AuthFactor;
  fetch?: Fetch;
  /** The API origin (COMPTA_API_BASE). */
  baseUrl: string;
  log?: (line: string) => void;
}

export interface LoginResult {
  session: string;
  expiresAt: string | null;
  factor: AuthFactor | null;
}

interface FactorInfo {
  type: string;
  last_used_at?: string | null;
}

interface StepAnswer {
  status?: unknown;
  token?: unknown;
  expires_at?: unknown;
  challenge?: unknown;
  factors?: unknown;
  error?: { message?: unknown };
}

const MAX_CODE_ATTEMPTS = 3;

const TOKEN_HINT = 'create an API token in the Compta web app, then: compta login --with-token';

export async function passwordLogin(options: LoginOptions): Promise<LoginResult> {
  const base = options.baseUrl.replace(/\/+$/, '');
  assertSafeBase(base);
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(`${base}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
    } catch (cause) {
      throw new ComptaError('NETWORK', `Could not reach ${base}`, {
        exitCode: ExitCode.network,
        hint: 'check your connection and retry',
        cause,
      });
    }
    options.log?.(`POST ${path} → ${response.status}`);
    const data = (await response.json().catch(() => null)) as StepAnswer | null;
    return { response, data };
  };

  const login = await post('/v1/auth/login', {
    email: options.email,
    password: options.password,
  });
  if (login.response.status === 429 || login.response.status >= 500)
    throw new ComptaError(
      'API_UNAVAILABLE',
      `Compta could not log you in (HTTP ${login.response.status})`,
      {
        exitCode: ExitCode.network,
        hint: 'retry in a minute',
        status: login.response.status,
      },
    );
  if (!login.response.ok)
    throw new ComptaError(
      'LOGIN_REJECTED',
      `Compta rejected this email and password${serverMessage(login.data)}`,
      {
        exitCode: ExitCode.auth,
        hint: 'check them in the Compta web app (forgotten password link on its sign-in page)',
        status: login.response.status,
      },
    );

  let factor: AuthFactor | null = null;
  let answer = login.data;
  const status = answer?.status;
  if (status === 'sso_required')
    throw new ComptaError(
      'SSO_REQUIRED',
      'This Compta account signs in through an identity provider',
      {
        exitCode: ExitCode.auth,
        hint: TOKEN_HINT,
      },
    );
  if (status === 'mfa_required') {
    factor = chooseFactor(answer?.factors, options.factor);
    const challenge = answer?.challenge;
    if (!options.prompts)
      throw new ComptaError('MFA_NEEDS_TERMINAL', 'Compta asks for a second-factor code', {
        exitCode: ExitCode.usage,
        hint: 'run compta login in a terminal, or use: compta login --with-token',
      });
    if (factor === 'email') {
      const sent = await post('/v1/auth/mfa/email', { challenge });
      if (!sent.response.ok)
        throw new ComptaError(
          'MFA_FAILED',
          `Compta could not send the email code (HTTP ${sent.response.status})`,
          {
            exitCode: ExitCode.auth,
            status: sent.response.status,
          },
        );
      options.prompts.info('Compta sent a verification code to your email.');
    }
    for (let attempt = 1; ; attempt++) {
      const code = (await options.prompts.code(factor, attempt)).replace(/\s+/g, '');
      const verify = await post('/v1/auth/mfa/verify', { challenge, factor, code });
      if (verify.response.ok && verify.data?.status === 'authenticated') {
        answer = verify.data;
        break;
      }
      if (verify.response.status === 429 || verify.response.status >= 500)
        throw new ComptaError(
          'API_UNAVAILABLE',
          `Compta could not check the code (HTTP ${verify.response.status})`,
          {
            exitCode: ExitCode.network,
            status: verify.response.status,
          },
        );
      if (attempt >= MAX_CODE_ATTEMPTS)
        throw new ComptaError('MFA_FAILED', 'Compta rejected the verification code', {
          exitCode: ExitCode.auth,
          hint: 'run compta login again',
        });
      options.prompts.info('That code was not accepted; try again.');
    }
  } else if (status !== 'authenticated') {
    throw new ComptaError(
      'LOGIN_UNSUPPORTED',
      `Compta answered the login with an unknown step (${String(status)})`,
      {
        exitCode: ExitCode.auth,
        hint: TOKEN_HINT,
      },
    );
  }

  const token = answer?.token;
  if (typeof token !== 'string' || !token)
    throw new ComptaError('LOGIN_UNSUPPORTED', 'Compta accepted the login but returned no token', {
      exitCode: ExitCode.auth,
      hint: TOKEN_HINT,
    });
  const expiresAt =
    typeof answer?.expires_at === 'string' && !Number.isNaN(Date.parse(answer.expires_at))
      ? new Date(answer.expires_at).toISOString()
      : null;
  return { session: token, expiresAt, factor };
}

/** The password only ever travels over HTTPS (plain HTTP is allowed to localhost, for tests). */
export function assertSafeBase(base: string): void {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ComptaError('USAGE', `Invalid API base URL: ${base}`, { exitCode: ExitCode.usage });
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new ComptaError('INSECURE_API_BASE', `Refusing to send your password to ${url.origin}`, {
      exitCode: ExitCode.usage,
      hint: 'COMPTA_API_BASE must use https (plain http only for localhost)',
    });
}

/** The default second factor: the most recently used, else an authenticator app. */
export function chooseFactor(factors: unknown, forced?: AuthFactor): AuthFactor {
  const known = (Array.isArray(factors) ? (factors as FactorInfo[]) : []).filter(
    (f): f is FactorInfo & { type: AuthFactor } => f?.type === 'totp' || f?.type === 'email',
  );
  if (forced) {
    if (known.some((f) => f.type === forced)) return forced;
    throw new ComptaError(
      'MFA_FACTOR_UNAVAILABLE',
      `This account has no "${forced}" second factor`,
      {
        exitCode: ExitCode.usage,
        hint: `available: ${known.map((f) => f.type).join(', ') || 'none'}`,
      },
    );
  }
  const preference = { totp: 2, email: 1 };
  const [best] = [...known].sort((a, b) =>
    a.last_used_at && b.last_used_at
      ? Date.parse(b.last_used_at) - Date.parse(a.last_used_at)
      : preference[b.type] - preference[a.type],
  );
  if (!best)
    throw new ComptaError(
      'LOGIN_UNSUPPORTED',
      'Compta asks for a second factor this CLI does not know',
      {
        exitCode: ExitCode.auth,
        hint: TOKEN_HINT,
      },
    );
  return best.type;
}

function serverMessage(data: StepAnswer | null): string {
  const message = data?.error?.message;
  return typeof message === 'string' && message ? `: ${message.slice(0, 200)}` : '';
}
