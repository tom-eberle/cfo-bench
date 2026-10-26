import { style, styledTokens, visibleLength } from './style.js';

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  align?: 'left' | 'right';
  /** Columns marked flexible shrink first when the terminal is too narrow. */
  flex?: boolean;
  max?: number;
}

/** C0, DEL and C1 controls: a cell is one line, and untrusted text must not drive the terminal. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

function clean(text: string): string {
  return text.replace(CONTROL, ' ');
}

/** Cut to `width` visible characters, keeping style tokens so colours stay balanced. */
function truncate(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  if (width < 1) return '';
  let budget = width - 1;
  const kept: string[] = [];
  let ellipsisAt = 0;
  for (const { token, visible } of styledTokens(text)) {
    if (!visible) kept.push(token);
    else if (budget > 0) {
      kept.push(token);
      budget--;
      ellipsisAt = kept.length;
    }
  }
  kept.splice(ellipsisAt, 0, '…');
  return kept.join('');
}

function pad(text: string, width: number, align: 'left' | 'right'): string {
  const gap = ' '.repeat(Math.max(0, width - visibleLength(text)));
  return align === 'right' ? gap + text : text + gap;
}

/** Render rows as an aligned, borderless table (gh-style). */
export function renderTable<T>(
  columns: Column<T>[],
  rows: readonly T[],
  terminalWidth = process.stdout.columns || 120,
): string {
  const cells = rows.map((row) => columns.map((c) => clean(c.value(row))));
  const widths = columns.map((c, i) =>
    Math.min(
      c.max ?? Number.POSITIVE_INFINITY,
      Math.max(c.header.length, ...cells.map((r) => visibleLength(r[i] ?? ''))),
    ),
  );
  const gutter = 2 * (columns.length - 1);
  let overflow = widths.reduce((a, b) => a + b, 0) + gutter - terminalWidth;
  // Shrink the widest flexible column one character at a time, so several
  // flexible columns end up balanced rather than one collapsing entirely.
  const MIN_FLEX = 12;
  while (overflow > 0) {
    let widest = -1;
    columns.forEach((c, i) => {
      if (
        c.flex &&
        (widths[i] ?? 0) > MIN_FLEX &&
        (widest < 0 || (widths[i] ?? 0) > (widths[widest] ?? 0))
      )
        widest = i;
    });
    if (widest < 0) break;
    widths[widest] = (widths[widest] ?? 0) - 1;
    overflow--;
  }
  const line = (values: string[]) =>
    values
      .map((v, i) => pad(truncate(v, widths[i] ?? 0), widths[i] ?? 0, columns[i]?.align ?? 'left'))
      .join('  ')
      .trimEnd();
  return [style.bold(line(columns.map((c) => c.header))), ...cells.map(line)].join('\n');
}

/** Two-column "key  value" block for single objects. */
export function renderKeyValues(entries: [string, string][]): string {
  const width = Math.max(0, ...entries.map(([k]) => k.length));
  return entries
    .map(([k, v]) => `${style.dim(k.padEnd(width))}  ${v.replace(CONTROL_EXCEPT_NEWLINE, ' ')}`)
    .join('\n');
}
