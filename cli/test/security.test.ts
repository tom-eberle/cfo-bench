import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeOperation } from '../src/api/normalize.js';
import { rawTransactionSchema } from '../src/api/schemas.js';
import { exportRow, neutralizeFormula, toCsv } from '../src/commands/resources.js';
import { ComptaError } from '../src/output/errors.js';
import { Output } from '../src/output/format.js';
import { sanitizeForTerminal, setColorEnabled, style } from '../src/output/style.js';
import { renderKeyValues, renderTable } from '../src/output/table.js';
import { resolveUpload } from '../src/plan/attachments.js';
import { FakeCompta } from './helpers/fake-api.js';
import { COMPANY, rawCategoryMap, rawOp } from './helpers/fixtures.js';
import { runCli, tempHome } from './helpers/run.js';

const ESC = '\u001b';
const HOSTILE = `Evil${ESC}]0;pwned${ESC}\\${ESC}[2J\u009b31mShop\u0007`;

describe('attach steps cannot upload arbitrary local files', () => {
  function layout() {
    const root = tempHome();
    const planDir = join(root, 'plans');
    const outside = join(root, 'elsewhere');
    mkdirSync(planDir);
    mkdirSync(outside);
    writeFileSync(join(planDir, 'invoice.pdf'), '%PDF-1.4 synthetic');
    writeFileSync(join(planDir, 'secrets.env'), 'TOKEN=synthetic');
    writeFileSync(join(outside, 'other.pdf'), '%PDF-1.4 synthetic');
    return { root, planDir, outside };
  }

  it('only allows receipt file types', () => {
    const { planDir } = layout();
    const policy = { baseDir: planDir, cwd: planDir };
    expect(resolveUpload('./invoice.pdf', policy)).toMatch(/plans\/invoice\.pdf$/);
    expect(() => resolveUpload('./secrets.env', policy)).toThrow(
      expect.objectContaining({ code: 'UNSAFE_ATTACHMENT', exitCode: 2 }),
    );
  });

  it('refuses files outside the plan directory and cwd, unless allowed', () => {
    const { planDir, outside } = layout();
    const policy = { baseDir: planDir, cwd: planDir };
    for (const file of [join(outside, 'other.pdf'), '../elsewhere/other.pdf'])
      expect(() => resolveUpload(file, policy)).toThrow(
        expect.objectContaining({
          code: 'UNSAFE_ATTACHMENT',
          hint: expect.stringContaining('--allow-any-path'),
        }),
      );
    expect(resolveUpload('../elsewhere/other.pdf', { ...policy, allowAnyPath: true })).toMatch(
      /elsewhere\/other\.pdf$/,
    );
  });

  it('resolves symlinks before checking (no escaping through a link)', () => {
    const { planDir, outside } = layout();
    symlinkSync(join(outside, 'other.pdf'), join(planDir, 'innocent.pdf'));
    expect(() => resolveUpload('./innocent.pdf', { baseDir: planDir, cwd: planDir })).toThrow(
      ComptaError,
    );
  });

  it('apply refuses the whole plan before any write, and shows resolved paths', async () => {
    const { planDir, outside } = layout();
    const api = new FakeCompta([rawOp({ id: 51 }), rawOp({ id: 52 })]);
    const plan = (steps: unknown[]) => {
      const path = join(planDir, `p${Math.random()}.plan.json`);
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          company: COMPANY,
          createdAt: 'x',
          createdBy: 'untrusted agent',
          steps,
        }),
      );
      return path;
    };
    const bad = plan([
      { id: 's1', op: '51', action: 'attach', file: './invoice.pdf', why: 'fine' },
      { id: 's2', op: '52', action: 'attach', file: join(outside, 'other.pdf'), why: 'sneaky' },
    ]);
    const refused = await runCli(api, ['apply', bad, '--yes']);
    expect(refused.code).toBe(2);
    expect(refused.error()).toMatchObject({
      code: 'UNSAFE_ATTACHMENT',
      message: expect.stringContaining('s2'),
    });
    expect(api.writes).toHaveLength(0);

    const good = plan([
      { id: 's1', op: '51', action: 'attach', file: './invoice.pdf', why: 'fine' },
    ]);
    const preview = await runCli(api, ['apply', good, '--dry-run']);
    expect(preview.json()).toMatchObject({
      results: [{ status: 'planned', file: expect.stringMatching(/^\/.*plans\/invoice\.pdf$/) }],
    });

    const questions: string[] = [];
    await runCli(api, ['apply', good], {
      stdoutIsTTY: true,
      stdinIsTTY: true,
      answer: 'n',
      questions,
    });
    expect(questions[0]).toMatch(
      /These local files will be uploaded to Compta:\n {2}\/.*plans\/invoice\.pdf\nApply 1 change/,
    );
    expect(api.writes).toHaveLength(0);
  });

  it('ops attach rejects disallowed files before contacting Compta', async () => {
    const { planDir } = layout();
    const api = new FakeCompta([rawOp({ id: 53 })]);
    const r = await runCli(api, ['ops', 'attach', '53', join(planDir, 'secrets.env'), '--yes']);
    expect(r.code).toBe(2);
    expect(r.error().code).toBe('UNSAFE_ATTACHMENT');
    expect(api.requests).toHaveLength(0);
  });
});

