import { describe, expect, it } from 'vitest';
import { ApiClient, type Fetch } from '../src/api/client.js';
import { errorPayload, redact } from '../src/output/errors.js';

const BASE = 'https://compta.example.test';

function client(fetch: Fetch, extra: Partial<ConstructorParameters<typeof ApiClient>[0]> = {}) {
  return new ApiClient({
    session: 'secret-session-123',
    baseUrl: BASE,
    fetch,
    sleep: async () => {},
    ...extra,
  });
}

function sequence(...responses: (() => Response)[]): {
  fetch: Fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next();
  }) as Fetch;
  return { fetch, calls };
}

describe('ApiClient', () => {
  it('sends the bearer token, JSON accept header and an honest user agent', async () => {
    const { fetch, calls } = sequence(() => Response.json({ ok: true }));
    await client(fetch).get('/v1/me');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-session-123');
    expect(headers.Cookie).toBeUndefined();
    expect(headers.Accept).toBe('application/json');
    expect(headers['User-Agent']).toMatch(/^compta-cli\/\d+\.\d+\.\d+$/);
  });

  it('retries GET on 5xx and 429, then succeeds', async () => {
    const { fetch, calls } = sequence(
      () => new Response('', { status: 503 }),
      () => new Response('', { status: 429 }),
      () => Response.json([1]),
    );
    expect(await client(fetch).get('/x')).toEqual([1]);
    expect(calls).toHaveLength(3);
  });

  it('never retries writes', async () => {
    const { fetch, calls } = sequence(() => new Response('', { status: 503 }));
    await expect(client(fetch).post('/x', {})).rejects.toMatchObject({
      code: 'API_UNAVAILABLE',
      exitCode: 6,
    });
    expect(calls).toHaveLength(1);
  });

  it('maps 401 to AUTH_EXPIRED (exit 3) and 404 to NOT_FOUND (exit 4)', async () => {
    await expect(
      client(sequence(() => new Response('', { status: 401 })).fetch).get('/x'),
    ).rejects.toMatchObject({
      code: 'AUTH_EXPIRED',
      exitCode: 3,
      hint: 'run: compta login (or: compta login --with-token)',
    });
    await expect(
      client(sequence(() => new Response('', { status: 404 })).fetch).get('/x'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      exitCode: 4,
    });
  });

  it('passes the Compta error message through on rejected requests (exit 5)', async () => {
    const { fetch } = sequence(() =>
      Response.json(
        {
          error: {
            code: 'INVALID_LINES',
            message: 'Malformed request: missing field',
            details: {},
          },
        },
        { status: 400 },
      ),
    );
    await expect(client(fetch).post('/x', {})).rejects.toMatchObject({
      code: 'API_REJECTED',
      exitCode: 5,
      status: 400,
      message: expect.stringContaining('Malformed request: missing field'),
    });
  });

  it('maps the lock refusals (423 PERIOD_LOCKED / MANUALLY_LOCKED) to LOCKED (exit 5)', async () => {
    for (const code of ['PERIOD_LOCKED', 'MANUALLY_LOCKED']) {
      const { fetch } = sequence(() =>
        Response.json(
          { error: { code, message: 'This transaction is locked.', details: {} } },
          { status: 423 },
        ),
      );
      await expect(client(fetch).patch('/v1/x', {})).rejects.toMatchObject({
        code: 'LOCKED',
        exitCode: 5,
        status: 423,
      });
    }
  });

  it('maps 403 on a write to FORBIDDEN with the API message', async () => {
    const { fetch } = sequence(() =>
      Response.json(
        { error: { code: 'FORBIDDEN', message: 'Forbidden', details: {} } },
        { status: 403 },
      ),
    );
    await expect(client(fetch).patch('/v1/x', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      exitCode: 5,
      message: 'Compta refused the change: PATCH /v1/x: Forbidden',
    });
  });

  it('logs requests without ever printing the token', async () => {
    const lines: string[] = [];
    const { fetch } = sequence(() => Response.json({}));
    await client(fetch, { log: (l) => lines.push(l) }).get('/v1/companies/1/transactions?limit=40');
    expect(lines.join('\n')).toMatch(/GET \/v1\/companies\/1\/transactions → 200/);
    expect(lines.join('\n')).not.toContain('secret-session-123');
  });

  it('follows a download redirect without sending the token to storage', async () => {
    const { fetch, calls } = sequence(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://storage.example.test/f/1?sig=abc' },
        }),
      () => new Response(new Uint8Array([37, 80, 68, 70])),
    );
    const bytes = await client(fetch).download('/v1/files/abc/download');
    expect([...bytes]).toEqual([37, 80, 68, 70]);
    expect(calls[1]!.url).toContain('storage.example.test');
    expect(JSON.stringify(calls[1]!.init.headers ?? {})).not.toMatch(/authorization|cookie/i);
    expect(JSON.stringify(calls[1]!.init.headers ?? {})).not.toContain('secret-session-123');
  });

  it('refuses paths that leave the API origin', async () => {
    const { fetch } = sequence();
    await expect(client(fetch).get('//evil.example/x')).rejects.toMatchObject({ code: 'USAGE' });
    await expect(client(fetch).get('https://evil.example/x')).rejects.toMatchObject({
      code: 'USAGE',
    });
  });
});

describe('error payloads', () => {
  it('redacts bearer tokens wherever they appear', () => {
    expect(redact('Authorization: Bearer fake-token-value; other=1')).toBe(
      'Authorization: Bearer [REDACTED]; other=1',
    );
    expect(
      errorPayload(new Error('boom with known-secret-value'), ['known-secret-value']).error.message,
    ).toBe('boom with [REDACTED]');
  });
});
