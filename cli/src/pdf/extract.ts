/**
 * Text extraction and invoice-field heuristics for receipts matching and VAT
 * checks. Heuristics are deliberately permissive: they return every plausible
 * candidate and let the caller score them against an operation.
 */

export interface DocumentFacts {
  /** Amounts found near "total"/"amount due"/"montant" labels, most likely first. */
  totals: number[];
  /** Every money-looking amount in the text. */
  amounts: number[];
  /** Candidate VAT amounts (lines mentioning VAT/TVA/tax). */
  vatAmounts: number[];
  /** ISO dates; ambiguous dd/mm vs mm/dd strings yield both readings. */
  dates: string[];
  vatNumbers: { country: string; number: string }[];
  reverseCharge: boolean;
  currency: string | null;
}

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n') : text;
  } finally {
    await pdf.cleanup().catch(() => undefined);
  }
}

const NUMBER = String.raw`\d{1,3}(?:[   .,']\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2}`;
const CURRENCY = String.raw`(?:€|EUR|\$|USD|£|GBP|CHF)`;

/** Parse "1 234,56", "1,234.56", "1.234,56" or "48.00" to a number. */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/[\s  ']/g, '');
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  if (comma > -1 && dot > -1)
    s = comma > dot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (comma > -1)
    s = /,\d{2}$/.test(s) ? s.replace(/,(?=\d{3}\b)/g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (/\.\d{3}\./.test(s) || /^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const TOTAL_LABEL =
  /((?<!sous[\s-]?|sub[\s-]?)total\s*(?:ttc|toutes\s*taxes|due|amount|à\s*payer|a\s*payer|paid|incl\.?\s*(?:vat|tax))?|amount\s*(?:due|paid|charged)|montant\s*(?:ttc|total|dû|du|à\s*payer|a\s*payer)?|net\s*à\s*payer|grand\s*total|balance\s*due|you\s*paid)/i;
const VAT_LABEL = /\b(tva|vat|tax|mwst|ust|iva)\b/i;

function amountsIn(line: string): number[] {
  const out: number[] = [];
  for (const m of line.matchAll(new RegExp(NUMBER, 'g'))) {
    const v = parseAmount(m[0]);
    if (v !== null && v > 0) out.push(v);
  }
  return out;
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function detectAmounts(
  text: string,
): Pick<DocumentFacts, 'totals' | 'amounts' | 'vatAmounts'> {
  const lines = text.split(/\r?\n/);
  const totals: number[] = [];
  const vat: number[] = [];
  for (const line of lines) {
    const values = amountsIn(line.replace(/\d{1,2}(?:[.,]\d{1,2})?\s?%/g, ' '));
    if (!values.length) continue;
    if (TOTAL_LABEL.test(line) && !/sub\s*-?total|sous[\s-]total/i.test(line))
      totals.push(...values.slice(-1), ...values);
    if (VAT_LABEL.test(line) && !TOTAL_LABEL.test(line)) vat.push(values.at(-1) as number);
  }
  // Labels and values often land on separate lines in extracted text; also scan "label ... value" spans.
  const flat = text.replace(/\s+/g, ' ');
  const labelled = new RegExp(
    `${TOTAL_LABEL.source}[^0-9]{0,40}?${CURRENCY}?\\s?(${NUMBER})`,
    'gi',
  );
  for (const m of flat.matchAll(labelled)) {
    const v = parseAmount(m.at(-1) ?? '');
    if (v !== null && v > 0) totals.push(v);
  }
  const vatSpan = new RegExp(
    String.raw`\b(?:tva|vat|tax)\b[^0-9]{0,30}?(?:\(?\d{1,2}(?:[.,]\d{1,2})?\s?%\)?)?[^0-9]{0,15}?${CURRENCY}?\s?(${NUMBER})`,
    'gi',
  );
  for (const m of flat.matchAll(vatSpan)) {
    const v = parseAmount(m.at(-1) ?? '');
    if (v !== null) vat.push(v);
  }
  const money = new RegExp(`(?:${CURRENCY}\\s?(${NUMBER}))|(?:(${NUMBER})\\s?${CURRENCY})`, 'gi');
  const amounts: number[] = [];
  for (const m of flat.matchAll(money)) {
    const v = parseAmount(m[1] ?? m[2] ?? '');
    if (v !== null && v > 0) amounts.push(v);
  }
  return { totals: uniq(totals), amounts: uniq([...totals, ...amounts]), vatAmounts: uniq(vat) };
}

const MONTHS: Record<string, number> = {
  jan: 1,
  janv: 1,
  feb: 2,
  fev: 2,
  fevr: 2,
  mar: 3,
  mars: 3,
  apr: 4,
  avr: 4,
  avri: 4,
  may: 5,
  mai: 5,
  jun: 6,
  juin: 6,
  jul: 7,
  juil: 7,
  aug: 8,
  aou: 8,
  aout: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function monthNumber(word: string): number | undefined {
  const w = word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\.$/, '');
  return MONTHS[w.slice(0, 4)] ?? MONTHS[w.slice(0, 3)];
}

function iso(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return date.toISOString().slice(0, 10);
}

export function detectDates(text: string): string[] {
  const out: string[] = [];
  const push = (v: string | null) => {
    if (v) out.push(v);
  };
  for (const m of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g))
    push(iso(+m[1]!, +m[2]!, +m[3]!));
  for (const m of text.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/g)) {
    const a = +m[1]!;
    const b = +m[2]!;
    const y = +m[3]!;
    push(iso(y, b, a)); // European dd/mm first
    if (a !== b) push(iso(y, a, b));
  }
  for (const m of text.matchAll(/\b(\d{1,2})(?:er)?\s+([A-Za-zÀ-ÿ]{3,9})\.?,?\s+(\d{4})\b/g)) {
    const month = monthNumber(m[2]!);
    if (month) push(iso(+m[3]!, month, +m[1]!));
  }
  for (const m of text.matchAll(
    /\b([A-Za-zÀ-ÿ]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g,
  )) {
    const month = monthNumber(m[1]!);
    if (month) push(iso(+m[3]!, month, +m[2]!));
  }
  return uniq(out);
}

const EU_COUNTRIES = new Set(
  'AT BE BG CY CZ DE DK EE EL ES FI FR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK XI'.split(' '),
);

/** VAT identifiers; "EU" prefixes are non-EU businesses registered under the OSS/VoES scheme. */
export function detectVatNumbers(text: string): { country: string; number: string }[] {
  const found = new Map<string, { country: string; number: string }>();
  const re =
    /\b(AT|BE|BG|CY|CZ|DE|DK|EE|EL|ES|FI|FR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK|XI|GB|CH|NO|EU)[ ]?((?:U)?[0-9A-Z]{2}[0-9]{5,10}[0-9A-Z]{0,3}(?:B\d{2})?)\b/g;
  for (const m of text.matchAll(re)) {
    const digits = (m[2]!.match(/\d/g) ?? []).length;
    if (digits < 7) continue;
    const number = `${m[1]}${m[2]}`;
    found.set(number, { country: m[1]!, number });
  }
  return [...found.values()];
}

export function isEuCountry(code: string): boolean {
  return EU_COUNTRIES.has(code.toUpperCase());
}

const REVERSE_CHARGE =
  /reverse[\s-]?charge|autoliquidation|auto-liquidation|autoliquidaci[oó]n|steuerschuldnerschaft|article\s*196|art\.?\s*196|283[\s-]?2\s*(?:du\s*)?cgi|vat\s*to\s*be\s*accounted\s*for\s*by\s*the\s*recipient/i;

function detectCurrency(text: string): string | null {
  const counts: [string, number][] = [
    ['EUR', (text.match(/€|\bEUR\b/g) ?? []).length],
    ['USD', (text.match(/\$|\bUSD\b/g) ?? []).length],
    ['GBP', (text.match(/£|\bGBP\b/g) ?? []).length],
    ['CHF', (text.match(/\bCHF\b/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0] && counts[0][1] > 0 ? counts[0][0] : null;
}

export function analyzeDocumentText(text: string): DocumentFacts {
  return {
    ...detectAmounts(text),
    dates: detectDates(text),
    vatNumbers: detectVatNumbers(text),
    reverseCharge: REVERSE_CHARGE.test(text),
    currency: detectCurrency(text),
  };
}

/** Amounts and dates embedded in file names, e.g. "2026-08-01_hetzner_48.00.pdf". */
export function analyzeFilename(name: string): Pick<DocumentFacts, 'amounts' | 'dates'> {
  const base = name.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
  const amounts = [...base.matchAll(/(?<![\d-])(\d+[.,]\d{2})(?![\d-])/g)]
    .map((m) => parseAmount(m[1]!))
    .filter((v): v is number => v !== null && v > 0);
  return { amounts, dates: detectDates(base) };
}
