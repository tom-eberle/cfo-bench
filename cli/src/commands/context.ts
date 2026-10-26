import type { Command } from 'commander';
import { Cache, cacheRoot } from '../api/cache.js';
import { ApiClient, type Fetch } from '../api/client.js';
import { Compta } from '../api/compta.js';
import { normalizeUser } from '../api/normalize.js';
import { type Company, rawUserSchema, type Whoami } from '../api/schemas.js';
import {
  activeProfileName,
  apiBase,
  type Config,
  cacheDir,
  type Env,
  type Profile,
  readConfig,
} from '../auth/config.js';
import { readSession } from '../auth/credentials.js';
import type { SecretStore } from '../auth/secrets.js';
import { ComptaError, ExitCode, LOGIN_HINT } from '../output/errors.js';
import { Output, type Writer } from '../output/format.js';
import { sanitizeForTerminal } from '../output/style.js';

export interface GlobalOptions {
  json?: boolean;
  jsonl?: boolean;
  profile?: string;
  company?: string;
  verbose?: boolean;
  quiet?: boolean;
  color?: boolean;
  cache?: boolean;
}

/** Everything the CLI touches in the outside world, injectable for tests. */
export interface Runtime {
  env: Env;
  fetch: Fetch;
  stdout: Writer;
  stderr: Writer;
  stdoutIsTTY: boolean;
  stdinIsTTY: boolean;
  readStdin: () => Promise<string>;
  /** Ask a question on stderr; only called when stdin is a TTY. */
  ask: (question: string) => Promise<string>;
  /** Like ask, without echoing the answer (passwords). */
  askSecret: (question: string) => Promise<string>;
  /** The OS credential store, or null to keep sessions in the 0600 config file. */
  secrets: SecretStore | null;
}

export type AuthSource = Whoami['authSource'];

export interface AuthState {
  client: ApiClient;
  config: Config;
  profileName: string;
  profile: Profile;
  source: AuthSource;
  /** When the token expires, if known. */
  expiresAt: string | null;
}

export class Context {
  readonly out: Output;
  /** Exit code to use when the command completes without throwing (e.g. 7 for partial failure). */
  exitCode: ExitCode = ExitCode.ok;
  private authState?: Promise<AuthState>;
  private userState?: Promise<{ user: Whoami['user']; companies: Company[] }>;
  private comptaState?: Promise<Compta>;

  constructor(
    readonly runtime: Runtime,
    readonly options: GlobalOptions,
  ) {
    this.out = new Output(
      {
        json: options.json,
        jsonl: options.jsonl,
        quiet: options.quiet,
        verbose: options.verbose,
        stdoutIsTTY: runtime.stdoutIsTTY,
      },
      runtime.stdout,
      runtime.stderr,
    );
  }

  get env(): Env {
    return this.runtime.env;
  }

  /** A client for the stored or environment-provided session. */
  auth(): Promise<AuthState> {
    this.authState ??= this.loadAuth();
    return this.authState;
  }

  private async loadAuth(): Promise<AuthState> {
    const baseUrl = apiBase(this.env);
    const config = await readConfig(this.env);
    const profileName = activeProfileName(config, this.options.profile, this.env);
    const envSession = this.env.COMPTA_SESSION?.trim();
    const session =
      envSession ||
      (await readSession(config, profileName, this.runtime.secrets, this.env, (line) =>
        this.out.debug(line),
      ));
    if (!session)
      throw new ComptaError('AUTH_MISSING', `Not logged in (profile "${profileName}")`, {
        exitCode: ExitCode.auth,
        hint: LOGIN_HINT,
      });
    const profile = config.profiles[profileName] ?? {};
    const source: AuthSource = envSession ? 'env' : (profile.source ?? 'token');
    this.out.addSecret(session);
    const client = new ApiClient({
      session,
      baseUrl,
      fetch: this.runtime.fetch,
      log: (line) => this.out.debug(line),
    });
    return {
      client,
      config,
      profileName,
      profile,
      source,
      expiresAt: envSession ? null : (profile.sessionExpiresAt ?? null),
    };
  }

  /** Current user and the companies they can access. */
  user(): Promise<{ user: Whoami['user']; companies: Company[] }> {
    this.userState ??= (async () => {
      const { client } = await this.auth();
      return normalizeUser(rawUserSchema.parse(await client.get('/v1/me')));
    })();
    return this.userState;
  }

  /** Resolve the company: --company, COMPTA_COMPANY, profile default, or the only one. */
  async companyId(): Promise<string> {
    const auth = await this.auth();
    const explicit = this.options.company || this.env.COMPTA_COMPANY || auth.profile.companyId;
    if (explicit) {
      if (!/^\d+$/.test(explicit))
        throw new ComptaError('USAGE', `Company ids are numeric, got "${explicit}"`, {
          exitCode: ExitCode.usage,
        });
      return explicit;
    }
    const { companies } = await this.user();
    if (companies.length === 1) return companies[0]!.id;
    throw new ComptaError(
      'COMPANY_REQUIRED',
      companies.length
        ? `You have access to ${companies.length} companies; choose one`
        : 'No company found for this user',
      {
        exitCode: ExitCode.usage,
        hint: companies.length
          ? `pass --company <id> (one of: ${companies.map((c) => c.id).join(', ')}) or set COMPTA_COMPANY`
          : undefined,
      },
    );
  }

  compta(): Promise<Compta> {
    this.comptaState ??= (async () => {
      const [{ client }, company] = await Promise.all([this.auth(), this.companyId()]);
      const cache = new Cache(
        cacheRoot(cacheDir(this.env), client.baseUrl, company),
        this.options.cache !== false,
      );
      return new Compta(client, company, cache);
    })();
    return this.comptaState;
  }

  /**
   * Gate a mutation. TTY: ask once. Non-interactive: refuse with exit 2 unless
   * --yes, so an agent can never hang on a prompt.
   */
  async confirm(question: string, yes: boolean | undefined): Promise<void> {
    if (yes) return;
    if (!this.runtime.stdinIsTTY || !this.runtime.stdoutIsTTY)
      throw new ComptaError(
        'CONFIRMATION_REQUIRED',
        'This command changes data in Compta and needs confirmation',
        {
          exitCode: ExitCode.usage,
          hint: 're-run with --yes to apply, or --dry-run to preview',
        },
      );
    const answer = await this.runtime.ask(sanitizeForTerminal(`${question} [y/N] `));
    if (!/^y(es)?$/i.test(answer.trim()))
      throw new ComptaError('CANCELLED', 'Cancelled; nothing was changed', {
        exitCode: ExitCode.usage,
      });
  }
}

/** Resolve the shared Context from any (sub)command. */
export function contextOf(command: Command): Context {
  let root: Command = command;
  while (root.parent) root = root.parent;
  const holder = root as Command & { cliContext?: Context; cliRuntime?: Runtime };
  if (!holder.cliContext) {
    if (!holder.cliRuntime) throw new Error('CLI runtime not initialised');
    holder.cliContext = new Context(holder.cliRuntime, command.optsWithGlobals<GlobalOptions>());
  }
  return holder.cliContext;
}
