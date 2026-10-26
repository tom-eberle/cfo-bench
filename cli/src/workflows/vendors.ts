import { z } from 'zod';
import { normalizeText, parseRegexLiteral } from '../util/text.js';

export const vendorZoneSchema = z.enum(['outside-eu', 'inside-eu']);
export type VendorZone = z.infer<typeof vendorZoneSchema>;

export const vendorSchema = z.strictObject({
  name: z.string().min(1),
  match: z.string().min(1).describe('Substring of the bank wording (whole words), or /regex/flags'),
  zone: vendorZoneSchema.describe(
    'Where the supplier is established, which drives the VAT exemption',
  ),
});
export type Vendor = z.infer<typeof vendorSchema>;

/**
 * Foreign suppliers that invoice without French VAT (reverse charge). Compta
 * sometimes books them with 20 % deductible VAT; `vat check` flags those.
 * Extend or override in the rules file under "vendors".
 */
export const BUILTIN_VENDORS: readonly Vendor[] = [
  { name: 'Cloudflare', match: 'CLOUDFLARE', zone: 'outside-eu' },
  { name: 'Anthropic', match: 'ANTHROPIC', zone: 'outside-eu' },
  { name: 'OpenAI', match: 'OPENAI', zone: 'outside-eu' },
  { name: 'Convex', match: 'CONVEX', zone: 'outside-eu' },
  { name: 'Sentry', match: '/\\bSENTRY\\b|FUNCTIONAL SOFTWARE/', zone: 'outside-eu' },
  { name: 'PostHog', match: 'POSTHOG', zone: 'outside-eu' },
  { name: 'RevenueCat', match: 'REVENUECAT', zone: 'outside-eu' },
  { name: 'Resend', match: 'RESEND', zone: 'outside-eu' },
  { name: 'Expo', match: '/650 INDUSTRIES|\\bEXPO DEV\\b/', zone: 'outside-eu' },
  { name: 'OpenRouter', match: 'OPENROUTER', zone: 'outside-eu' },
  {
    name: 'TikTok Information Technologies UK',
    match: 'TIKTOK INFORMATION TECHNOLOGIES UK',
    zone: 'outside-eu',
  },
  { name: 'GitHub', match: 'GITHUB', zone: 'outside-eu' },
  { name: 'Vercel', match: 'VERCEL', zone: 'outside-eu' },
  { name: 'Cursor (Anysphere)', match: 'ANYSPHERE', zone: 'outside-eu' },
  { name: 'Figma', match: 'FIGMA', zone: 'outside-eu' },
  { name: 'Replicate', match: 'REPLICATE', zone: 'outside-eu' },
  { name: 'Midjourney', match: 'MIDJOURNEY', zone: 'outside-eu' },
  { name: 'Hetzner', match: 'HETZNER', zone: 'inside-eu' },
];

function compile(match: string): (normalizedWording: string) => boolean {
  const regex = parseRegexLiteral(match);
  if (regex) return (w) => regex.test(w);
  const needle = ` ${normalizeText(match)} `;
  return (w) => ` ${w} `.includes(needle);
}

export class VendorRegistry {
  private readonly entries: { vendor: Vendor; custom: boolean; test: (w: string) => boolean }[];

  /** Custom vendors take precedence over (and can override) built-in ones. */
  constructor(custom: readonly Vendor[] = [], builtin: readonly Vendor[] = BUILTIN_VENDORS) {
    const overridden = new Set(custom.map((v) => v.name.toLowerCase()));
    this.entries = [
      ...custom.map((vendor) => ({ vendor, custom: true })),
      ...builtin
        .filter((v) => !overridden.has(v.name.toLowerCase()))
        .map((vendor) => ({ vendor, custom: false })),
    ].map((e) => ({ ...e, test: compile(e.vendor.match) }));
  }

  find(wording: string): Vendor | null {
    return this.match(wording)?.vendor ?? null;
  }

  /** The matching vendor and whether it came from the user's rules file (stronger evidence). */
  match(wording: string): { vendor: Vendor; custom: boolean } | null {
    const normalized = normalizeText(wording);
    const entry = this.entries.find((e) => e.test(normalized));
    return entry ? { vendor: entry.vendor, custom: entry.custom } : null;
  }

  get all(): Vendor[] {
    return this.entries.map((e) => e.vendor);
  }
}
