import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Version of what the cache holds (raw API shapes); bump it when a cached schema changes,
 * so older entries are never read.
 */
export const CACHE_SCHEMA_VERSION = 'v2';

/**
 * Where one company's cache lives: ~/.cache/compta-cli/<schema version>/<API origin>/<company>/.
 * Data cached from one API origin (or one company) is never read for another.
 */
export function cacheRoot(dir: string, apiBase: string, company: string): string {
  let origin: string;
  try {
    origin = new URL(apiBase).origin;
  } catch {
    origin = apiBase;
  }
  const safe = (s: string) => s.replace(/[^A-Za-z0-9.-]+/g, '_');
  return join(dir, CACHE_SCHEMA_VERSION, safe(origin), safe(company));
}

/**
 * Per-company JSON/text cache under `cacheRoot` (API origin, company, schema version).
 * Only immutable or slowly changing reference data lives here; never sessions.
 */
export class Cache {
  constructor(
    private readonly root: string,
    private readonly enabled = true,
  ) {}

  private file(key: string): string {
    const safe = key.replace(/[^A-Za-z0-9._-]+/g, '_');
    return join(this.root, safe);
  }

  async getText(key: string, ttlMs = Number.POSITIVE_INFINITY): Promise<string | undefined> {
    if (!this.enabled) return undefined;
    try {
      const raw = JSON.parse(await readFile(this.file(key), 'utf8')) as {
        at: number;
        value: string;
      };
      return Date.now() - raw.at <= ttlMs ? raw.value : undefined;
    } catch {
      return undefined;
    }
  }

  async getJson<T>(key: string, ttlMs?: number): Promise<T | undefined> {
    const text = await this.getText(key, ttlMs);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  }

  async setText(key: string, value: string): Promise<void> {
    if (!this.enabled) return;
    const path = this.file(key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ at: Date.now(), value }), { mode: 0o600 });
    await rename(temp, path);
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.setText(key, JSON.stringify(value));
  }
}

export const DAY = 86_400_000;
