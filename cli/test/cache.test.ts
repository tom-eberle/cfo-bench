import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CACHE_SCHEMA_VERSION, cacheRoot } from '../src/api/cache.js';
import { CATEGORIES_KEY } from '../src/api/compta.js';
import { FakeCompta } from './helpers/fake-api.js';
import { COMPANY, rawCategories, rawOp } from './helpers/fixtures.js';
import { runCli, tempHome } from './helpers/run.js';

const BASE = 'https://compta.example.test';

const sample = () =>
  new FakeCompta([rawOp({ id: 101, date: '2026-08-20', wording: 'CB ORBIT TOOLS', amount: 120 })]);

/** Write a valid category list into the cache of `home`, as an earlier run would have. */
function warmCache(home: string, categories: unknown[], base = BASE): string {
  const dir = cacheRoot(join(home, 'cache', 'compta-cli'), base, COMPANY);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, CATEGORIES_KEY),
    JSON.stringify({ at: Date.now(), value: JSON.stringify(categories) }),
  );
  return dir;
}

const categoryRequests = (api: FakeCompta) =>
  api.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/categories')).length;

describe('category cache (Codex review A2, finding 5)', () => {
  it('refreshes a warmed cache that lacks a referenced category: no blank name', async () => {
    const api = sample();
    const home = tempHome();
    // Valid, but from before category 69 existed (scenario or taxonomy changed).
    warmCache(
      home,
      rawCategories().filter((c) => c.id !== 69),
    );
    const set = await runCli(api, ['ops', 'set', '101', '--category', '69', '--yes'], { home });
    expect(set.code).toBe(0);
    const get = await runCli(api, ['ops', 'get', '101', '--json'], { home });
    expect(get.code).toBe(0);
    expect((get.json() as { category: unknown }).category).toEqual({
      id: 69,
      name: 'Publicité',
      path: ['Frais de fonctionnement', 'Publicité'],
    });
    // The refreshed list replaced the cached one: a later run reads 69 from the cache.
    const before = categoryRequests(api);
    const again = await runCli(api, ['ops', 'get', '101', '--json'], { home });
    expect((again.json() as { category: { name: string } }).category.name).toBe('Publicité');
    expect(categoryRequests(api)).toBe(before);
  });

  it('reads a complete warmed cache without asking the API', async () => {
    const api = sample();
    const home = tempHome();
    warmCache(home, rawCategories());
    const r = await runCli(api, ['ops', 'get', '101', '--json'], { home });
    expect(r.code).toBe(0);
    expect(categoryRequests(api)).toBe(0);
  });

  it('fails loudly when the API itself does not know the category', async () => {
    const api = sample();
    api.overrides.push((req) =>
      req.method === 'GET' && req.path.endsWith('/categories')
        ? Response.json(rawCategories().filter((c) => c.id !== 77))
        : undefined,
    );
    const r = await runCli(api, ['ops', 'get', '101', '--json']); // 101 is in category 77
    expect(r.code).not.toBe(0);
    expect(r.error()).toMatchObject({
      code: 'CATEGORY_UNKNOWN',
      message: expect.stringContaining('category 77'),
    });
    expect(r.stdout).not.toContain('"name":""');
  });

  it('scopes the cache by API origin, company and schema version', async () => {
    const api = sample();
    const home = tempHome();
    // Another origin's list (another scenario) must not be read for this one.
    warmCache(
      home,
      rawCategories().map((c) => ({ ...c, label: 'Other origin' })),
      'https://other.example.test',
    );
    const r = await runCli(api, ['ops', 'get', '101', '--json'], { home });
    expect((r.json() as { category: { name: string } }).category.name).toBe(
      'Logiciels et abonnements',
    );
    expect(categoryRequests(api)).toBe(1);
    expect(readdirSync(join(home, 'cache', 'compta-cli'))).toEqual([CACHE_SCHEMA_VERSION]);
    expect(cacheRoot('/c', `${BASE}/`, COMPANY)).toBe(
      cacheRoot('/c', 'https://compta.example.test', COMPANY),
    );
    expect(cacheRoot('/c', BASE, COMPANY)).not.toBe(cacheRoot('/c', BASE, '123'));
  });
});
