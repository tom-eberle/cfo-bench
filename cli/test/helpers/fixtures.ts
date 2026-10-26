/**
 * Synthetic fixtures in the shape of the Compta API (server/API.md §5). Everything
 * here is invented: company 999999, fictional merchants, made-up ids and amounts.
 */

export const COMPANY = '999999';

export interface RawTaxFixture {
  treatment: 'taxable' | 'exempt' | 'out_of_scope';
  rate: number | null;
  amount: number;
  deductible: number;
  exemption_reason: string | null;
  overridden: boolean;
}

export interface RawLineFixture {
  id: number;
  amount: number;
  direction?: 'in' | 'out';
  refund?: boolean;
  category_id: number | null;
  tax: RawTaxFixture;
}

export interface RawAttachmentFixture {
  id: number;
  removable?: boolean;
  document: {
    id: number;
    kind: string;
    purchase_invoice_id: string | null;
    amount?: number | null;
    date?: string | null;
    file: { id: number; name: string; mime_type: string; download_url: string } | null;
  };
}

export interface RawOpFixture {
  id: number;
  company_id: number;
  source: string;
  date: string;
  label: string;
  note: string | null;
  amount: number;
  direction: 'in' | 'out';
  validated: boolean;
  status: 'active' | 'excluded' | 'deleted';
  lock: { manual: boolean; period: boolean };
  issues: unknown[];
  bank: {
    account_id: number;
    amount: number;
    currency: string;
    original_amount: number | null;
    original_currency: string | null;
  } | null;
  lines: RawLineFixture[];
  attachments: RawAttachmentFixture[];
}

export const CATEGORIES = {
  software: {
    id: 77,
    name: 'Logiciels et abonnements',
    group: 'Frais de fonctionnement',
    rate: 0.2,
  },
  ads: { id: 69, name: 'Publicité', group: 'Frais de fonctionnement', rate: 0.2 },
  bankFees: { id: 12, name: 'Frais bancaires', group: 'Banque', rate: null },
  sales: { id: 301, name: 'Prestations de services', group: 'Ventes', rate: 0.2 },
  equipment: { id: 205, name: 'Matériel informatique', group: 'Immobilisations', rate: 0.2 },
  /** Partially deductible VAT (like fuel for a passenger car). */
  fuel: { id: 610, name: 'Carburant', group: 'Véhicules', rate: 0.2, deductibleShare: 0.8 },
  transfer: {
    id: 702,
    name: 'Transfert interne fictif',
    group: 'Trésorerie',
    rate: null,
    accounts: ['580000'],
  },
  ownerContribution: {
    id: 703,
    name: 'Apport fictif',
    group: 'Associés',
    rate: null,
    accounts: ['455000'],
  },
  loan: { id: 704, name: 'Emprunt fictif', group: 'Financement', rate: null, accounts: ['164000'] },
  taxes: {
    id: 705,
    name: 'Impôts fictifs',
    group: 'Taxes',
    rate: null,
    accounts: ['631200', '444000'],
  },
  /** Not a category in the API: lines without one have `category_id: null`. */
  uncategorized: { id: -1, name: 'Non catégorisé', group: 'Divers', rate: null },
} as const;
type CategoryKey = keyof typeof CATEGORIES;

let nextId = 10_000;

export interface OpOptions {
  id?: number;
  date?: string;
  wording?: string;
  amount?: number;
  income?: boolean;
  validated?: boolean;
  category?: CategoryKey;
  /** Percent; null for no VAT. Defaults to the category rate. */
  vatRate?: number | null;
  /** Raw exemption value, e.g. `purchase_non_eu`. */
  exemption?: string;
  attachments?: { name: string; type?: string; vendorInvoiceId?: string; mimeType?: string }[];
  memo?: string | null;
  original?: { amount: number; currency: string };
  deleted?: boolean;
  type?: string;
  /** A refund: money back from a supplier (income on an expense category) or to a customer. */
  refund?: boolean;
  locked?: 'manual' | 'date';
  errors?: unknown[];
  /** False for a line outside VAT (`treatment: "out_of_scope"`): no VAT, no exemption. */
  vatApplicable?: boolean;
}

/** Share of VAT that is deductible for a category (1 unless partially deductible). */
export function deductibleShare(categoryId: number | null): number {
  const cat = Object.values(CATEGORIES).find((c) => c.id === categoryId);
  return cat && 'deductibleShare' in cat ? cat.deductibleShare : 1;
}

/** CLI attachment types → API document kinds. */
const KINDS: Record<string, string> = {
  vendorInvoice: 'purchase_invoice',
  salesInvoice: 'sales_invoice',
  other: 'other',
  unknown: 'unclassified',
};

