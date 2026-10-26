import {
  CATEGORIES,
  COMPANY,
  deductibleShare,
  type RawLineFixture,
  type RawOpFixture,
  rawAccounts,
  rawCategories,
  rawUser,
} from './fixtures.js';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

type Handler = (req: RecordedRequest) => Response | Promise<Response> | undefined;

export interface FakeVatReturn {
  /** `filed` (default), `to_file` or `upcoming`. */
  status?: 'filed' | 'to_file' | 'upcoming';
  summary: Record<string, unknown>;
  boxes: Record<string, unknown> | null;
}

/** The API's error envelope (server/API.md §3). */
export function apiError(
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return Response.json({ error: { code, message, details } }, { status });
}

const notFound = () => apiError(404, 'NOT_FOUND', 'Not found');
const round2 = (x: number) => Math.round(x * 100) / 100;
const STORAGE = 'https://storage.example.test';

/**
 * In-memory stand-in for the Compta API (server/API.md), with the behaviours the
 * CLI depends on: bearer auth, date-descending pagination by validation status,
 * PATCH updates with the check order of §4.12 (lock, reopen, exemptions,
 * validation), deductible VAT recomputed (§6.2), and file downloads redirecting to
 * signed storage (§7).
 *
 * Re-categorization does not apply the category’s default VAT here (§6.3): tests
 * that need such a side effect set it up with `onUpdate`.
 */
export class FakeCompta {
  ops = new Map<string, RawOpFixture>();
  requests: RecordedRequest[] = [];
  purchaseInvoices = new Map<string, unknown>();
  vatReturns: FakeVatReturn[] = [];
  fiscalYears = [{ id: 1, start_date: '2025-03-01', end_date: '2025-12-31', closed: true }];
  /** Transactions the platform refuses to reopen (e.g. under review by the accountant). */
  frozen = new Set<string>();
  /** Categories whose zero-VAT lines need an exemption reason before validation. */
  requiredExemptions = new Set<number>();
  /** Server-side side effects of a transaction update (e.g. re-categorization side effects). */
  onUpdate?: (previous: RawOpFixture, next: RawOpFixture) => void;
  /** Stored files by `/<file key>`. */
  files = new Map<string, Uint8Array>();
  session = 'synthetic-session-value';
  overrides: Handler[] = [];
  nextAttachmentId = 900_000;
  /** Password login (§4.1), as in a real deployment. */
  account = {
    email: 'someone@example.test',
    password: 'synthetic-password',
    factors: [] as { type: 'totp' | 'email'; last_used_at?: string }[],
    code: '123456',
    sso: false,
    maxAgeSeconds: 30 * 86_400,
  };
  emailCodesSent = 0;
  unauthorizedResponses = 0;
  remoteLogouts = 0;
  /** Storage requests and whether they carried credentials (they never should). */
  storageFetches: { path: string; hadCredentials: boolean }[] = [];
  private readonly challenge = 'synthetic-mfa-challenge';

  constructor(ops: RawOpFixture[] = []) {
    for (const op of ops) this.ops.set(String(op.id), structuredClone(op));
  }