describe('CSV export neutralizes spreadsheet formulas', () => {
  it('prefixes risky text cells with a quote and leaves numbers alone', () => {
    for (const risky of ['=HYPERLINK("http://x")', '+33 1 23', '-2+3', '@SUM(A1)', '\tx', '\rx'])
      expect(neutralizeFormula(risky)).toBe(`'${risky}`);
    expect(neutralizeFormula('CB SHOP')).toBe('CB SHOP');

    const raw = rawOp({ id: 61, wording: '=cmd|"/c calc"!A1', memo: '@evil', amount: 12.5 });
    const row = exportRow(
      normalizeOperation(rawTransactionSchema.parse(raw), {
        company: COMPANY,
        apiBase: 'https://compta.example.test',
        categories: rawCategoryMap(),
      }),
    );
    const csv = toCsv([row]);
    const line = csv.trim().split('\n')[1]!;
    expect(line).toContain(`"'=cmd|""/c calc""!A1"`);
    expect(line).toContain(`'@evil`);
    expect(line.startsWith('2026-08-15,')).toBe(true);
    expect(line).toContain(',12.5,');
  });

  it('applies to the CLI export, not to JSON output', async () => {
    const api = new FakeCompta([rawOp({ id: 62, wording: '-1+1 FICTIONAL' })]);
    const csv = await runCli(api, ['export']);
    expect(csv.stdout).toContain(",'-1+1 FICTIONAL,");
    const json = await runCli(api, ['export', '--format', 'json']);
    expect((json.json() as { wording: string }[])[0]!.wording).toBe('-1+1 FICTIONAL');
  });
});

describe('terminal output strips control characters from data', () => {
  it('removes ESC, BEL and C1 controls from table cells and key/values', () => {
    const table = renderTable(
      [{ header: 'WORDING', value: (r: { w: string }) => r.w }],
      [{ w: HOSTILE }],
    );
    const out = sanitizeForTerminal(table);
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(out).toContain('Evil');
    expect(sanitizeForTerminal(renderKeyValues([['memo', HOSTILE]]))).not.toContain(ESC);
  });

  it('keeps our own colours while dropping injected escapes', () => {
    setColorEnabled(true);
    try {
      const out = sanitizeForTerminal(`${style.red('error')} ${HOSTILE}`);
      expect(out.startsWith(`${ESC}[31merror${ESC}[39m`)).toBe(true);
      expect(out.match(/\u001b/g)).toHaveLength(2);
    } finally {
      setColorEnabled(false);
    }
  });

  it('sanitizes human errors but leaves JSON untouched', () => {
    let human = '';
    new Output(
      { stdoutIsTTY: true },
      { write: () => 0 },
      { write: (s: string) => (human += s) },
    ).error(new ComptaError('X', `bad ${HOSTILE}`));
    expect(human).not.toContain(ESC);
    let json = '';
    new Output(
      { stdoutIsTTY: false },
      { write: () => 0 },
      { write: (s: string) => (json += s) },
    ).error(new ComptaError('X', `bad ${HOSTILE}`));
    expect(JSON.parse(json).error.message).toBe(`bad ${HOSTILE}`);
  });

  it('end to end: a hostile bank wording cannot reach the terminal', async () => {
    const api = new FakeCompta([rawOp({ id: 71, wording: HOSTILE })]);
    const r = await runCli(api, ['ops', 'list'], { stdoutIsTTY: true });
    expect(r.stdout).toContain('Evil');
    expect(r.stdout).not.toMatch(/\u001b\][^m]*|\u0007|\u009b|\u001b\[2J/);
    const json = await runCli(api, ['ops', 'list', '--json']);
    expect((json.json() as { wording: string }[])[0]!.wording).toBe(HOSTILE);
  });
});
