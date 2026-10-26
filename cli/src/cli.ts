import { platformSecretStore } from './auth/secrets.js';
import type { Runtime } from './commands/context.js';
import { run } from './program.js';
import { createAsk, createAskSecret } from './util/terminal.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

// A closed pipe (e.g. `compta ops list | head`) is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const runtime: Runtime = {
  env: process.env,
  fetch: globalThis.fetch,
  stdout: process.stdout,
  stderr: process.stderr,
  stdoutIsTTY: !!process.stdout.isTTY,
  stdinIsTTY: !!process.stdin.isTTY,
  readStdin,
  ask: createAsk(process.stdin, process.stderr),
  askSecret: createAskSecret(process.stdin, process.stderr, process),
  secrets: platformSecretStore(process.platform, process.env),
};

process.exitCode = await run(process.argv.slice(2), runtime);
