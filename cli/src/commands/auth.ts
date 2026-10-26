import { type Command, Option } from 'commander';
import { ApiClient } from '../api/client.js';
import { normalizeUser } from '../api/normalize.js';
import { rawUserSchema, type Whoami } from '../api/schemas.js';
import { activeProfileName, apiBase, type CredentialSource, readConfig } from '../auth/config.js';
import { daysLeft, forgetSession, saveSession, sessionLocation } from '../auth/credentials.js';
import { type AuthFactor, passwordLogin } from '../auth/password-login.js';
import { ComptaError, ExitCode, toComptaError, usageError } from '../output/errors.js';
import { style } from '../output/style.js';
import { renderKeyValues } from '../output/table.js';
import { type Context, contextOf } from './context.js';
import { withExamples } from './shared.js';

const NON_INTERACTIVE_HINT =
  'scripts and agents: compta login --with-token < token.txt, COMPTA_SESSION=<token>, or compta login --email <address> with the password on stdin';

interface LoginOptions {
  email?: string;
  mfa?: AuthFactor;
  withToken?: boolean;
  check?: boolean;
}

interface ObtainedSession {
  session: string;
  source: CredentialSource;
  expiresAt: string | null;
  email?: string;
}

function cleanToken(input: string): string {
  const value = input
    .trim()
    .replace(/^authorization:\s*/i, '')
    .replace(/^bearer\s+/i, '')
    .trim();
  if (!value || /[\s;]/.test(value))
    throw usageError(
      'Expected an API token on stdin',
      'paste only the token, e.g.: pbpaste | compta login --with-token',
    );
  return value;
}

/** Email + password (+ second factor), prompting on a terminal or reading the password from stdin. */
async function passwordSession(
  ctx: Context,
  opts: LoginOptions,
  baseUrl: string,
): Promise<ObtainedSession> {
  const interactive = ctx.runtime.stdinIsTTY;
  if (!interactive && !opts.email)
    throw usageError(
      'compta login needs a terminal to ask for your password',
      NON_INTERACTIVE_HINT,
    );
  const config = await readConfig(ctx.env);
  const previous = config.profiles[activeProfileName(config, ctx.options.profile, ctx.env)]?.email;
  let email = opts.email?.trim();
  if (!email)
    email =
      (await ctx.runtime.ask(`Email${previous ? ` [${previous}]` : ''}: `)).trim() || previous;
  if (!email?.includes('@')) throw usageError('An email address is required');
  const password = interactive
    ? await ctx.runtime.askSecret('Password: ')
    : (await ctx.runtime.readStdin()).replace(/\r?\n$/, '');
  if (!password)
    throw usageError(
      'No password given',
      interactive ? undefined : `pipe it on stdin: compta login --email ${email} < password.txt`,
    );
  ctx.out.addSecret(password);
  ctx.out.debug(`sending the password to ${baseUrl}`);
  const result = await passwordLogin({
    email,
    password,
    factor: opts.mfa,
    prompts: interactive
      ? {
          code: (factor) =>
            ctx.runtime.ask(
              factor === 'totp' ? 'Code from your authenticator app: ' : 'Code from the email: ',
            ),
          info: (message) => ctx.out.info(message),
        }
      : null,
    fetch: ctx.runtime.fetch,
    baseUrl,
    log: (line) => ctx.out.debug(line),
  });
  return { session: result.session, source: 'password', expiresAt: result.expiresAt, email };
}

async function obtainSession(
  ctx: Context,
  opts: LoginOptions,
  baseUrl: string,
): Promise<ObtainedSession> {
  if (opts.withToken)
    return { session: cleanToken(await ctx.runtime.readStdin()), source: 'token', expiresAt: null };
  return passwordSession(ctx, opts, baseUrl);
}

/**
 * `login --check`: exit 0 when Compta accepts the stored session, 3 when it is missing,
 * expired or locked away in an unreadable credential store. Compta's answer decides, not
 * the recorded expiry.
 */
