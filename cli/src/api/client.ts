import { ComptaError, ExitCode, LOGIN_HINT, notFound, redact } from '../output/errors.js';
import { Limiter } from '../util/concurrency.js';
import { USER_AGENT } from '../version.js';

export type Fetch = typeof fetch;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface ClientOptions {
  /** The API token, sent as `Authorization: Bearer <token>`. */
  session: string;
  /** The API origin (COMPTA_API_BASE). */
  baseUrl: string;
  fetch?: Fetch;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  timeoutMs?: number;
}

const MAX_CONCURRENCY = 4;

/** Machine codes of the API's lock refusals (HTTP 423). */
const LOCK_CODES = new Set(['PERIOD_LOCKED', 'MANUALLY_LOCKED']);

/**
 * HTTP client for the Compta API: bearer auth, polite concurrency, GET-only
 * retries with backoff, and errors mapped to stable exit codes.
 */
export class ApiClient {
  readonly baseUrl: string;
  private readonly session: string;
  private readonly transport: Fetch;
  private readonly limiter = new Limiter(MAX_CONCURRENCY);
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: ClientOptions) {
    this.session = options.session;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.transport = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get currentSession(): string {
    return this.session;
  }

  async get<T = unknown>(path: string): Promise<T> {
    return (await this.json('GET', path)) as T;
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return (await this.json('POST', path, body)) as T;
  }

  async patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return (await this.json('PATCH', path, body)) as T;
  }

  async delete<T = unknown>(path: string): Promise<T> {
    return (await this.json('DELETE', path)) as T;
  }

  /** Send a request and decode the JSON body (null for empty responses). */
  async json(method: HttpMethod, path: string, body?: unknown): Promise<unknown> {
    const response = await this.request(method, path, body);
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ComptaError('API_SHAPE', `Expected JSON from ${method} ${pathOnly(path)}`, {
        exitCode: ExitCode.network,
        hint: 'run: compta doctor',
      });
    }
  }

  /** Low-level request. Redirects are returned, not followed (see download). */
  async request(method: HttpMethod, path: string, body?: unknown): Promise<Response> {
    const url = this.resolve(path);
    return this.limiter.run(async () => {
      const maxRetries = method === 'GET' ? (this.options.maxRetries ?? 3) : 0;
      for (let attempt = 0; ; attempt++) {
        const started = Date.now();
        let response: Response;
        try {
          response = await this.transport(url, {
            method,
            headers: this.headers(body),
            body: encodeBody(body),
            redirect: 'manual',
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
          });
        } catch (cause) {
          this.log(`${method} ${pathOnly(path)} → network error (${(cause as Error).message})`);
          if (attempt < maxRetries) {
            await this.sleep(backoff(attempt));
            continue;
          }
          throw new ComptaError('NETWORK', `Could not reach ${this.baseUrl}`, {
            exitCode: ExitCode.network,
            hint: 'check your connection and retry',
            cause,
          });
        }
        this.log(`${method} ${pathOnly(path)} → ${response.status} (${Date.now() - started} ms)`);
        if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await response.body?.cancel();
          await this.sleep(
            Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt),
          );
          continue;
        }
        if (response.status >= 400) throw await this.toError(method, path, response);
        return response;
      }
    });
  }

  /**
   * Download a file, following redirects. The token is only ever sent to the API
   * for the first request, never to the signed storage URL it redirects to.
   */
  async download(path: string): Promise<Uint8Array> {
    let response = await this.request('GET', path);
    const api = new URL(this.baseUrl);
    for (let hops = 0; response.status >= 300 && response.status < 400; hops++) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || hops >= 5)
        throw new ComptaError('DOWNLOAD_FAILED', 'File download redirect could not be followed', {
          exitCode: ExitCode.network,
        });
      const next = new URL(location, this.baseUrl);
      if (next.protocol !== 'https:' && next.origin !== api.origin)
        throw new ComptaError('DOWNLOAD_FAILED', 'Refusing a non-HTTPS download redirect', {
          exitCode: ExitCode.network,
        });
      response = await this.limiter.run(() =>
        this.transport(next, {
          headers: { 'User-Agent': USER_AGENT },
          redirect: 'manual',
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
        }),
      );
      this.log(`GET ${next.origin}/… (signed storage URL) → ${response.status}`);
    }
    if (!response.ok)
      throw new ComptaError('DOWNLOAD_FAILED', `File download failed (HTTP ${response.status})`, {
        exitCode: ExitCode.network,
        status: response.status,
      });
    return new Uint8Array(await response.arrayBuffer());
  }

  private resolve(path: string): URL {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new ComptaError('USAGE', `API paths must start with "/", got "${path}"`, {
        exitCode: ExitCode.usage,
      });
    const url = new URL(this.baseUrl + path);
    if (url.origin !== new URL(this.baseUrl).origin)
      throw new ComptaError('USAGE', 'API path must stay on the API origin', {
        exitCode: ExitCode.usage,
      });
    return url;
  }

  private headers(body: unknown): Record<string, string> {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.session}`,
      'User-Agent': USER_AGENT,
      ...(body !== undefined && !(body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : {}),
    };
  }

  private async toError(
    method: HttpMethod,
    path: string,
    response: Response,
  ): Promise<ComptaError> {
    const { code, message: apiMessage } = await readApiError(response);
    const where = `${method} ${pathOnly(path)}`;
    const detail = apiMessage ? `: ${apiMessage}` : '';
    const status = response.status;
    if (status === 423 || (code && LOCK_CODES.has(code)))
      return new ComptaError('LOCKED', `Compta refused ${where}: the accounting lines are locked`, {
        exitCode: ExitCode.rejected,
        hint: 'the period is locked in Compta; unlocking is an accountant action in the web app',
        status,
      });
    if (status === 401)
      return new ComptaError('AUTH_EXPIRED', 'Compta session is missing or expired', {
        exitCode: ExitCode.auth,
        hint: LOGIN_HINT,
        status,
      });
    if (status === 403)
      return method === 'GET'
        ? new ComptaError('FORBIDDEN', `Compta refused access to ${where}${detail}`, {
            exitCode: ExitCode.rejected,
            hint: 'check --company, or log in again: compta login',
            status,
          })
        : new ComptaError('FORBIDDEN', `Compta refused the change: ${where}${detail}`, {
            exitCode: ExitCode.rejected,
            hint: 'your session is fine (reads work); Compta does not allow this change on this record — check it in the web app',
            status,
          });
    if (status === 404) return notFound(`Not found: ${where}`);
    if (status === 429 || status >= 500)
      return new ComptaError(
        'API_UNAVAILABLE',
        `Compta is unavailable (HTTP ${status}) for ${where}${detail}`,
        {
          exitCode: ExitCode.network,
          hint: 'retry in a minute',
          status,
        },
      );
    return new ComptaError('API_REJECTED', `Compta rejected ${where} (HTTP ${status})${detail}`, {
      exitCode: ExitCode.rejected,
      status,
      apiCode: code ?? undefined,
    });
  }

  private log(line: string): void {
    this.options.log?.(redact(line, [this.session]));
  }
}

function encodeBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (body instanceof FormData) return body;
  return JSON.stringify(body);
}

function backoff(attempt: number): number {
  return 300 * 2 ** attempt + Math.floor(Math.random() * 100);
}

function pathOnly(path: string): string {
  return path.split('?')[0] ?? path;
}

/** The API's error envelope: `{"error": {"code", "message", "details"}}`. */
export async function readApiError(
  response: Response,
): Promise<{ code: string | null; message: string | null }> {
  try {
    const text = (await response.text()).slice(0, 2000);
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const error = parsed?.error;
    return {
      code: typeof error?.code === 'string' ? error.code : null,
      message: typeof error?.message === 'string' ? error.message.slice(0, 300) : null,
    };
  } catch {
    return { code: null, message: null };
  }
}
