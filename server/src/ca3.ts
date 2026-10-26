/**
 * Monthly CA3 (3310-CA3) boxes from booked transactions (API.md §6.6). The formulas are the
 * benchmark's model of French rules. The server uses them to keep the boxes of open returns in
 * step with the transactions; filed returns are never recomputed.
 *
 * Rounding: amounts are summed in integer cents. Self-assessed reverse-charge VAT (20 %) is
 * rounded to the cent, half away from zero. Each box is then rounded to whole euros, half
 * towards +infinity.
 */
import type { Category, Transaction } from './scenario.ts';

const REVERSE_CHARGE: Record<string, 'eu' | 'non_eu'> = {
  purchase_eu: 'eu',
  purchase_non_eu: 'non_eu',
};

/** Sale VAT rates the CA3 has a line for (fraction → line key). */
const RATE_LINES = new Map<number, '20' | '10' | '55'>([
  [0.2, '20'],
  [0.1, '10'],
  [0.055, '55'],
]);

/** A JSON amount with at most two decimals → integer cents (exact for such values). */
function toCents(x: number): number {
  return Math.round(x * 100);
}

/** cents × 20 % → cents, rounded half away from zero. */
function selfAssessed(c: number): number {
  const sign = c < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(c) * 20 + 50) / 100);
}

/** Whole euros from cents, half towards +infinity (like Math.round). */
function euros(c: number): number {
  return Math.floor((c + 50) / 100);
}

export interface Ca3Amounts {
  base20: number;
  vat20: number;
  base10: number;
  vat10: number;
  base55: number;
  vat55: number;
  e2: number;
  rc_eu: number;
  rc_non_eu: number;
  ded_assets: number;
  ded_other: number;
  self_eu: number;
  self_non_eu: number;
}

/** Exact bases and taxes, in cents, before whole-euro rounding. */
export function ca3Amounts(transactions: readonly Transaction[], categories: readonly Category[]): Ca3Amounts {
  const accounts = new Map(
    categories.map((c) => [c.id, c.ledger_account != null ? String(c.ledger_account) : '']),
  );
  const a: Ca3Amounts = {
    base20: 0, vat20: 0, base10: 0, vat10: 0, base55: 0, vat55: 0, e2: 0,
    rc_eu: 0, rc_non_eu: 0, ded_assets: 0, ded_other: 0, self_eu: 0, self_non_eu: 0,
  };
  for (const tx of transactions) {
    if ((tx.status ?? 'active') !== 'active') continue;
    for (const line of tx.lines) {
      if (line.category_id == null) continue;
      const account = accounts.get(line.category_id) ?? '';
      const inbound = (line.direction ?? tx.direction) === 'in';
      const refund = !!line.refund;
      const sale = refund ? !inbound : inbound;
      const sign = refund ? -1 : 1;
      const amount = toCents(line.amount);
      const vat = toCents(line.tax.amount);
      if (sale) {
        if (vat > 0 && line.tax.rate) {
          // A sale rate without a CA3 line (not 20 / 10 / 5.5 %) is left out.
          const key = RATE_LINES.get(line.tax.rate);
          if (key) {
            a[`base${key}`] += sign * (amount - vat);
            a[`vat${key}`] += sign * vat;
          }
        } else if (account.startsWith('70')) a.e2 += sign * amount;
        continue;
      }
      const zone = REVERSE_CHARGE[line.tax.exemption_reason ?? ''];
      if (zone) {
        a[zone === 'eu' ? 'rc_eu' : 'rc_non_eu'] += sign * amount;
        continue;
      }
      const deductible = toCents(line.tax.deductible);
      if (deductible > 0) a[account.startsWith('2') ? 'ded_assets' : 'ded_other'] += sign * deductible;
    }
  }
  a.self_eu = selfAssessed(a.rc_eu);
  a.self_non_eu = selfAssessed(a.rc_non_eu);
  return a;
}

/** The CA3 boxes (API keys → whole euros) for one month's transactions. */
export function ca3Boxes(
  transactions: readonly Transaction[],
  categories: readonly Category[],
  prevCredit: number | null,
): Record<string, number> {
  const a = ca3Amounts(transactions, categories);
  const rc = a.rc_eu + a.rc_non_eu;
  const selfTotal = a.self_eu + a.self_non_eu;
  const b: Record<string, number> = {
    A1: euros(a.base20 + a.base10 + a.base55),
    A3: euros(rc),
    A3_eu: euros(a.rc_eu),
    A3_non_eu: euros(a.rc_non_eu),
    E2: euros(a.e2),
    '08': euros(a.base20 + rc),
    '08_tax': euros(a.vat20 + selfTotal),
    '9B': euros(a.base10),
    '9B_tax': euros(a.vat10),
    '09': euros(a.base55),
    '09_tax': euros(a.vat55),
    '19': euros(a.ded_assets),
    '20_domestic': euros(a.ded_other),
    '20_eu_reverse_charge': euros(a.self_eu),
    '20_non_eu_reverse_charge': euros(a.self_non_eu),
    '22': prevCredit || 0,
    '26': 0,
  };
  b['16'] = b['08_tax']! + b['9B_tax']! + b['09_tax']!;
  b['20'] = b['20_domestic']! + b['20_eu_reverse_charge']! + b['20_non_eu_reverse_charge']!;
  b['23'] = b['19']! + b['20'] + b['22']!;
  b['25'] = Math.max(0, b['23'] - b['16']);
  b['28'] = Math.max(0, b['16'] - b['23']);
  b['27'] = b['25'] - b['26']!;
  b['32'] = b['28'];
  return b;
}