async function checkLogin(ctx: Context): Promise<void> {
  const config = await readConfig(ctx.env);
  const profile = activeProfileName(config, ctx.options.profile, ctx.env);
  let reason: 'missing' | 'locked' | 'expired' | null = null;
  try {
    await ctx.user();
  } catch (e) {
    const error = toComptaError(e);
    if (error.exitCode !== ExitCode.auth) throw e;
    reason =
      error.code === 'AUTH_MISSING'
        ? 'missing'
        : error.code === 'CREDENTIAL_STORE_LOCKED'
          ? 'locked'
          : 'expired';
  }
  const auth = reason === null || reason === 'expired' ? await ctx.auth() : null;
  if (reason) ctx.exitCode = ExitCode.auth;
  // A recorded expiry in the past is stale when Compta still accepts the session.
  const recorded = auth?.expiresAt ?? null;
  const stale = !reason && (daysLeft(recorded) ?? 0) < 0;
  if (ctx.options.json)
    ctx.out.result({
      valid: !reason,
      reason,
      profile,
      authSource: auth?.source ?? null,
      sessionExpiresAt: stale ? null : recorded,
    });
}

function expiryText(expiresAt: string | null): string | null {
  const days = daysLeft(expiresAt);
  if (days === null || !expiresAt) return null;
  if (days < 0) return style.red(`expired on ${expiresAt.slice(0, 10)}`);
  const text = `expires ${expiresAt.slice(0, 10)} (in ${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'})`;
  return days < 7 ? style.yellow(text) : text;
}

