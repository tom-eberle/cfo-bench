import { describe, expect, it } from 'vitest';
import {
  analyzeDocumentText,
  analyzeFilename,
  detectAmounts,
  detectDates,
  detectVatNumbers,
  extractPdfText,
  parseAmount,
} from '../src/pdf/extract.js';
import { makePdf } from './helpers/pdf.js';

describe('parseAmount', () => {
  it.each([
    ['48.00', 48],
    ['48,00', 48],
    ['1 234,56', 1234.56],
    ['1,234.56', 1234.56],
    ['1.234,56', 1234.56],
    ['1 234,56', 1234.56],
    ['12', 12],
  ])('%s → %d', (raw, value) => expect(parseAmount(raw)).toBe(value));
});

describe('detectAmounts', () => {
  it('ranks totals (FR and EN labels) and finds VAT lines', () => {
    const text = [
      'Sous-total HT 40,00 €',
      'TVA (20 %) 8,00 €',
      'Total TTC 48,00 €',
      'Amount due: $59.99 USD',
    ].join('\n');
    const facts = detectAmounts(text);
    expect(facts.totals).toEqual(expect.arrayContaining([48, 59.99]));
    expect(facts.totals).not.toContain(40);
    expect(facts.vatAmounts).toContain(8);
    expect(facts.amounts).toEqual(expect.arrayContaining([40, 8, 48, 59.99]));
  });

  it('ignores percentages so "TVA 20%" is not read as an amount', () => {
    expect(detectAmounts('TVA 20% 0,00 €').vatAmounts).toEqual([0]);
  });
});

describe('detectDates', () => {
  it('reads ISO, French, English and ambiguous numeric dates', () => {
    expect(detectDates('Date: 2026-08-01')).toEqual(['2026-08-01']);
    expect(detectDates('Émise le 3 août 2026')).toEqual(['2026-08-03']);
    expect(detectDates('le 1er juillet 2026')).toEqual(['2026-07-01']);
    expect(detectDates('Invoice date Aug 4, 2026')).toEqual(['2026-08-04']);
    expect(detectDates('Paid 12 Mar 2026')).toEqual(['2026-03-12']);
    expect(detectDates('05/08/2026')).toEqual(['2026-08-05', '2026-05-08']);
    expect(detectDates('31/08/2026')).toEqual(['2026-08-31']);
    expect(detectDates('99/99/2026')).toEqual([]);
  });
});

describe('detectVatNumbers and reverse charge', () => {
  it('finds EU, UK and OSS identifiers', () => {
    const numbers = detectVatNumbers(
      'Seller VAT: DE123456789 · Customer: FR12345678901 · GB123456789 · EU372000000',
    );
    expect(numbers.map((n) => n.country)).toEqual(['DE', 'FR', 'GB', 'EU']);
  });

  it('flags reverse-charge wording in English and French', () => {
    expect(analyzeDocumentText('VAT reverse charge applies').reverseCharge).toBe(true);
    expect(analyzeDocumentText('Autoliquidation - article 283-2 du CGI').reverseCharge).toBe(true);
    expect(analyzeDocumentText('TVA 20 % 8,00 €').reverseCharge).toBe(false);
  });

  it('detects the dominant currency', () => {
    expect(analyzeDocumentText('Total $20.00 USD, tax $0.00').currency).toBe('USD');
    expect(analyzeDocumentText('Total 20,00 €').currency).toBe('EUR');
  });
});

describe('file names', () => {
  it('extracts amounts and dates from names like 2026-08-01_vendor_48.00.pdf', () => {
    expect(analyzeFilename('2026-08-01_nimbus_48.00.pdf')).toEqual({
      amounts: [48],
      dates: ['2026-08-01'],
    });
  });
});

describe('extractPdfText', () => {
  it('extracts text from a real PDF', async () => {
    const text = await extractPdfText(makePdf(['Synthetic Supplier Ltd', 'Total TTC 48,00 EUR']));
    expect(text).toContain('Synthetic Supplier Ltd');
    expect(analyzeDocumentText(text).totals).toContain(48);
  });
});
