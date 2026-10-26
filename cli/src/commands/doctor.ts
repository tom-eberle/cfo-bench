import type { Command } from 'commander';
import { z } from 'zod';
import { rawLineSchema, rawTransactionSchema } from '../api/schemas.js';
import { daysLeft, sessionLocation } from '../auth/credentials.js';
import { ComptaError, ExitCode, toComptaError } from '../output/errors.js';
import { style } from '../output/style.js';
import { VERSION } from '../version.js';
import { contextOf } from './context.js';
import { withExamples } from './shared.js';

/**
 * The fields of transactions and lines the API documents (server/API.md §5).
 * Other names are reported as "unknown" (the API added something), which is an
 * early warning, not an error.
 */
const KNOWN_TRANSACTION_FIELDS = new Set(
  `id company_id source date label note amount direction validated validated_at status lock issues
   bank lines attachments`.split(/\s+/),
);
const KNOWN_LINE_FIELDS = new Set('id amount direction refund category_id tax'.split(' '));

/** Fields the CLI cannot work without (optional ones may legitimately be absent). */
function requiredKeys(shape: Record<string, z.ZodType>): string[] {
  return Object.entries(shape)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([key]) => key);
}
const REQUIRED_TRANSACTION_FIELDS = requiredKeys(rawTransactionSchema.shape);
const REQUIRED_LINE_FIELDS = requiredKeys(rawLineSchema.shape);

interface Check {
  name: string;
  ok: boolean;
  /** Passed, but needs attention soon. */
  warning?: boolean;
  detail: string;
}

/** Warn this many days before a known session expiry. */
const EXPIRY_WARNING_DAYS = 7;

export function schemaDrift(samples: unknown[]) {
  const issues: { sample: number; path: string; message: string }[] = [];
  const unknownFields = new Set<string>();
  const missingFields = new Set<string>();
  samples.forEach((sample, i) => {
    const parsed = rawTransactionSchema.safeParse(sample);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        issues.push({ sample: i, path: issue.path.join('.'), message: issue.message });
    if (typeof sample !== 'object' || sample === null) return;
    const tx = sample as Record<string, unknown>;
    for (const key of Object.keys(tx))
      if (!KNOWN_TRANSACTION_FIELDS.has(key)) unknownFields.add(key);
    for (const key of REQUIRED_TRANSACTION_FIELDS) if (!(key in tx)) missingFields.add(key);
    for (const b of Array.isArray(tx.lines) ? tx.lines : []) {
      if (typeof b !== 'object' || b === null) continue;
      for (const key of Object.keys(b))
        if (!KNOWN_LINE_FIELDS.has(key)) unknownFields.add(`lines[].${key}`);
      for (const key of REQUIRED_LINE_FIELDS) if (!(key in b)) missingFields.add(`lines[].${key}`);
    }
  });
  return {
    sampled: samples.length,
    valid: issues.length === 0,
    issues: issues.slice(0, 20),
    unknownFields: [...unknownFields],
    missingFields: [...missingFields],
  };
}

export function registerDoctorCommand(program: Command): void {
  withExamples(
    program
      .command('doctor')
      .description(
        'Check auth, API reachability and whether the Compta API still has the expected shape',
      ),
    'doctor',
    'doctor --json',
  ).action(async (_o: unknown, cmd: Command) => {
    const ctx = contextOf(cmd);
    const checks: Check[] = [
      { name: 'version', ok: true, detail: `compta-cli ${VERSION}, Node ${process.versions.node}` },
    ];
    let drift: ReturnType<typeof schemaDrift> | null = null;
    let failure: ComptaError | null = null;
    const step = async (name: string, fn: () => Promise<string | { warning: string }>) => {
      if (failure) return checks.push({ name, ok: false, detail: 'skipped' });
      try {
        const detail = await fn();
        checks.push(
          typeof detail === 'string'
            ? { name, ok: true, detail }
            : { name, ok: true, warning: true, detail: detail.warning },
        );
      } catch (e) {
        failure = toComptaError(e);
        checks.push({
          name,
          ok: false,
          detail: failure.hint ? `${failure.message} (${failure.hint})` : failure.message,
        });
      }
    };
    await step('credentials', async () => {
      const auth = await ctx.auth();
      return `profile "${auth.profileName}" from ${auth.source === 'env' ? 'COMPTA_SESSION' : `${auth.source} (${sessionLocation(auth.profile, ctx.env)})`}`;
    });
    await step('expiry', async () => {
      const { expiresAt, source } = await ctx.auth();
      const days = daysLeft(expiresAt);
      if (days === null || !expiresAt)
        return source === 'env' || source === 'token'
          ? 'unknown for a pasted session'
          : 'unknown; recorded at the next compta login';
      const date = expiresAt.slice(0, 10);
      if (days < 0)
        throw new ComptaError('AUTH_EXPIRED', `the session expired on ${date}`, {
          exitCode: ExitCode.auth,
          hint: 'run: compta login',
        });
      const left = `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'}`;
      return days < EXPIRY_WARNING_DAYS
        ? { warning: `the session expires on ${date}, in ${left}: run compta login soon` }
        : `session valid until ${date} (${left})`;
    });
    await step('session', async () => {
      const { user, companies } = await ctx.user();
      return `authenticated as user ${user.id}; ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}`;
    });
    await step('company', async () => `using company ${await ctx.companyId()}`);
    await step('operations', async () => {
      const compta = await ctx.compta();
      const [a, b] = await Promise.all([
        compta.client.get(
          `/v1/companies/${compta.company}/transactions?limit=20&offset=0&validated=false`,
        ),
        compta.client.get(
          `/v1/companies/${compta.company}/transactions?limit=20&offset=0&validated=true`,
        ),
      ]);
      const samples = [...z.array(z.unknown()).parse(a), ...z.array(z.unknown()).parse(b)];
      drift = schemaDrift(samples);
      if (!drift.valid)
        throw new ComptaError(
          'API_SHAPE',
          `${drift.issues.length} schema issue(s) in ${samples.length} sampled operations`,
          {
            exitCode: ExitCode.network,
            hint: 'the Compta API changed; report it with: compta doctor --json',
          },
        );
      return `${samples.length} sampled operations match the expected schema`;
    });
    await step(
      'categories',
      async () => `${(await (await ctx.compta()).categories()).length} assignable categories`,
    );

    const ok = checks.every((c) => c.ok);
    const result = { ok, checks, schema: drift };
    ctx.out.result(result, (r) => {
      const lines = r.checks.map(
        (c) =>
          `${!c.ok ? style.red('✗') : c.warning ? style.yellow('!') : style.green('✓')} ${c.name.padEnd(11)} ${!c.ok ? style.red(c.detail) : c.warning ? style.yellow(c.detail) : c.detail}`,
      );
      const d = r.schema as ReturnType<typeof schemaDrift> | null;
      if (d?.unknownFields.length)
        lines.push(style.yellow(`! new API fields (harmless, FYI): ${d.unknownFields.join(', ')}`));
      if (d?.missingFields.length)
        lines.push(style.yellow(`! expected fields not seen: ${d.missingFields.join(', ')}`));
      return lines.join('\n');
    });
    if (!ok) ctx.exitCode = (failure as ComptaError | null)?.exitCode ?? ExitCode.network;
  });
}