export function registerAuthCommands(program: Command): void {
  withExamples(
    program
      .command('login')
      .description('Log in to Compta: email and password by default, or an API token')
      .option(
        '--email <address>',
        'Log in as this user; without a terminal, read the password from stdin',
      )
      .addOption(
        new Option('--mfa <factor>', 'Second factor to use when Compta asks for one').choices([
          'totp',
          'email',
        ]),
      )
      .option('--with-token', 'Read an API token from stdin')
      .option(
        '--check',
        'Exit 0 if the stored session works, 3 if missing or expired (quiet unless --json)',
      ),
    'login',
    'login --email you@example.com < password.txt',
    'login --with-token < session.txt',
    'login --check --json',
  ).action(async (opts: LoginOptions, cmd: Command) => {
    const ctx = contextOf(cmd);
    const modes = [opts.withToken, opts.email ?? opts.mfa].filter(Boolean);
    if (opts.check) {
      if (modes.length) throw usageError('--check cannot be combined with a way to log in');
      return checkLogin(ctx);
    }
    if (modes.length > 1)
      throw usageError(
        'Choose one way to log in: --email or --with-token',
        'e.g.: compta login (asks for your email and password)',
      );
    const baseUrl = apiBase(ctx.env);
    const obtained = await obtainSession(ctx, opts, baseUrl);
    ctx.out.addSecret(obtained.session);

    const client = new ApiClient({
      session: obtained.session,
      baseUrl,
      fetch: ctx.runtime.fetch,
      log: (l) => ctx.out.debug(l),
    });
    const { user, companies } = normalizeUser(rawUserSchema.parse(await client.get('/v1/me')));

    const config = await readConfig(ctx.env);
    const profileName = activeProfileName(config, ctx.options.profile, ctx.env);
    const previous = config.profiles[profileName]?.companyId;
    const companyId =
      ctx.options.company ??
      (companies.length === 1
        ? companies[0]!.id
        : previous && companies.some((c) => c.id === previous)
          ? previous
          : undefined);
    config.activeProfile = profileName;
    const saved = await saveSession(
      config,
      profileName,
      {
        session: client.currentSession,
        source: obtained.source,
        expiresAt: obtained.expiresAt,
        email: obtained.email,
        companyId,
      },
      ctx.runtime.secrets,
      ctx.env,
    );
    if (saved.fileFallback)
      ctx.out.info(
        style.dim(
          `No OS credential store in use: the session is saved in ${saved.location} (mode 0600)`,
        ),
      );
    if (saved.staleSecret)
      ctx.out.warn(
        `the previous session of profile "${profileName}" is still in the OS credential store and could not be removed; delete the "compta-cli" item for "${profileName}" there (macOS: security delete-generic-password -s compta-cli -a ${profileName})`,
      );

    const result = {
      profile: profileName,
      source: obtained.source,
      sessionExpiresAt: obtained.expiresAt,
      user,
      companies,
      activeCompany: companyId ?? null,
      sessionStorage: saved.location,
    };
    ctx.out.result(result, (r) => {
      const company = companies.find((c) => c.id === r.activeCompany);
      const lines = [
        `${style.green('✓')} Logged in${r.user.name ? ` as ${r.user.name}` : ''} via ${r.source}`,
      ];
      const expiry = expiryText(r.sessionExpiresAt);
      if (expiry) lines.push(style.dim(`  session ${expiry}`));
      lines.push(style.dim(`  profile "${r.profile}", session kept in ${r.sessionStorage}`));
      if (r.activeCompany)
        lines.push(`  company ${r.activeCompany}${company?.name ? ` (${company.name})` : ''}`);
      else if (companies.length > 1)
        lines.push(
          style.yellow(
            `  ${companies.length} companies: pass --company <id> or set COMPTA_COMPANY`,
          ),
        );
      return lines.join('\n');
    });
  });

  withExamples(
    program
      .command('logout')
      .description('Forget the stored session of the active profile')
      .option('--remote', 'Also end the session on Compta, as logging out of the web app does'),
    'logout',
    'logout --remote',
    'logout --profile work',
  ).action(async (opts: { remote?: boolean }, cmd: Command) => {
    const ctx = contextOf(cmd);
    let remote: boolean | undefined;
    if (opts.remote) {
      try {
        const { client } = await ctx.auth();
        await (await client.request('POST', '/v1/auth/logout')).body?.cancel();
        remote = true;
      } catch (e) {
        remote = false;
        ctx.out.warn(`could not end the session on Compta: ${toComptaError(e).message}`);
      }
    }
    const config = await readConfig(ctx.env);
    const profileName = activeProfileName(config, ctx.options.profile, ctx.env);
    const location = sessionLocation(config.profiles[profileName] ?? {}, ctx.env);
    const { had, secretRemaining } = await forgetSession(
      config,
      profileName,
      ctx.runtime.secrets,
      ctx.env,
    );
    ctx.out.result(
      {
        profile: profileName,
        loggedOut: had && !secretRemaining,
        ...(secretRemaining ? { secretRemaining } : {}),
        ...(remote === undefined ? {} : { remote }),
      },
      (r) =>
        r.loggedOut
          ? `${style.green('✓')} Logged out of profile "${r.profile}"${r.remote ? ' (session ended on Compta too)' : ''}`
          : secretRemaining
            ? `Profile "${r.profile}" is still logged in`
            : `Profile "${r.profile}" had no stored session`,
    );
    if (secretRemaining) {
      ctx.out.warn(
        `the session is still in the ${location} and could not be removed: unlock it and run compta logout again${remote ? '' : ', or end it on Compta with: compta logout --remote'}`,
      );
      ctx.exitCode = ExitCode.unexpected;
    }
  });

  withExamples(
    program
      .command('whoami')
      .description('Show the user, their companies, the active company and the session in use'),
    'whoami',
    'whoami --json | jq .activeCompany',
  ).action(async (_opts: unknown, cmd: Command) => {
    const ctx = contextOf(cmd);
    const auth = await ctx.auth();
    const { user, companies } = await ctx.user();
    let activeCompany: string | null = null;
    try {
      activeCompany = await ctx.companyId();
    } catch (e) {
      if (!(e instanceof ComptaError) || e.exitCode !== ExitCode.usage) throw e;
    }
    const data: Whoami = {
      user,
      companies,
      activeCompany,
      profile: auth.profileName,
      authSource: auth.source,
      sessionStorage:
        auth.source === 'env' ? 'COMPTA_SESSION' : sessionLocation(auth.profile, ctx.env),
      sessionExpiresAt: auth.expiresAt,
    };
    ctx.out.result(data, (w) =>
      renderKeyValues([
        ['user', [w.user.name, w.user.email].filter(Boolean).join(' · ') || w.user.id],
        [
          'companies',
          w.companies
            .map(
              (c) =>
                `${c.id}${c.name ? ` ${c.name}` : ''}${c.id === w.activeCompany ? ' (active)' : ''}`,
            )
            .join('\n           ') || '—',
        ],
        ['active', w.activeCompany ?? style.yellow('none — pass --company <id>')],
        ['profile', w.profile],
        [
          'auth',
          w.authSource === 'env'
            ? 'COMPTA_SESSION environment variable'
            : w.authSource === 'password'
              ? 'email and password'
              : 'token (stdin)',
        ],
        ['session', [w.sessionStorage, expiryText(w.sessionExpiresAt)].filter(Boolean).join(', ')],
      ]),
    );
  });
}
