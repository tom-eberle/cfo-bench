/** Test helpers. Everything here is synthetic. */
import { join } from 'node:path';
import { FakeCompta } from '../src/compta.ts';
import { loadScenario } from '../src/scenario.ts';

export const MINI = join(import.meta.dirname, 'fixtures', 'mini');
/** The generated benchmark scenario (seed 1). */
export const ATELIER = join(import.meta.dirname, '..', '..', 'scenarios', 'atelier-lumen-s1');
export const COMPANY = '999999';
/** The mini scenario's `api_token`. */
export const TOKEN = 'synthetic-test-session-999999';
export const BASE = 'https://localhost:4443';

/**
 * Build a tiny, valid one-page PDF with the given lines of text.
 * Ported from the CLI's test/helpers/pdf.ts (MIT, see cli/LICENSE).
 */
export function makePdf(lines: string[]): Uint8Array {
  const escapeText = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = [
    'BT',
    '/F1 11 Tf',
    '14 TL',
    '50 780 Td',
    ...lines.map((l, i) => (i === 0 ? `(${escapeText(l)}) Tj` : `T* (${escapeText(l)}) Tj`)),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

/** The PDFs under fixtures/mini/files (regenerate them and MANIFEST.sha256 with: node server/test/helpers.ts). */
export const FIXTURE_PDFS: Record<string, string[]> = {
  'saas-2026-06.pdf': ['FICTIONAL SAAS INC', 'Invoice date 2026-06-11', 'Total TTC 120,00 EUR', 'TVA 20,00 EUR'],
  'cloud-2026-07.pdf': [
    'FICTIONAL CLOUD INC',
    'Invoice date 2026-07-04',
    'Total 120,00 EUR',
    'VAT 0,00 EUR',
    'Reverse charge',
  ],
};

export function fake(): FakeCompta {
  return new FakeCompta(loadScenario(MINI), { storageOrigin: 'https://127.0.0.1:4443' });
}

/**
 * A request to the fake, with `Authorization: Bearer <TOKEN>` unless `authorization` is given
 * (`null`: no header at all).
 */
export function request(
  method: string,
  path: string,
  init: { body?: BodyInit; json?: unknown; authorization?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers(init.headers);
  const authorization = init.authorization === undefined ? `Bearer ${TOKEN}` : init.authorization;
  if (authorization !== null) headers.set('authorization', authorization);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  return new Request(new URL(path, BASE), { method, headers, body });
}

if (process.argv[1] === import.meta.filename) {
  const { writeFileSync, mkdirSync, readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  mkdirSync(join(MINI, 'files'), { recursive: true });
  for (const [name, lines] of Object.entries(FIXTURE_PDFS))
    writeFileSync(join(MINI, 'files', name), makePdf(lines));
  // MANIFEST.sha256: every file of the fixture (the harness refuses a scenario that differs from it)
  const rels = ['scenario.json', ...Object.keys(FIXTURE_PDFS).map((n) => `files/${n}`)].sort();
  const sha = (rel: string) => createHash('sha256').update(readFileSync(join(MINI, rel))).digest('hex');
  writeFileSync(join(MINI, 'MANIFEST.sha256'), rels.map((rel) => `${sha(rel)}  ${rel}\n`).join(''));
}
