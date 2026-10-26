/** Uppercase, strip accents and punctuation, collapse whitespace. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/** Bank wording noise: payment rails, card markers, generic invoice words. */
const NOISE = new Set(
  `CB CARTE CARD PAIEMENT PAYMENT PAYMENTS PRLV SEPA VIR VIREMENT SCT INST FACTURE FACT INVOICE
   ACHAT DEBIT CREDIT EUR USD GBP REF REFERENCE DU AU LE LA LES DE DES ET THE TO FROM FOR
   WWW COM HTTPS HTTP INC LTD LLC SAS SARL SA GMBH BV PBC CORP CO SUBSCRIPTION ABONNEMENT
   MONTHLY RECURRING TRANSACTION PURCHASE PAY BILL BILLING`
    .split(/\s+/)
    .filter(Boolean),
);
/** Meaningful merchant tokens from a bank wording ("CB CLOUDFLARE 12/08" → ["CLOUDFLARE"]). */
export function merchantTokens(wording: string): string[] {
  return normalizeText(wording)
    .split(' ')
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !/\d{3,}/.test(t))
    .filter((t) => !NOISE.has(t));
}

/** A stable merchant key used to group operations ("CLOUDFLARE", "HETZNER ONLINE"). */
export function merchantKey(wording: string): string {
  return merchantTokens(wording).slice(0, 2).join(' ');
}

/** Case- and accent-insensitive substring test. */
export function includesLoose(haystack: string, needle: string): boolean {
  return normalizeText(haystack).includes(normalizeText(needle));
}

/** Compile `/pattern/flags` strings to RegExp, otherwise null. */
export function parseRegexLiteral(value: string): RegExp | null {
  const m = /^\/(.+)\/([dgimsuvy]*)$/.exec(value);
  if (!m) return null;
  return new RegExp(m[1]!, m[2]!.replace('g', ''));
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