  get writes(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== 'GET');
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init.headers);
    let body: unknown = init.body;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        return apiError(400, 'INVALID_JSON', 'Malformed request body');
      }
    }
    const req: RecordedRequest = {
      method: init.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers,
      body,
    };
    this.requests.push(req);
    if (url.origin === STORAGE) {
      this.storageFetches.push({
        path: url.pathname,
        hadCredentials: headers.has('authorization') || headers.has('cookie'),
      });
      const key = url.pathname.replace(/^\/storage/, '');
      const file = this.files.get(key);
      if (url.searchParams.get('signature') !== 'abc')
        return apiError(403, 'INVALID_SIGNATURE', 'Invalid signature');
      return file
        ? new Response(new Blob([file as Uint8Array<ArrayBuffer>]))
        : apiError(404, 'NOT_FOUND', 'Not found');
    }
    for (const override of this.overrides) {
      const res = await override(req);
      if (res) return res;
    }
    if (req.method === 'POST' && req.path.startsWith('/v1/auth/') && req.path !== '/v1/auth/logout')
      return this.auth(req);
    if (headers.get('authorization') !== `Bearer ${this.session}`) return this.unauthorized();
    return this.route(req);
  };

  /** Every 401 is counted (§2). */
  unauthorized(code = 'UNAUTHENTICATED', message = 'Unauthorized'): Response {
    this.unauthorizedResponses++;
    const res = apiError(401, code, message);
    res.headers.set('www-authenticate', 'Bearer realm="compta"');
    return res;
  }

  private auth(req: RecordedRequest): Response {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const authenticated = () =>
      Response.json({
        status: 'authenticated',
        token: this.session,
        expires_at: new Date(Date.now() + this.account.maxAgeSeconds * 1000).toISOString(),
      });
    if (req.path === '/v1/auth/login') {
      if (body.email !== this.account.email || body.password !== this.account.password)
        return this.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
      if (this.account.sso) return Response.json({ status: 'sso_required' });
      if (this.account.factors.length)
        return Response.json({
          status: 'mfa_required',
          challenge: this.challenge,
          factors: this.account.factors,
        });
      return authenticated();
    }
    if (req.path === '/v1/auth/mfa/email') {
      if (body.challenge !== this.challenge) return this.unauthorized();
      this.emailCodesSent++;
      return new Response(null, { status: 204 });
    }
    if (req.path === '/v1/auth/mfa/verify') {
      if (body.challenge !== this.challenge || body.code !== this.account.code)
        return this.unauthorized();
      return authenticated();
    }
    return this.unauthorized();
  }

  private route(req: RecordedRequest): Response {
    const c = `/v1/companies/${COMPANY}`;
    const { method, path } = req;
    if (method === 'GET' && path === '/v1/me') return Response.json(rawUser());
    if (method === 'POST' && path === '/v1/auth/logout') {
      this.remoteLogouts++;
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && path === `${c}/bank-accounts`) return Response.json(rawAccounts());
    if (method === 'GET' && path === `${c}/categories`)
      return Response.json(
        req.query.get('view') === 'full'
          ? rawCategories(this.requiredExemptions)
          : rawCategories().map((x) => ({ id: x.id })),
      );
    if (method === 'GET' && path === `${c}/fiscal-years`) return Response.json(this.fiscalYears);
    if (method === 'GET' && path === `${c}/vat-returns`) {
      const status = req.query.get('status');
      if (status !== 'filed' && status !== 'to_file' && status !== 'upcoming')
        return apiError(
          400,
          'INVALID_PARAMETER',
          'status must be one of: filed, to_file, upcoming',
          {
            parameter: 'status',
            allowed: ['filed', 'to_file', 'upcoming'],
          },
        );
      return Response.json(
        this.vatReturns.filter((d) => (d.status ?? 'filed') === status).map((d) => d.summary),
      );
    }
    const vr = path.match(new RegExp(`^${c}/vat-returns/(\\d+)$`));
    if (method === 'GET' && vr) {
      const d = this.vatReturns.find((x) => String(x.summary.id) === vr[1]);
      return d ? Response.json({ ...d.summary, boxes: d.boxes }) : notFound();
    }
    const pi = path.match(new RegExp(`^${c}/purchase-invoices/(.+)$`));
    if (method === 'GET' && pi) {
      const v = this.purchaseInvoices.get(decodeURIComponent(pi[1]!));
      return v ? Response.json(v) : notFound();
    }
    if (method === 'GET' && path === `${c}/transactions`)
      return Response.json(this.list(req.query));
    const file = path.match(/^\/v1\/files\/([^/]+)\/download$/);
    if (method === 'GET' && file) {
      const key = `/${decodeURIComponent(file[1]!)}`;
      return this.files.has(key)
        ? new Response(null, {
            status: 302,
            headers: { location: `${STORAGE}/storage${key}?signature=abc` },
          })
        : notFound();
    }
    const tx = path.match(new RegExp(`^${c}/transactions/(\\d+)(/.*)?$`));
    if (!tx) return notFound();
    const op = this.ops.get(tx[1]!);
    const rest = tx[2] ?? '';
    const att = rest.match(/^\/attachments\/(\d+)$/);
    if (method === 'DELETE' && att) {
      if (!op) return notFound();
      op.attachments = op.attachments.filter((a) => String(a.id) !== att[1]);
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && rest === '/attachments') {
      if (!op) return notFound();
      if (!(req.body instanceof FormData) || !req.body.getAll('file').length)
        return apiError(
          400,
          'FILE_REQUIRED',
          'Expected multipart/form-data with at least one "file" part',
        );
      for (const entry of req.body.getAll('file')) {
        const name = (entry as File).name;
        const id = this.nextAttachmentId++;
        op.attachments.push({
          id,
          removable: true,
          document: {
            id,
            kind: 'unclassified',
            purchase_invoice_id: null,
            amount: null,
            date: null,
            file: {
              id,
              name,
              mime_type: (entry as File).type || 'application/pdf',
              download_url: `/v1/files/uploaded-${id}/download`,
            },
          },
        });
      }
      return Response.json(op);
    }
    if (method === 'POST' && rest === '/attachments/existing') {
      if (!op) return notFound();
      const documentId = (req.body as { document_id?: unknown } | null)?.document_id;
      const doc = [...this.ops.values()]
        .flatMap((o) => o.attachments)
        .find((a) => String(a.document.id) === String(documentId))?.document;
      if (!doc)
        return apiError(404, 'DOCUMENT_NOT_FOUND', 'Document not found', {
          document_id: String(documentId),
        });
      op.attachments.push({ id: this.nextAttachmentId++, removable: true, document: { ...doc } });
      return Response.json(op);
    }
    if (rest) return notFound();
    if (method === 'GET') return op ? Response.json(op) : notFound();
    if (method === 'PATCH') return op ? this.update(op, req) : notFound();
    return notFound();
  }

  /** PATCH …/transactions/{id}, with the checks of API §4.12 in their order. */
  private update(current: RawOpFixture, req: RecordedRequest): Response {
    const id = String(current.id);
    const body = req.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      return apiError(400, 'INVALID_BODY', 'Expected a JSON object');
    const patch = body as { note?: string | null; validated?: unknown; lines?: unknown };
    if ((current.lock.manual || current.lock.period) && req.query.get('override_lock') !== 'true')
      return apiError(
        423,
        current.lock.period ? 'PERIOD_LOCKED' : 'MANUALLY_LOCKED',
        'This transaction is locked.',
        { transaction_id: current.id },
      );
    const lines = Array.isArray(patch.lines) ? (patch.lines as RawLineFixture[]) : undefined;
    if (
      lines?.some(
        (l) =>
          typeof l?.id !== 'number' ||
          typeof l.amount !== 'number' ||
          typeof l.tax?.amount !== 'number' ||
          !['taxable', 'exempt', 'out_of_scope'].includes(l.tax.treatment) ||
          (l.tax.treatment === 'exempt') !== !!l.tax.exemption_reason ||
          (l.tax.treatment === 'exempt' && (l.tax.amount !== 0 || l.tax.rate !== null)) ||
          !(l.category_id === null || typeof l.category_id === 'number'),
      )
    )
      return apiError(400, 'INVALID_LINES', 'Invalid lines');
    const validated = 'validated' in patch ? patch.validated === true : current.validated;
    const note = 'note' in patch ? (patch.note ?? null) : current.note;
    if (current.validated) {
      if (!validated && this.frozen.has(id)) return apiError(403, 'FORBIDDEN', 'Forbidden');
      const edited =
        (lines && JSON.stringify(lines) !== JSON.stringify(current.lines)) || note !== current.note;
      if (validated && edited) return apiError(403, 'FORBIDDEN', 'Forbidden');
    }
    const known = new Set<number>(Object.values(CATEGORIES).map((x) => x.id));
    const unknown = lines?.find((l) => l.category_id !== null && !known.has(l.category_id));
    if (unknown)
      return apiError(400, 'UNKNOWN_CATEGORY', 'Unknown category', {
        category_id: unknown.category_id,
      });
    // A reason being recorded needs a category subject to VAT (§6.1).
    for (const l of lines ?? []) {
      const reason = l.tax.exemption_reason;
      if (!reason || current.lines.find((x) => x.id === l.id)?.tax.exemption_reason === reason)
        continue;
      const cat = Object.values(CATEGORIES).find((x) => x.id === l.category_id);
      if (!cat || cat.id === -1 || cat.rate === null)
        return apiError(
          400,
          'EXEMPTION_NOT_ALLOWED',
          'This line cannot carry an exemption reason',
          {
            line_id: l.id,
            category_id: l.category_id,
          },
        );
    }
    const next: RawOpFixture = {
      ...current,
      note,
      validated,
      lines: lines ? structuredClone(lines) : structuredClone(current.lines),
    };
    for (const b of next.lines)
      b.tax.deductible = round2(b.tax.amount * deductibleShare(b.category_id));
    this.onUpdate?.(current, next);
    if (next.validated) {
      const problems = validationProblems(next, this.requiredExemptions);
      if (problems.length)
        return apiError(
          400,
          'VALIDATION_FAILED',
          `Transaction cannot be validated: ${problems.join('; ')}`,
          {
            problems,
          },
        );
    }
    this.ops.set(id, next);
    return Response.json(next);
  }

  private list(query: URLSearchParams): RawOpFixture[] {
    const validated = query.get('validated') === 'true';
    const offset = Number(query.get('offset') ?? 0);
    const limit = Number(query.get('limit') ?? 40);
    return [...this.ops.values()]
      .filter((op) => op.validated === validated)
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
      .slice(offset, offset + limit);
  }

  pagesFetched(validated: boolean): number {
    return this.requests.filter(
      (r) => r.path.endsWith('/transactions') && r.query.get('validated') === String(validated),
    ).length;
  }
}

/** API §6.5. */
function validationProblems(tx: RawOpFixture, required: ReadonlySet<number>): string[] {
  const problems: string[] = [];
  if (tx.issues.length) problems.push(`it has ${tx.issues.length} issue(s)`);
  const lines = tx.lines;
  if (lines.some((l) => l.category_id === null)) problems.push('a line is uncategorized');
  const signed = (dir: string | undefined, x: number) => ((dir ?? tx.direction) === 'in' ? x : -x);
  const total = lines.reduce((s, l) => s + signed(l.direction, l.amount), 0);
  if (lines.length && Math.abs(total - signed(tx.direction, tx.amount)) > 0.01)
    problems.push('its lines do not add up to the transaction amount');
  if (
    lines.some(
      (l) =>
        l.category_id !== null &&
        required.has(l.category_id) &&
        l.tax.treatment === 'taxable' &&
        l.tax.amount === 0,
    )
  )
    problems.push('zero VAT without a required exemption reason');
  return problems;
}
