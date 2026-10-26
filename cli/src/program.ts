import { Command, CommanderError } from 'commander';
import { z } from 'zod';
import { registerApiCommand } from './commands/api.js';
import { registerApplyCommand } from './commands/apply.js';
import { registerAuthCommands } from './commands/auth.js';
import { Context, type GlobalOptions, type Runtime } from './commands/context.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerMetaCommands } from './commands/meta.js';
import { registerOpsCommands } from './commands/ops.js';
import { registerReceiptsCommands } from './commands/receipts.js';
import { registerResourceCommands } from './commands/resources.js';
import { withExamples } from './commands/shared.js';
import { registerWorkflowCommands } from './commands/workflows.js';
import { ComptaError, ExitCode, usageError } from './output/errors.js';
import { Output } from './output/format.js';
import { setColorEnabled } from './output/style.js';
import { VERSION } from './version.js';

const DESCRIPTION = [
  'Command-line client for Compta, the accounting platform, built for humans and AI agents.',
  '',
  'Tables in a terminal, JSON when piped (or with --json). Bulk changes are planned first (--plan file.json), reviewed, then executed with: compta apply file.json',
].join('\n');

export function buildProgram(runtime: Runtime): Command {
  const program = new Command('compta')
    .description(DESCRIPTION)
    .version(VERSION, '-v, --version', 'Print the version')
    .option('--json', 'Output JSON (default when stdout is not a terminal)')
    .option('--jsonl', 'Output one JSON object per line (lists)')
    .option('--profile <name>', 'Credential profile (env: COMPTA_PROFILE)')
    .option('--company <id>', 'Company id (env: COMPTA_COMPANY)')
    .option('--verbose', 'Log HTTP requests to stderr (tokens redacted)')
    .option('-q, --quiet', 'Only print data and errors')
    .option('--no-color', 'Disable colours (also: NO_COLOR)')
    .option('--no-cache', 'Bypass the local cache (categories, extracted PDF text)')
    .helpOption('-h, --help', 'Show help')
    .showSuggestionAfterError(true)
    .configureHelp({ showGlobalOptions: true })
    .exitOverride()
    .configureOutput({
      writeOut: (s) => runtime.stdout.write(s),
      writeErr: () => {}, // errors are reported once, in our own format
    });
  withExamples(
    program,
    'login',
    'todo',
    'receipts match ./inbox --plan receipts.plan.json',
    'apply receipts.plan.json',
  );

  program.hook('preAction', (_root, action) => {
    const options = action.optsWithGlobals<GlobalOptions>();
    setColorEnabled(
      runtime.stdoutIsTTY &&
        options.color !== false &&
        !runtime.env.NO_COLOR &&
        runtime.env.TERM !== 'dumb',
    );
    (program as Command & { cliContext?: Context }).cliContext = new Context(runtime, options);
  });
  (program as Command & { cliRuntime?: Runtime }).cliRuntime = runtime;

  program.commandsGroup('Workflows:');
  registerWorkflowCommands(program);
  registerReceiptsCommands(program);
  registerApplyCommand(program);
  program.commandsGroup('Resources:');
  registerOpsCommands(program);
  registerResourceCommands(program);
  program.commandsGroup('Auth:');
  registerAuthCommands(program);
  program.commandsGroup('Agents & diagnostics:');
  registerApiCommand(program);
  registerMetaCommands(program);
  registerDoctorCommand(program);
  return program;
}

function commanderToError(e: CommanderError): ComptaError {
  const message = e.message.replace(/^error:\s*/i, '');
  return usageError(
    message.charAt(0).toUpperCase() + message.slice(1),
    'see: compta --help, or compta <command> --help',
  );
}

/** Parse argv, run the command, and return the process exit code. Never throws. */
export async function run(argv: readonly string[], runtime: Runtime): Promise<number> {
  const program = buildProgram(runtime);
  try {
    await program.parseAsync([...argv], { from: 'user' });
    const ctx = (program as Command & { cliContext?: Context }).cliContext;
    return ctx?.exitCode ?? ExitCode.ok;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return ExitCode.ok;
    const ctx = (program as Command & { cliContext?: Context }).cliContext;
    const out =
      ctx?.out ??
      new Output(
        {
          json: argv.includes('--json'),
          jsonl: argv.includes('--jsonl'),
          stdoutIsTTY: runtime.stdoutIsTTY,
        },
        runtime.stdout,
        runtime.stderr,
      );
    const normalized =
      error instanceof CommanderError
        ? commanderToError(error)
        : error instanceof z.ZodError
          ? new ComptaError(
              'API_SHAPE',
              `Unexpected response shape: ${error.issues[0]?.path.join('.')}: ${error.issues[0]?.message}`,
              {
                exitCode: ExitCode.network,
                hint: 'run: compta doctor',
              },
            )
          : error;
    return out.error(normalized);
  }
}
