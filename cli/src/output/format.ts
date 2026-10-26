import { ComptaError, ExitCode, errorPayload, redact, toComptaError } from './errors.js';
import { sanitizeForTerminal, style } from './style.js';

export type OutputMode = 'human' | 'json' | 'jsonl';

export interface Writer {
  write(text: string): unknown;
}

export interface OutputOptions {
  json?: boolean;
  jsonl?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  stdoutIsTTY: boolean;
}

export function resolveMode(
  options: Pick<OutputOptions, 'json' | 'jsonl' | 'stdoutIsTTY'>,
): OutputMode {
  if (options.jsonl) return 'jsonl';
  if (options.json || !options.stdoutIsTTY) return 'json';
  return 'human';
}

/**
 * The only place that writes to stdout/stderr. Data goes to stdout; everything
 * else (progress, warnings, errors) goes to stderr so pipes stay parseable.
 */
export class Output {
  readonly mode: OutputMode;
  private readonly secrets: string[] = [];

  constructor(
    private readonly options: OutputOptions,
    private readonly stdout: Writer,
    private readonly stderr: Writer,
  ) {
    this.mode = resolveMode(options);
  }

  get human(): boolean {
    return this.mode === 'human';
  }

  /** Register a value that must never be printed (tokens, passwords). */
  addSecret(secret: string): void {
    if (secret) this.secrets.push(secret);
  }

  /** Emit command data. Arrays stream one object per line in JSONL mode. */
  result<T>(data: T, human?: (data: T) => string): void {
    if (this.mode === 'jsonl') {
      for (const item of Array.isArray(data) ? data : [data])
        this.stdout.write(`${JSON.stringify(item)}\n`);
    } else if (this.mode === 'json' || !human) {
      this.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    } else {
      const text = human(data);
      if (text) this.stdout.write(sanitizeForTerminal(text.endsWith('\n') ? text : `${text}\n`));
    }
  }

  /** Human-readable text on stderr (e.g. a preview before a confirmation prompt). */
  humanError(text: string): void {
    this.stderr.write(this.term(text));
  }

  /**
   * Everything non-JSON passes through here: secrets redacted, untrusted
   * control characters (terminal escapes) removed, our own styles rendered.
   */
  private term(text: string): string {
    return sanitizeForTerminal(redact(text, this.secrets));
  }

  /** Progress and informational messages (stderr; silenced by --quiet). */
  info(message: string): void {
    if (!this.options.quiet) this.stderr.write(this.term(`${message}\n`));
  }

  warn(message: string): void {
    this.stderr.write(this.term(`${style.yellow('warning')} ${message}\n`));
  }

  /** HTTP/debug logging, only with --verbose. */
  debug(message: string): void {
    if (this.options.verbose) this.stderr.write(this.term(`${style.dim(message)}\n`));
  }

  /** Report a failure on stderr; returns the exit code to use. */
  error(error: unknown): ExitCode {
    const e = toComptaError(error);
    const payload = errorPayload(e, this.secrets);
    if (this.mode === 'human') {
      const lines = [
        `${style.red('error')} ${payload.error.message} ${style.dim(`(${payload.error.code})`)}`,
      ];
      if (payload.error.hint) lines.push(`${style.dim('hint')}  ${payload.error.hint}`);
      if (this.options.verbose && e.cause instanceof Error && e.cause.stack)
        lines.push(style.dim(e.cause.stack));
      this.stderr.write(this.term(`${lines.join('\n')}\n`));
    } else {
      this.stderr.write(`${JSON.stringify(payload)}\n`);
    }
    return e instanceof ComptaError ? e.exitCode : ExitCode.unexpected;
  }
}
