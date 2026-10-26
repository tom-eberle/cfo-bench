import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { HttpMethod } from '../api/client.js';
import { usageError } from '../output/errors.js';
import { contextOf } from './context.js';
import { addMutationOptions, withExamples } from './shared.js';

const METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];

function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw usageError(`${source} is not valid JSON`);
  }
}

function setPath(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  node[parts.at(-1)!] = value;
}

export function registerApiCommand(program: Command): void {
  withExamples(
    addMutationOptions(
      program
        .command('api <method> <path>')
        .description(
          'Call any Compta API endpoint with your token ({company} is replaced by the active company)',
        )
        .option('-d, --data <json>', 'Request body: inline JSON, @file, or - for stdin')
        .option(
          '-F, --field <key=value>',
          'Add a body field (repeatable; values parsed as JSON when possible; dots nest)',
          (v: string, all: string[]) => [...all, v],
          [],
        )
        .option('--raw', 'Print the response body exactly as received'),
    ),
    'api GET /v1/companies/{company}/bank-accounts',
    'api GET "/v1/companies/{company}/transactions?limit=5&offset=0&validated=false" | jq length',
    'api POST /v1/companies/{company}/some/endpoint -F name=test --dry-run',
  ).action(
    async (
      methodArg: string,
      pathArg: string,
      o: { data?: string; field: string[]; raw?: boolean; dryRun?: boolean; yes?: boolean },
      cmd: Command,
    ) => {
      const ctx = contextOf(cmd);
      const method = methodArg.toUpperCase() as HttpMethod;
      if (!METHODS.includes(method))
        throw usageError(`Unsupported method "${methodArg}"`, `use one of ${METHODS.join(', ')}`);
      const path = pathArg.includes('{company}')
        ? pathArg.replaceAll('{company}', await ctx.companyId())
        : pathArg;

      let body: unknown;
      if (o.data !== undefined) {
        const text =
          o.data === '-'
            ? await ctx.runtime.readStdin()
            : o.data.startsWith('@')
              ? await readFile(o.data.slice(1), 'utf8')
              : o.data;
        body = parseJson(text, o.data.startsWith('@') ? o.data.slice(1) : '--data');
      }
      if (o.field.length) {
        if (
          body !== undefined &&
          (typeof body !== 'object' || body === null || Array.isArray(body))
        )
          throw usageError('--field can only be combined with a JSON object --data');
        const fields = (body ?? {}) as Record<string, unknown>;
        for (const f of o.field) {
          const eq = f.indexOf('=');
          if (eq < 1) throw usageError(`--field expects key=value, got "${f}"`);
          const raw = f.slice(eq + 1);
          let value: unknown = raw;
          try {
            value = JSON.parse(raw);
          } catch {
            // plain string
          }
          setPath(fields, f.slice(0, eq), value);
        }
        body = fields;
      }
      if (method === 'GET' || method === 'HEAD') {
        if (body !== undefined) throw usageError(`${method} requests cannot have a body`);
      } else {
        if (o.dryRun) return ctx.out.result({ dryRun: true, method, path, body: body ?? null });
        await ctx.confirm(`Send ${method} ${path} to Compta?`, o.yes);
      }

      const { client } = await ctx.auth();
      const response = await client.request(method, path, body);
      const text = await response.text();
      if (o.raw || !text) {
        ctx.runtime.stdout.write(text.endsWith('\n') || !text ? text : `${text}\n`);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        ctx.runtime.stdout.write(`${text}\n`);
        return;
      }
      ctx.out.result(parsed, (v) => JSON.stringify(v, null, 2));
    },
  );
}
