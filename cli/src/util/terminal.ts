import type { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline/promises';
import { ComptaError, ExitCode } from '../output/errors.js';

export interface PromptInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/** The parts of `process` a hidden prompt needs to restore the terminal on the way out. */
export interface ProcessHooks extends EventEmitter {
  exit(code?: number): never;
}

const cancelled = () => new ComptaError('CANCELLED', 'Cancelled', { exitCode: ExitCode.usage });

/** Ask a question on `output`; Ctrl-C or end of input is CANCELLED (exit 2), never a hang. */
export function createAsk(input: PromptInput, output: NodeJS.WritableStream) {
  return async (question: string): Promise<string> => {
    const rl = createInterface({ input, output });
    try {
      return await new Promise<string>((resolve, reject) => {
        rl.once('SIGINT', () => reject(cancelled()));
        rl.once('close', () => reject(cancelled()));
        rl.question(question).then(resolve, (error: Error) =>
          reject(error?.name === 'AbortError' ? cancelled() : error),
        );
      });
    } finally {
      rl.close();
    }
  };
}

/**
 * Read a line without echoing it, in raw mode. The terminal is restored whatever ends
 * the prompt: Enter, Ctrl-C, Ctrl-D, end or error of input, process exit or SIGTERM.
 */
export function createAskSecret(
  input: PromptInput,
  output: NodeJS.WritableStream,
  proc: ProcessHooks,
) {
  return (question: string): Promise<string> =>
    new Promise((resolve, reject) => {
      let value = '';
      let done = false;
      const restore = () => {
        input.off('data', onData);
        input.off('end', onEnd);
        input.off('error', onError);
        proc.off('exit', restore);
        proc.off('SIGTERM', onTerm);
        input.setRawMode?.(false);
        input.pause();
      };
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        restore();
        output.write('\n');
        if (error) reject(error);
        else resolve(value);
      };
      const onData = (chunk: string | Buffer) => {
        for (const char of String(chunk)) {
          if (char === '\r' || char === '\n' || char === '\u0004') return finish();
          if (char === '\u0003') return finish(cancelled());
          if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join('');
          else if (char >= ' ') value += char;
        }
      };
      const onEnd = () => finish(cancelled());
      const onError = (error: Error) => finish(error);
      const onTerm = () => {
        finish(cancelled());
        proc.exit(143);
      };
      output.write(question);
      input.setRawMode?.(true);
      input.setEncoding?.('utf8');
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', onError);
      proc.once('exit', restore);
      proc.once('SIGTERM', onTerm);
      input.resume();
    });
}
