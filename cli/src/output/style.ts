import { randomBytes } from 'node:crypto';

/**
 * Minimal ANSI styling that is safe with untrusted text.
 *
 * Bank wordings, memos and file names come from outside, so human output is
 * sanitized before it reaches a terminal: every C0/C1 control character
 * (notably ESC) is removed. Our own styling must survive that, so `style`
 * emits a per-process random marker instead of ESC; `sanitizeForTerminal`
 * strips control characters first and only then turns markers into ESC.
 * Data cannot forge the marker without knowing it.
 */
const MARK = `${randomBytes(8).toString('hex')}`;
const STYLE_TOKEN = new RegExp(`${MARK}\\[[0-9;]*m`, 'g');
/** C0 controls except \t and \n, DEL, and C1 controls. */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

let enabled = false;

export function setColorEnabled(value: boolean): void {
  enabled = value;
}

const wrap =
  (open: number, close: number) =>
  (text: string): string =>
    enabled ? `${MARK}[${open}m${text}${MARK}[${close}m` : text;

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
};

/** Remove control characters from untrusted text, then render our own styles. */
export function sanitizeForTerminal(text: string): string {
  return text.replace(UNSAFE, '').split(MARK).join('\u001b');
}

/** Split styled text into zero-width style tokens and visible characters. */
export function styledTokens(text: string): { token: string; visible: boolean }[] {
  const out: { token: string; visible: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(STYLE_TOKEN)) {
    for (const ch of text.slice(last, m.index)) out.push({ token: ch, visible: true });
    out.push({ token: m[0], visible: false });
    last = (m.index ?? 0) + m[0].length;
  }
  for (const ch of text.slice(last)) out.push({ token: ch, visible: true });
  return out;
}

export function visibleLength(text: string): number {
  return [...text.replace(STYLE_TOKEN, '')].length;
}
