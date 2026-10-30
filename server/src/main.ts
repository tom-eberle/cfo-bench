/**
 * cfo-bench Compta server (API.md).
 *
 *   node server/src/main.ts --scenario <dir|scenario.json> --api-port <n> --admin-port <n> \
 *     --cert <pem> --key <pem> [--log <file.jsonl>] [--admin-token <t>]
 *
 * API: https on 127.0.0.1:<api-port> (the CLI uses https://localhost:<port>; the certificate
 * must cover DNS:localhost and IP:127.0.0.1). Signed-storage redirects point at
 * https://127.0.0.1:<api-port>/storage/…, a different origin, like a storage bucket.
 * Admin: http on 127.0.0.1:<admin-port>, every request needs `X-Admin-Token` (API.md §8).
 * Port 0 picks a free port. Prints one JSON line when ready:
 *   {"ready": true, "apiPort": …, "adminPort": …, "adminToken": "…"}
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { FakeCompta, apiError } from './compta.ts';
import { WriteLog } from './log.ts';
import { loadScenario } from './scenario.ts';

const HOST = '127.0.0.1';

const { values: args } = parseArgs({
  options: {
    scenario: { type: 'string' },
    'api-port': { type: 'string', default: '0' },
    'admin-port': { type: 'string', default: '0' },
    cert: { type: 'string' },
    key: { type: 'string' },
    log: { type: 'string' },
    'admin-token': { type: 'string' },
  },
  strict: true,
});
for (const required of ['scenario', 'cert', 'key'] as const)
  if (!args[required]) {
    process.stderr.write(`missing --${required}\n`);
    process.exit(2);
  }

const adminToken =
  args['admin-token'] || process.env.CFO_BENCH_ADMIN_TOKEN || randomBytes(24).toString('hex');
const log = new WriteLog(args.log);
const fake = new FakeCompta(loadScenario(args.scenario!), { log });

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** node:http request → Web Request. */
async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(':')) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readAll(req);
  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    body: body?.length ? new Uint8Array(body) : undefined,
  });
}

/** Web Response → node:http response. */
async function send(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) res.setHeader(name, value);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** The 500 envelope (API.md §3) for unhandled failures. */
const INTERNAL_ERROR = JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} } });

const api = createHttpsServer(
  { cert: readFileSync(args.cert!), key: readFileSync(args.key!) },
  (req, res) => {
    const origin = `https://${req.headers.host ?? `localhost:${apiPort()}`}`;
    toRequest(req, origin)
      .then((request) => fake.handle(request))
      .then((response) => send(res, response))
      .catch((e: unknown) => {
        process.stderr.write(`api error: ${(e as Error).stack ?? e}\n`);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(INTERNAL_ERROR);
      });
  },
);

function apiPort(): number {
  return (api.address() as AddressInfo).port;
}

function tokenOk(given: string | string[] | undefined): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return typeof given === 'string' && timingSafeEqual(digest(given), digest(adminToken));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** An admin error in the envelope of API.md §3. */
async function fail(res: ServerResponse, status: number, code: string, message: string): Promise<void> {
  const response = apiError(status, code, message);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(Buffer.from(await response.arrayBuffer()));
}

const admin = createHttpServer((req, res) => {
  (async () => {
    if (!tokenOk(req.headers['x-admin-token'])) return fail(res, 401, 'UNAUTHENTICATED', 'X-Admin-Token required');
    const path = new URL(req.url ?? '/', 'http://admin').pathname;
    const body = req.method === 'POST' ? (await readAll(req)).toString('utf8') : '';
    const input = (body ? JSON.parse(body) : {}) as Record<string, unknown>;
    if (req.method === 'GET' && path === '/__health')
      return json(res, 200, { ok: true, scenario: fake.scenario.id });
    if (req.method === 'GET' && path === '/__state') return json(res, 200, fake.state());
    if (req.method === 'GET' && path === '/__log') return json(res, 200, log.records);
    if (req.method === 'POST' && path === '/__mark') {
      if (typeof input.label !== 'string' || !input.label)
        return fail(res, 400, 'INVALID_PARAMETER', 'label (non-empty string) required');
      return json(res, 200, log.addMark(input.label));
    }
    if (req.method === 'POST' && path === '/__reset') {
      const scenario = typeof input.scenario === 'string' ? input.scenario : fake.scenarioPath;
      fake.load(loadScenario(scenario));
      log.reset(fake.scenario.id);
      return json(res, 200, { ok: true, scenario: fake.scenario.id, transactions: fake.transactions.size });
    }
    return fail(res, 404, 'NOT_FOUND', 'Not found');
  })().catch((e: unknown) => fail(res, 400, 'INVALID_PARAMETER', (e as Error).message));
});

function listen(server: typeof api | typeof admin, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => resolve((server.address() as AddressInfo).port));
  });
}

const apiPortNumber = await listen(api, Number(args['api-port']));
fake.setStorageOrigin(`https://127.0.0.1:${apiPortNumber}`);
const adminPortNumber = await listen(admin, Number(args['admin-port']));
process.stdout.write(
  `${JSON.stringify({ ready: true, apiPort: apiPortNumber, adminPort: adminPortNumber, adminToken })}\n`,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    api.close();
    admin.close();
    process.exit(0);
  });
