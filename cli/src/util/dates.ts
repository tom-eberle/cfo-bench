import { usageError } from '../output/errors.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_MS = 86_400_000;

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

export function parseDateOption(value: string, flag: string): string {
  if (!isIsoDate(value))
    throw usageError(`${flag} must be a date in YYYY-MM-DD format, got "${value}"`);
  return value;
}

export function parseMonthOption(value: string): { from: string; to: string } {
  if (!MONTH.test(value)) throw usageError(`--month must be YYYY-MM, got "${value}"`);
  const [y, m] = value.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${value}-01`, to: `${value}-${String(last).padStart(2, '0')}` };
}

export interface DateRange {
  from?: string;
  to?: string;
}

export function checkRange(range: DateRange): DateRange {
  if (range.from && range.to && range.from > range.to)
    throw usageError(`--from (${range.from}) is after --to (${range.to})`);
  return range;
}

export function inRange(date: string, range: DateRange): boolean {
  return (!range.from || date >= range.from) && (!range.to || date <= range.to);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Signed whole days from a to b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 2, 1));
  return d.toISOString().slice(0, 7);
}
