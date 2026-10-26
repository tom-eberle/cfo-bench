/** Round to cents, avoiding binary floating point artefacts (0.1 + 0.2). */
export function cents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function sameCents(a: number, b: number, tolerance = 0.005): boolean {
  return Math.abs(a - b) <= tolerance;
}

export function formatAmount(value: number | null | undefined): string {
  return value == null ? '—' : value.toFixed(2);
}

/** Bank-statement style: expenses negative, income positive. */
export function formatSigned(amount: number, direction: 'expense' | 'income'): string {
  return `${direction === 'expense' ? '-' : '+'}${amount.toFixed(2)}`;
}

export function formatRate(rate: number | null | undefined): string {
  return rate == null ? '—' : `${rate}%`;
}

/** VAT included in a gross amount at a percentage rate. */
export function vatFromGross(gross: number, ratePercent: number): number {
  return cents(gross - gross / (1 + ratePercent / 100));
}

/** VAT rates in percent, as accepted on the command line and in plans. */
export const FRENCH_VAT_RATES = [0, 2.1, 5.5, 10, 20] as const;