export function breakdown(
  opId: number,
  amount: number,
  o: OpOptions & { id?: number } = {},
): RawLineFixture {
  const cat = CATEGORIES[o.category ?? 'software'];
  const uncategorized = cat.id === -1;
  const percent = o.vatRate !== undefined ? o.vatRate : cat.rate === null ? null : cat.rate * 100;
  const exempt = !!o.exemption;
  const vat =
    !exempt && percent ? Math.round((amount - amount / (1 + percent / 100)) * 100) / 100 : 0;
  const deductible = Math.round(vat * deductibleShare(cat.id) * 100) / 100;
  const applicable = o.vatApplicable ?? true;
  return {
    id: o.id ?? opId * 10 + 1,
    amount,
    direction: o.income ? 'in' : 'out',
    refund: !!o.refund,
    category_id: uncategorized ? null : cat.id,
    tax: {
      treatment: !applicable ? 'out_of_scope' : exempt ? 'exempt' : 'taxable',
      rate: exempt || !percent ? null : percent / 100,
      amount: vat,
      deductible,
      exemption_reason: o.exemption ?? null,
      overridden: false,
    },
  };
}

export function rawOp(o: OpOptions = {}): RawOpFixture {
  const id = o.id ?? nextId++;
  const amount = o.amount ?? 48;
  return {
    id,
    company_id: Number(COMPANY),
    source: o.type ?? 'bank',
    date: o.date ?? '2026-08-15',
    label: o.wording ?? 'FICTIONAL ORBIT TOOLS',
    note: o.memo ?? null,
    amount,
    direction: o.income ? 'in' : 'out',
    validated: o.validated ?? true,
    status: o.deleted ? 'deleted' : 'active',
    lock: { manual: o.locked === 'manual', period: o.locked === 'date' },
    issues: o.errors ?? [],
    bank: {
      account_id: 501,
      currency: 'EUR',
      amount: o.income ? amount : -amount,
      original_amount: o.original?.amount ?? null,
      original_currency: o.original?.currency ?? null,
    },
    lines: [breakdown(id, amount, o)],
    attachments: (o.attachments ?? []).map((a, i) => ({
      id: id * 100 + i,
      removable: true,
      document: {
        id: id * 100 + i,
        kind: KINDS[a.type ?? 'vendorInvoice'] ?? a.type ?? 'purchase_invoice',
        purchase_invoice_id: a.vendorInvoiceId ?? null,
        file: {
          id: id * 1000 + i,
          name: a.name,
          mime_type: a.mimeType ?? 'application/pdf',
          download_url: `/v1/files/00000000-0000-4000-8000-${String(id * 100 + i).padStart(12, '0')}/download`,
        },
      },
    })),
  };
}

/** The categories as the API serves them; `required`: ids whose zero-VAT lines need a reason. */
export function rawCategories(required: ReadonlySet<number> = new Set()) {
  return Object.values(CATEGORIES)
    .filter((c) => c.id !== -1)
    .map((c) => ({
      id: c.id,
      label: c.name,
      group: { id: 2, name: c.group },
      hidden: false,
      assignable: true,
      direction: (c.id === 301 ? 'in' : 'out') as 'in' | 'out',
      parent_id: null,
      ledger_account: c.id === 205 ? '218300' : c.id === 301 ? '706000' : '626100',
      ...('accounts' in c ? { ledger_accounts: [...c.accounts] } : {}),
      default_vat: c.rate === null ? null : { rate: c.rate, optional: false },
      exemptions: (c.rate === null ? 'unavailable' : required.has(c.id) ? 'required' : 'allowed') as
        | 'unavailable'
        | 'allowed'
        | 'required',
    }));
}

/** The categories by id, as the CLI joins them to lines. */
export function rawCategoryMap() {
  return new Map(rawCategories().map((c) => [c.id, c]));
}

export function rawUser(
  companies = [
    { id: Number(COMPANY), legal_name: 'Fictional Widgets SAS', trade_name: 'Fictional Widgets' },
  ],
) {
  return {
    id: 4242,
    email: 'someone@example.test',
    name: { full: 'Alex Example' },
    companies,
    company: companies[0],
  };
}

export function rawAccounts() {
  return [
    {
      id: 501,
      name: 'Main account',
      bank_name: 'Example Bank',
      currency: 'EUR',
      closed: false,
      hidden: false,
      balance: { amount: 1234.56, updated_at: '2026-08-31T08:00:00.000Z' },
    },
  ];
}
