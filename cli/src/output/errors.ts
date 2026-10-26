/** Stable process exit codes (SPEC §5.2). */
export const ExitCode = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  rejected: 5,
  network: 6,
  partial: 7,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export interface ErrorOptions {
  exitCode?: ExitCode;
  hint?: string;
  status?: number;
  /** The API's `error.code` when the API refused the request (not printed). */
  apiCode?: string;
  cause?: unknown;
}

/** An error the CLI knows how to explain: machine code, human message, optional hint. */
export class ComptaError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly hint?: string;
  readonly status?: number;
  readonly apiCode?: string;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'ComptaError';
    this.code = code;
    this.exitCode = options.exitCode ?? ExitCode.unexpected;
    this.hint = options.hint;
    this.status = options.status;
    this.apiCode = options.apiCode;
  }
}

export const LOGIN_HINT = 'run: compta login (or: compta login --with-token)';

export function usageError(message: string, hint?: string): ComptaError {
  return new ComptaError('USAGE', message, { exitCode: ExitCode.usage, hint });
}

export function notFound(message: string, hint?: string): ComptaError {
  return new ComptaError('NOT_FOUND', message, { exitCode: ExitCode.notFound, hint, status: 404 });
}

export interface ErrorPayload {
  error: { code: string; message: string; hint?: string; status?: number };
}

const BEARER = /\bBearer\s+[^\s"',;]+/gi;

/** Remove anything that looks like a bearer token, plus explicitly known secrets. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('[REDACTED]');
  return out.replace(BEARER, 'Bearer [REDACTED]');
}

export function toComptaError(error: unknown): ComptaError {
  if (error instanceof ComptaError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ComptaError('UNEXPECTED', message || 'Unexpected failure', {
    hint: 're-run with --verbose; if it persists, please open an issue',
    cause: error,
  });
}

export function errorPayload(error: unknown, secrets: readonly string[] = []): ErrorPayload {
  const e = toComptaError(error);
  return {
    error: {
      code: e.code,
      message: redact(e.message, secrets),
      ...(e.hint ? { hint: e.hint } : {}),
      ...(e.status ? { status: e.status } : {}),
    },
  };
}
