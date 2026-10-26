# Compta API

Compta is a fictional French accounting platform. french-cfo-bench uses it as the system under test:
a small server (`server/`) implements this API over a synthetic company loaded from a scenario
file, and the `compta` CLI (`cli/`) is its command-line client. This document is the complete
contract of that server: every endpoint, object, error, the signed file storage, the admin port,
the write log and the scenario file format.

Contents

1. Conventions
2. Authentication
3. Errors
4. Endpoints
5. Objects
6. Behaviour rules (updates, VAT, locks, validation, CA3)
7. Files and signed storage
8. Admin port
9. Write log
10. Scenario file (server input)
11. Glossary

---

## 1. Conventions

| Topic | Rule |
|---|---|
| Transport | HTTPS. The API origin and the storage origin differ (§7). |
| Versioning | Every API path starts with `/v1`. |
| Bodies | JSON (`application/json`), except file uploads (`multipart/form-data`). A form-encoded body (`application/x-www-form-urlencoded`) is accepted where noted. |
| Field names | `snake_case` everywhere in the API. (The admin port and write log keep their own names, §8–9.) |
| Money | JSON numbers in euros, at most two decimals. Transaction and line amounts are **positive**; the sign lives in `direction`. Only `bank.amount` / `bank.original_amount` are signed (bank view). |
| VAT rates | **Fractions** everywhere: `0.2` = 20 %, `0.1`, `0.055`, `0.021`. `null` = no rate. |
| Dates | `YYYY-MM-DD` for calendar dates; ISO 8601 UTC timestamps (`2026-10-15T06:12:00.000Z`) for instants. |
| IDs | Numbers for companies, users, bank accounts, categories, category groups, transactions, lines, attachments, documents, files, fiscal years and VAT returns. Strings for purchase-invoice ids and file keys (UUID-shaped). Path segments carry ids in decimal. |
| Company scope | Company data lives under `/v1/companies/{company_id}`. Another company's id answers `404 NOT_FOUND`. |
| Uncategorized | A line without a category has `category_id: null`. There is no sentinel category. |
| Pagination | `offset` (default `0`) and `limit` query parameters. A value that is missing, negative or not a number falls back to the default. Values are floored to integers. |
| Unknown fields | Request fields the endpoint does not document are ignored, inside `lines[]` too (lines are stored in their documented shape, §6.1). |
| Unknown routes | `404 NOT_FOUND` (after authentication: an unauthenticated request to any non-auth path gets `401` first). |
| Request order | 1. signed storage paths (§7) are served first; 2. the body is read and decoded — a malformed body answers `400 INVALID_JSON` before authentication (no `401`, counter unchanged); 3. login steps; 4. authentication; 5. routing. |
| Optional fields | "opt." in §5 means the key may be absent in stored data; the server serves stored objects as they are and never adds absent keys. |

## 2. Authentication

Every endpoint except the login steps (§4.1) and signed storage (§7) requires:

```
Authorization: Bearer <api_token>
```

The header value must be exactly `Bearer ` followed by the token. Anything else (missing header,
other scheme, wrong token) answers `401 UNAUTHENTICATED` with `WWW-Authenticate: Bearer realm="compta"`.
Tokens do not rotate and are never set by the server in cookies; the API uses no cookies.

In the benchmark server the only valid token is the scenario's `api_token`. No email/password or
second factor is valid: every login step answers `401` (§4.1). Agents are pre-provisioned with the
token and never need to log in.

The server counts every `401` it sends (`counters.unauthorized_responses`, §8.2).

## 3. Errors

Every API error is JSON:

```json
{ "error": { "code": "PERIOD_LOCKED", "message": "This transaction is locked.", "details": { "transaction_id": 4100003 } } }
```

| Field | Type | Meaning |
|---|---|---|
| `error.code` | string | Stable machine code (table below). Clients branch on it. |
| `error.message` | string | Short human text. Not stable. |
| `error.details` | object | Extra facts; `{}` when none. |

| HTTP | `code` | When | `message` | `details` |
|---:|---|---|---|---|
| 400 | `INVALID_JSON` | Body cannot be decoded (bad JSON, broken multipart). | `Malformed request body` | `{}` |
| 400 | `INVALID_PARAMETER` | A required or enumerated query parameter is missing or wrong. | `status must be one of: filed, to_file, upcoming` | `{"parameter": "status", "allowed": ["filed","to_file","upcoming"]}` |
| 400 | `INVALID_BODY` | Transaction update body is not a JSON object. | `Expected a JSON object` | `{}` |
| 400 | `INVALID_LINES` | `lines` present but an item is malformed or its `tax` is incoherent (§6.1). | `Invalid lines` | `{}` |
| 400 | `UNKNOWN_CATEGORY` | A line references a category id that does not exist. | `Unknown category` | `{"category_id": n}` |
| 400 | `EXEMPTION_NOT_ALLOWED` | A line would record an exemption reason it cannot carry (uncategorized, or its category's `exemptions` is `unavailable`, §6.1). | `This line cannot carry an exemption reason` | `{"line_id": n, "category_id": n \| null}` |
| 400 | `VALIDATION_FAILED` | The update would leave a validated transaction that fails the validation rules (§6.5). | `Transaction cannot be validated: <problems joined by "; ">` | `{"problems": ["…"]}` |
| 400 | `FILE_REQUIRED` | Upload without any `file` part. | `Expected multipart/form-data with at least one "file" part` | `{}` |
| 401 | `UNAUTHENTICATED` | Missing/invalid bearer token; any second-factor step. | `Unauthorized` | `{}` |
| 401 | `INVALID_CREDENTIALS` | Password login refused. | `Invalid email or password` | `{}` |
| 403 | `FORBIDDEN` | Editing a validated transaction without reopening it; reopening a transaction the platform refuses to reopen. | `Forbidden` | `{}` |
| 404 | `NOT_FOUND` | Unknown route, company, transaction, VAT return, purchase invoice or file. | `Not found` | `{}` |
| 404 | `DOCUMENT_NOT_FOUND` | Linking an unknown document. | `Document not found` | `{"document_id": "…"}` |
| 423 | `PERIOD_LOCKED` | Updating a transaction whose period lock is set. | `This transaction is locked.` | `{"transaction_id": n}` |
| 423 | `MANUALLY_LOCKED` | Updating a transaction locked by hand (period lock not set). | `This transaction is locked.` | `{"transaction_id": n}` |
| 500 | `INTERNAL_ERROR` | Unhandled server failure. | `Internal server error` | `{}` |

Signed storage (§7) uses the same envelope with `INVALID_SIGNATURE` (403), `NOT_FOUND` (404) and
`METHOD_NOT_ALLOWED` (405).

## 4. Endpoints

`{company_id}`, `{transaction_id}`, `{attachment_id}` and `{return_id}` are decimal ids;
`{invoice_id}` is URL-decoded before lookup; `{file_key}` is URL-decoded.

### 4.1 Login steps (no token required)

Every `POST /v1/auth/*` request is recorded in the write log as an `auth` record (§9), with
secrets reduced to booleans. In the benchmark server all three steps below always fail.

#### `POST /v1/auth/login`

Request: `{"email": "user@example.com", "password": "…"}`.

Responses in a real deployment (documented for clients; the benchmark server never sends them):

| Status | Body | Next step |
|---|---|---|
| 200 | `{"status": "authenticated", "token": "<api_token>", "expires_at": "<timestamp>" \| null}` | Done. |
| 200 | `{"status": "mfa_required", "challenge": "<opaque>", "factors": [{"type": "totp" \| "email", "last_used_at": "<timestamp>" \| null}]}` | §`/mfa/email` (if `email`), then `/mfa/verify`. |
| 200 | `{"status": "sso_required"}` | The account signs in through an identity provider; use a token. |

Benchmark server: always `401 INVALID_CREDENTIALS`.

#### `POST /v1/auth/mfa/email`

Request: `{"challenge": "<opaque>"}`. Real deployment: `204`, a code is emailed.
Benchmark server: always `401 UNAUTHENTICATED`.

#### `POST /v1/auth/mfa/verify`

Request: `{"challenge": "<opaque>", "factor": "totp" | "email", "code": "123456"}`.
Real deployment: `200 {"status": "authenticated", "token": "…", "expires_at": …}`.
Benchmark server: always `401 UNAUTHENTICATED`.

Any other `POST /v1/auth/<path>` except `logout`: `401 UNAUTHENTICATED`.

### 4.2 `POST /v1/auth/logout` (token required)

Ends the token's session. No body. Response: `204`, empty body.
Benchmark server: counts the call (`counters.remote_logouts`) and **keeps the token valid**, so a
stray logout does not end a run. Logged as an `auth` record.

### 4.3 `GET /v1/me`

Response `200`: the current [User](#user) with the full [Company](#company) the token is scoped to.

### 4.4 `GET /v1/companies/{company_id}/bank-accounts`

Response `200`: array of [BankAccount](#bankaccount).

### 4.5 `GET /v1/companies/{company_id}/categories`

| Query | Effect |
|---|---|
| `view=full` | Array of full [Category](#category) objects. |
| absent / any other value | Array of `{"id": n}` only. |

The scenario-only `deductible_share` and `exemption_required` are never served; `exemptions` is
derived from them (§5 Category). Response `200`.

### 4.6 `GET /v1/companies/{company_id}/fiscal-years`

Response `200`: array of [FiscalYear](#fiscalyear), in scenario order.

### 4.7 `GET /v1/companies/{company_id}/vat-returns`

| Query | Required | Meaning |
|---|---|---|
| `status` | yes | `filed`, `to_file` or `upcoming` (§11). Anything else: `400 INVALID_PARAMETER`. |
| `offset` | no | Default 0. |
| `limit` | no | Default: no limit. |

Response `200`: array of [VatReturnSummary](#vatreturnsummary) with that status, in scenario
order, paged. **Items do not repeat their status** (the request names it). Summaries of open CA3
returns carry the recomputed `net_amount` (§6.6).

### 4.8 `GET /v1/companies/{company_id}/vat-returns/{return_id}`

Response `200`: [VatReturn](#vatreturn) = the summary fields plus `boxes` (no `status` field).
Open CA3 returns are recomputed at read time (§6.6); filed returns are served as stored.
Unknown id: `404 NOT_FOUND`.

### 4.9 `GET /v1/companies/{company_id}/purchase-invoices/{invoice_id}`

Response `200`: [PurchaseInvoice](#purchaseinvoice) (the platform's reading of a supplier invoice).
Unknown id: `404 NOT_FOUND`.

### 4.10 `GET /v1/companies/{company_id}/transactions`

| Query | Meaning |
|---|---|
| `validated` | `true` lists validated transactions. **Any other value or none lists unvalidated ones.** There is no "all" list. |
| `offset` | Default 0. |
| `limit` | Default **40**. No maximum. |

Every other query parameter is ignored. Response `200`: array of [Transaction](#transaction),
sorted by `date` descending, then `id` descending, then paged. Transactions with status `deleted`
or `excluded` are listed like the others (clients filter them).

### 4.11 `GET /v1/companies/{company_id}/transactions/{transaction_id}`

Response `200`: [Transaction](#transaction). Unknown: `404 NOT_FOUND`.

### 4.12 `PATCH /v1/companies/{company_id}/transactions/{transaction_id}`

Updates the note, the validation flag and/or the lines. Body: a JSON object with any of:

| Field | Type | Effect when present |
|---|---|---|
| `note` | string \| null | Replaces the note. |
| `validated` | boolean | `true` validates; anything else (including `"true"`) un-validates. |
| `lines` | array of [Line](#line) | Replaces **all** lines (full list, not a diff). Each item is checked and stored in the documented shape, then the server recomputes the derived values (§6.1–6.3). |

Absent fields keep their current value; a `lines` value that is not an array is treated as absent (current lines kept). Other top-level fields are ignored.

| Query | Meaning |
|---|---|
| `override_lock=true` | Bypasses `lock.manual` / `lock.period` (an accountant action; the official client never sends it). Recorded as `force: true` in the write log. |

Checks, in this order:

1. Unknown transaction → `404 NOT_FOUND`.
2. Body not a JSON object → `400 INVALID_BODY`.
3. Locked (`lock.period` or `lock.manual`) without `override_lock=true` → `423 PERIOD_LOCKED` (period lock set) or `423 MANUALLY_LOCKED`.
4. `lines` items malformed or incoherent (§6.1) → `400 INVALID_LINES`.
5. Currently validated: un-validating a frozen transaction → `403 FORBIDDEN`; staying validated while `lines` (other than `tax.deductible`) or `note` differ from the current ones → `403 FORBIDDEN` (reopen first: send `{"validated": false}`, edit, then `{"validated": true}`).
6. A line's `category_id` is neither `null` nor a known category → `400 UNKNOWN_CATEGORY`.
7. A line records an exemption reason it cannot carry (§6.1) → `400 EXEMPTION_NOT_ALLOWED`.
8. Apply the update and the recomputations of §6.2–6.3.
9. If the result is validated and fails §6.5 → `400 VALIDATION_FAILED` (nothing is stored).

An update is all or nothing: on any error nothing is stored. Category, tax treatment and
exemption reason of a line change together in one update (§6.1).

Response `200`: the updated [Transaction](#transaction).

### 4.13 `POST /v1/companies/{company_id}/transactions/{transaction_id}/attachments`

Uploads one or more files and attaches each as a new document. Body: `multipart/form-data` with
one or more parts named `file` (other parts ignored). Each part's filename becomes the document's
file name; its content type (or, if empty, a type guessed from the extension) becomes `mime_type`.

For each file the server creates a [File](#file) (deterministic key, §7.3), a [Document](#document)
with `kind: "unclassified"`, `purchase_invoice_id: null`, `amount: null`, `date: null`, and an
[Attachment](#attachment) with `removable: true`. New ids are above every id in the scenario, with
floors: attachments 9 000 000, documents 8 000 000, files 7 000 000.

Locks and validation are **not** checked: attaching is allowed on locked and validated transactions.

| Status | Case |
|---|---|
| 200 | The updated [Transaction](#transaction). |
| 400 `FILE_REQUIRED` | No `file` part (or not multipart). |
| 404 `NOT_FOUND` | Unknown transaction. |

### 4.14 `POST /v1/companies/{company_id}/transactions/{transaction_id}/attachments/existing`

Attaches a document that already exists in the company (attached elsewhere, or detached earlier).
Body: `{"document_id": <id>}` as JSON, form-encoded, or a multipart text field. A new attachment
(new `id`, `removable: true`) pointing to a copy of the document is appended. Locks and validation
are not checked.

| Status | Case |
|---|---|
| 200 | The updated [Transaction](#transaction). |
| 404 `NOT_FOUND` | Unknown transaction. |
| 404 `DOCUMENT_NOT_FOUND` | No document with that id in the company. |

### 4.15 `DELETE /v1/companies/{company_id}/transactions/{transaction_id}/attachments/{attachment_id}`

Removes the attachment relation. The document and its file stay in the company (they can be
re-attached with §4.14). Locks and validation are not checked. No body.

| Status | Case |
|---|---|
| 204 | Removed, **or the attachment did not exist** (idempotent). |
| 404 `NOT_FOUND` | Unknown transaction. |

### 4.16 `GET /v1/files/{file_key}/download`

Response `302` with `Location: <storage origin>/storage/{file_key}?signature=<hex>` (§7).
Unknown key: `404 NOT_FOUND`. Clients must follow the redirect **without** the `Authorization` header.

## 5. Objects

Field tables list every field the server sends. "opt." means the key may be absent in scenario
data; clients must treat absent as the stated default.

### Transaction

A bank movement or a manual expense, with its accounting lines and attached documents.

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Transaction id. |
| `company_id` | number | Owning company. |
| `source` | `"bank"` \| `"expense"` | `bank`: imported bank movement (has `bank`); `expense`: manual expense entry (`bank: null`). |
| `date` | date | Value date. |
| `label` | string | Bank label as received (e.g. `PRLV SEPA SCI DES TANNEURS`). |
| `note` | string \| null | Free note written by users. |
| `amount` | number | Gross amount, positive. |
| `direction` | `"in"` \| `"out"` | Money received / paid. |
| `validated` | boolean | Validated transactions are read-only until reopened (§6.4). |
| `validated_at` | timestamp \| null | opt. When it was validated. |
| `status` | `"active"` \| `"excluded"` \| `"deleted"` | Excluded and deleted transactions are kept but count nowhere (CA3, lists in clients). |
| `lock` | `{"manual": boolean, "period": boolean}` | Ledger locks enforced by the server on updates (§6.4). |
| `issues` | array | Platform-detected problems (opaque objects). A non-empty list blocks validation. |
| `bank` | [BankDetails](#bankdetails) \| null | Bank-side data; `null` for `source: "expense"`. |
| `lines` | array of [Line](#line) | Accounting lines (usually one). |
| `attachments` | array of [Attachment](#attachment) | Attached documents (receipts, invoices). |

### Line

One accounting line of a transaction: where (part of) the amount is booked and how VAT applies.

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Line id (unique within the scenario). |
| `amount` | number | Gross amount of the line, positive. |
| `direction` | `"in"` \| `"out"` | opt.; default: the transaction's `direction`. Can differ (e.g. fees inside a payout). |
| `refund` | boolean | opt., default `false`. A refund reverses VAT of the opposite direction (a supplier refund stays a purchase). |
| `category_id` | number \| null | [Category](#category); `null` = uncategorized. Names and groups are read from the category list. |
| `tax` | [Tax](#tax) | How VAT applies to the line. |

### Tax

The tax treatment of a line.

| Field | Type | Meaning |
|---|---|---|
| `treatment` | `"taxable"` \| `"exempt"` \| `"out_of_scope"` | `taxable`: subject to VAT at `rate` (`amount` may be 0, e.g. a category without a default rate). `exempt`: subject to VAT but none is due, for the reason in `exemption_reason`. `out_of_scope`: outside VAT (bank fees, salaries, transfers…); no reason applies. |
| `rate` | number \| null | Fraction; `null` when no rate. Always `null` when `exempt`. |
| `amount` | number | VAT included in the line's `amount`. Always `0` when `exempt`. |
| `deductible` | number | Read-only: the part of `amount` the company may deduct, computed by the server (§6.2). Ignored in requests. |
| `exemption_reason` | string \| null | Why no VAT is due ([exemption reasons](#exemption-reasons)); set exactly when `treatment` is `exempt`. |
| `overridden` | boolean | The tax was set by hand: a re-categorization keeps it instead of applying the category's default (§6.3). Default `false`. |

### BankDetails

| Field | Type | Meaning |
|---|---|---|
| `account_id` | number | [BankAccount](#bankaccount) id. |
| `amount` | number | Signed amount in `currency` (negative = debit). |
| `currency` | string | opt. Account currency (`EUR`). |
| `original_amount` | number \| null | opt. Signed amount in the original currency for foreign card payments. |
| `original_currency` | string \| null | opt. ISO 4217 code (`USD`, `GBP`), else `null`. |
| `fx_rate` | number \| null | opt. Exchange rate applied (`1` when none). |

### Attachment

The relation between a transaction and a document.

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Attachment id (use it to detach). |
| `removable` | boolean | opt., default `true`. |
| `document` | [Document](#document) | The attached document. |

### Document

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Document id (use it to link to another transaction, §4.14). |
| `kind` | [document kind](#document-kinds) | Classification. New uploads start `unclassified`. |
| `purchase_invoice_id` | string \| null | Id of the platform's [PurchaseInvoice](#purchaseinvoice) reading, when the document is a supplier invoice that was read. |
| `amount` | number \| null | opt. Amount on the document, if known. |
| `date` | date \| null | opt. Date on the document, if known. |
| `file` | [File](#file) \| null | The stored file. |

### File

| Field | Type | Meaning |
|---|---|---|
| `id` | number | File id. |
| `name` | string | File name as uploaded. |
| `mime_type` | string | opt. Content type. |
| `download_url` | string | Relative API path `/v1/files/{file_key}/download` (§4.16). |

### Category

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Category id (positive). |
| `label` | string | Label in French (e.g. `Logiciels et abonnements`). |
| `group` | `{"id": number, "name": string}` \| null | Group shown above the category. |
| `hidden` | boolean | opt., default `false`. Hidden categories cannot be picked. |
| `assignable` | boolean | opt., default `true`. |
| `direction` | `"in"` \| `"out"` \| `"both"` | Income, expense, or both. |
| `parent_id` | number \| null | Parent category, if any. |
| `ledger_account` | string \| null | French chart of accounts (PCG) number, e.g. `"613500"`. |
| `ledger_accounts` | array of string | Every PCG account the category books to. |
| `default_vat` | `{"rate": number \| null, "optional": boolean}` \| null | VAT applied when a line is categorized here (§6.3). `null`: outside VAT. `rate: null`: subject to VAT without a default rate. `optional: true`: zero VAT is normal for some purchases. |
| `exemptions` | `"unavailable"` \| `"allowed"` \| `"required"` | Derived. Whether lines of this category can carry an exemption reason (§6.1): `unavailable` when `default_vat` is `null` (outside VAT); `required` when a zero-VAT taxable line needs one before validation (§6.5); else `allowed`. |

### BankAccount

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Account id. |
| `name` | string | Account name. |
| `bank_name` | string | Bank. |
| `currency` | string | `EUR`. |
| `closed` | boolean | Account closed. |
| `hidden` | boolean | Hidden in the web app. |
| `balance` | `{"amount": number \| null, "updated_at": timestamp \| null}` \| null | Last known balance. |

### FiscalYear

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Fiscal year id. |
| `start_date` | date | First day. |
| `end_date` | date | Last day. |
| `closed` | boolean | Closed years are final. |
| `current` | boolean | opt. The year in progress. |

### VatReturnSummary

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Return id. |
| `return_type` | string | Form family: `CA3` (monthly/quarterly), `CA12` (annual)… |
| `form_year` | number \| null | Vintage of the official form (e.g. `2026`). |
| `tax` | string | Tax family: `vat`. |
| `title` | string | opt. Display title, e.g. `TVA CA3 — août 2026`. |
| `period_start` | date | First day covered. |
| `period_end` | date | Last day covered. |
| `due_date` | date \| null | opt. Filing deadline. |
| `filed` | boolean | opt. Filed (status `filed`). |
| `overdue` | boolean | opt., default `false`. Not filed and past `due_date` (as stored in the scenario). |
| `confirmed_at` | timestamp \| null | opt. When the user confirmed it. |
| `filed_at` | timestamp \| null | opt. When it was filed. |
| `dismissed` | boolean | opt., default `false`. Dismissed returns are not to be filed (clients skip them). |
| `net_amount` | number | opt. Whole euros: VAT payable (positive) or credit (negative). |

### VatReturn

A [VatReturnSummary](#vatreturnsummary) plus:

| Field | Type | Meaning |
|---|---|---|
| `boxes` | object \| null | Box values in whole euros, keyed as in [CA3 box keys](#ca3-box-keys). `null` when the platform has no figures. |

### PurchaseInvoice

The platform's reading (extraction) of a supplier invoice document.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Invoice id (UUID-shaped). |
| `extraction_status` | `"done"` \| `"pending"` | `pending`: not read yet; every extracted field below is `null`. |
| `total_amount` | number \| null | Invoice total. |
| `vat_amount` | number \| null | VAT on the invoice. |
| `currency` | string \| null | Invoice currency. |
| `issue_date` | date \| null | Invoice date. |
| `supplier` | `{"name": string \| null, "country": string \| null, "vat_number": string \| null}` \| null | Supplier as read; `null` when nothing was read. `country` is ISO 3166-1 alpha-2. |
| `vat_lines` | array \| null | One item per VAT rate on the invoice: `{"rate": number \| null, "net_amount": number \| null, "vat_amount": number \| null, "tax_category": string \| null, "exemption_code": string \| null}`. `tax_category` and `exemption_code` use EN 16931 codes: `S` standard rate, `AE` reverse charge (`exemption_code` e.g. `VATEX-EU-AE`). |
| `file` | `{"id": number \| null, "name": string \| null, "download_url": string \| null}` \| null | The invoice file. |
| `transactions` | array of `{"id": number, "date": date, "amount": number}` | Transactions the invoice is attached to. |

### User

| Field | Type | Meaning |
|---|---|---|
| `id` | number | User id. |
| `email` | string \| null | Login email. |
| `name` | `{"full": string, "first": string, "last": string}` | opt. keys inside. |
| `companies` | array of `{"id": number, "legal_name": string, "trade_name": string}` | Companies the user can open. If the scenario has none, the server lists the scenario company. |
| `company` | [Company](#company) | The company the token is scoped to. |

### Company

| Field | Type | Meaning |
|---|---|---|
| `id` | number | Company id. |
| `legal_name` | string | Registered name. |
| `trade_name` | string | opt. Commercial name. |
| `siren` | string | opt. French company number. |
| `vat_number` | string | opt. Intra-EU VAT number. |
| `legal_form` | string | opt. e.g. `SAS`. |
| `address` | `{"street", "postal_code", "city", "country"}` | opt. |
| `activity` | string | opt. |
| `vat_regime` | `"monthly"` \| `"quarterly"` \| `"annual"` | opt. VAT filing regime. |
| `fiscal_year_end` | `MM-DD` | opt. |

## 6. Behaviour rules

### 6.1 Line replacement and exemptions

`lines` in a PATCH replaces the whole list (lines can be added, removed or split). Each item must
have a numeric `id` and `amount`, a numeric-or-null `category_id`, optional `direction`
(`in`/`out`) and `refund` (boolean), and a `tax` object with a known `treatment`, a
numeric-or-null `rate`, a numeric `amount`, an `exemption_reason` and an optional boolean
`overridden` (default `false`). The tax must be coherent: `exemption_reason` is one of the
[exemption reasons](#exemption-reasons) when `treatment` is `exempt`, and `null` otherwise; an
exempt line has `rate: null` and `amount: 0`. Anything else answers `400 INVALID_LINES`. Unknown
fields are dropped and `tax.deductible` is recomputed (§6.2).

**Exemptions.** A line records an exemption reason by being sent `exempt` with the reason, in the
same update as any other change to it (category included); the server checks the result as a
whole. Recording a reason (one the line did not already carry) needs a category whose
`exemptions` is not `unavailable`: an uncategorized line, or one in a category outside VAT,
answers `400 EXEMPTION_NOT_ALLOWED` and nothing is stored. A line that keeps its reason is not
checked again (it may move to another category with it). The server never sets or clears a
reason by itself.

### 6.2 Deductible VAT

For each line: `share` = the category's scenario-only `deductible_share` (default 1; 0 for
passenger transport and hotels; 1 when uncategorized), `tax.deductible = round2(tax.amount ×
share)` (`round2` = `Math.round(x×100)/100`).

### 6.3 Re-categorization side effects

When a line moves to another category (its `category_id` differs from the stored line with the
same `id`):

- To `null` (uncategorize): the tax stays as it is.
- To a category: **unless** the line (as sent) is `exempt` or `overridden`, its tax becomes the
  category's default (`exemption_reason: null`, `overridden: false`):

| `default_vat` | `treatment` | `rate` | `amount` |
|---|---|---|---|
| `null` (outside VAT) | `out_of_scope` | `null` | `0` |
| `rate > 0` | `taxable` | `rate` | `round2(amount − amount / (1 + rate))` |
| `rate` null or 0 | `taxable` | `null` | `0` |

This is the "side effect" clients report: categorizing a zero-VAT line into a VAT category adds
VAT. To move a line and set its tax in one update, send the tax `overridden: true` (or `exempt`).

### 6.4 Validation state and locks

Two independent protections exist.

**Server-enforced (this API).**

- `validated: true` makes the transaction read-only for `note` and `lines`. Reopen with
  `{"validated": false}`, edit, validate again with `{"validated": true}`.
- Some validated transactions cannot be reopened (scenario flag `frozen`, e.g. under review by
  the accountant): `403 FORBIDDEN`.
- `lock.period` (books closed up to that date) and `lock.manual` (locked by the accountant) refuse
  every PATCH with `423` unless `override_lock=true`.
- Attachments (upload, link, detach) ignore validation and locks.

**Client-side (not enforced here).** A VAT return with status `filed` freezes its period in the
user's eyes, and a `closed` fiscal year freezes its dates. This API does **not** refuse updates in
such periods; the official client refuses them unless the user explicitly allows it. Filed return
figures never change (§6.6), so such an edit desynchronizes the books from what was filed.

### 6.5 Validation rules

A transaction can be validated only if none of these problems exists (checked on the result of an
update that sets or keeps `validated: true`):

| Problem text | Condition |
|---|---|
| `it has N issue(s)` | `issues` is non-empty. |
| `a line is uncategorized` | A line has `category_id: null`. |
| `its lines do not add up to the transaction amount` | At least one line exists and Σ signed(line amounts) ≠ signed(transaction amount) by more than 0.01, where signed(x) = +x for `in`, −x for `out` (line direction defaults to the transaction's). |
| `zero VAT without a required exemption reason` | A line is `taxable` with `tax.amount: 0` in a category whose `exemptions` is `required` (once per such line). |

An unvalidated transaction may be unbalanced or uncategorized.

### 6.6 VAT returns and CA3 recomputation

- Returns with status `filed` are frozen: served exactly as stored.
- Every other return whose `return_type` starts with `CA3` and whose stored `boxes` is not `null` is
  recomputed at each read from the company's current transactions dated within
  `[period_start, period_end]` (date part only), with box `22` = box `27` of the latest filed return
  with `return_type` starting with `CA3` whose `period_start` is before this one (latest = greatest `period_start`, then
  `confirmed_at` or `filed_at`). If the summary has `net_amount`, it becomes box `28` when non-zero,
  else `−box 27` (or 0).

Computation (all sums in integer cents; `cents(x) = Math.round(x×100)`):

For each transaction with `status: "active"`, for each line that has a category: `account` = the
category's `ledger_account` (or `""`); `inbound` = line `direction` (when present) else
transaction `direction`, `== "in"`; `refund` = line `refund` (default false);
`sale = refund ? !inbound : inbound`; `sign = refund ? −1 : +1`; `amount = cents(line.amount)`;
`vat = cents(tax.amount)`.

- Sale: if `vat > 0` and `tax.rate` is neither `null` nor `0`: add `sign×(amount−vat)` to the base
  and `sign×vat` to the tax of the rate's line (0.2 → `08`, 0.1 → `9B`, 0.055 → `09`; other rates
  are ignored). Otherwise, if `account` starts with `70`, add `sign×amount` to `E2`.
- Purchase: if `tax.exemption_reason` is `purchase_eu` add `sign×amount` to reverse-charge EU; if
  `purchase_non_eu` add it to reverse-charge non-EU (stop there). Otherwise
  `d = cents(tax.deductible)`; if `d > 0` add `sign×d` to deductible assets when `account` starts
  with `2`, else to deductible other.
- Self-assessed tax on reverse charge = 20 % of each reverse-charge base, rounded half away from
  zero to the cent.

Boxes (whole euros; `euros(c) = floor((c+50)/100)`):

| Box | Value |
|---|---|
| `A1` | euros(base 20 + base 10 + base 5.5) |
| `A3` | euros(reverse-charge EU + non-EU) |
| `A3_eu` / `A3_non_eu` | euros of each reverse-charge base |
| `E2` | euros(E2) |
| `08` / `08_tax` | euros(base 20 + reverse-charge bases) / euros(tax 20 + self-assessed tax) |
| `9B` / `9B_tax` | euros(base 10) / euros(tax 10) |
| `09` / `09_tax` | euros(base 5.5) / euros(tax 5.5) |
| `19` | euros(deductible assets) |
| `20_domestic` | euros(deductible other) |
| `20_eu_reverse_charge` / `20_non_eu_reverse_charge` | euros(self-assessed EU) / euros(self-assessed non-EU) |
| `16` | `08_tax + 9B_tax + 09_tax` |
| `20` | `20_domestic + 20_eu_reverse_charge + 20_non_eu_reverse_charge` |
| `22` | previous filed credit (0 if none) |
| `23` | `19 + 20 + 22` |
| `25` | `max(0, 23 − 16)` |
| `26` | 0 |
| `27` | `25 − 26` |
| `28` | `max(0, 16 − 23)` |
| `32` | `28` |

## 7. Files and signed storage

### 7.1 Download flow

1. `GET /v1/files/{file_key}/download` (authenticated) → `302`, `Location:
   https://<storage host>/storage/{file_key}?signature=<hex>`.
2. `GET` that URL **without** `Authorization`. The storage origin is a different origin from the
   API (the benchmark serves both on one port: API as `localhost`, storage as `127.0.0.1`).

### 7.2 `GET /storage/{file_key}?signature={hex}`

`signature` = lowercase hex HMAC-SHA256 of the URL-decoded `file_key` under a per-process random
key. No token needed.

| Status | Body |
|---|---|
| 200 | The bytes; `Content-Type` = stored type, `Content-Length` = size. |
| 403 `INVALID_SIGNATURE` | Missing or wrong signature. |
| 404 `NOT_FOUND` | Valid signature, unknown key. |
| 405 `METHOD_NOT_ALLOWED` | Any method but GET. |

Every storage request is recorded in `storage_fetches` (§8.2), including whether it carried
credentials (it never should).

### 7.3 File keys

Scenario files keep the keys of the scenario's `files` map. Uploaded files get deterministic keys:
`h = sha256("<scenario id>:upload:<number of uploads so far>")` (hex), key =
`h[0:8]-h[8:12]-4h[13:16]-8h[17:20]-h[20:32]`, so reruns produce the same keys.

## 8. Admin port

A second listener for the benchmark harness only: plain HTTP on `127.0.0.1`, never reachable from
agent sandboxes. Every request needs `X-Admin-Token: <token>` (from `--admin-token`, the
`FRENCH_CFO_BENCH_ADMIN_TOKEN` environment variable, or 24 random bytes printed at start-up).
Errors use the envelope of §3 with codes `UNAUTHENTICATED` (401), `INVALID_PARAMETER` (400),
`NOT_FOUND` (404).

### 8.1 Endpoints

| Method and path | Request | Response `200` |
|---|---|---|
| `GET /__health` | — | `{"ok": true, "scenario": "<scenario id>"}` |
| `GET /__state` | — | Full state (§8.2). |
| `GET /__log` | — | Array of log records (§9). |
| `POST /__mark` | `{"label": "<non-empty string>"}` | The mark record. Later records carry this label as `mark`. |
| `POST /__reset` | `{"scenario": "<path>"}` optional | Reloads the scenario (default: the current path), clears all state and the log: `{"ok": true, "scenario": "<id>", "transactions": <count>}` |

Start-up prints one JSON line on stdout:
`{"ready": true, "apiPort": n, "adminPort": n, "adminToken": "…"}`.

### 8.2 `/__state`

| Key | Content |
|---|---|
| `scenario` | `{"id", "path", "seed" \| null, "as_of" \| null}` |
| `company` | The [Company](#company). |
| `mark` | Current mark label or `null`. |
| `transactions` | Every transaction as served by the API, plus `frozen: boolean`, and on every attachment's `document.file` the stored file's `sha256` and `size` (or `null`). |
| `uploads` | `[{"seq", "transaction_id", "attachment_id", "document_id", "file_key", "name", "mime_type", "size", "sha256"}]`; `seq` = log seq of the upload request. |
| `files` | `{file_key: {"name", "mime_type", "size", "sha256", "origin": {"scenario": "<relative path>"} \| {"upload_seq": n}}}` |
| `vat_returns` | `[{"status", "summary", "boxes"}]`, open CA3 returns as currently recomputed. |
| `fiscal_years` | As served. |
| `storage_fetches` | `[{"ts", "file_key", "status", "had_credentials"}]` |
| `counters` | `{"unauthorized_responses", "remote_logouts", "auth_attempts"}` (`auth_attempts` = number of `auth` log records). |

## 9. Write log

One record per API request that is not `GET`/`HEAD`, and per request under `/v1/auth/` (any
method), plus mark records. Records are kept in memory (`/__log`) and, with `--log <file>`, appended
to a JSONL file (which also gets `{"kind": "reset", "ts", "scenario"}` lines on reset). Reads and
storage requests are never logged.

Request body is read and decoded before any state changes; everything after is synchronous, so
`before`/`after` are exact.

### 9.1 Request record

| Field | Type | Meaning |
|---|---|---|
| `kind` | `"write"` \| `"auth"` | `auth` for paths under `/v1/auth/`. |
| `seq` | number | 1, 2, … since the last reset (shared with marks). |
| `ts` | timestamp | Server time. |
| `mark` | string \| null | Current mark label. |
| `method` | string | Upper-case method. |
| `path` | string | Path without query. |
| `query` | object | Query parameters. |
| `opId` | string \| null | Transaction id when the path is under `/v1/companies/{c}/transactions/{id}`. |
| `status` | number | Response status. |
| `accepted` | boolean | `200 ≤ status < 300`. |
| `errorCode` | string \| null | `error.code` of the response when it is an error, else `null`. |
| `force` | boolean | The request carried `override_lock=true`. |
| `body` | any JSON \| null | Body digest (§9.3). |
| `before` | snapshot \| null | Transaction snapshot before the request (§9.2), when `opId` is set. |
| `after` | snapshot \| null | Same, after. |
| `changed` | boolean | `before` and `after` differ (JSON comparison). |

Mark record: `{"kind": "mark", "seq", "ts", "label"}`.

### 9.2 Transaction snapshot

The transaction's complete mutable state:

| Field | Source |
|---|---|
| `validated`, `note`, `date`, `amount`, `direction`, `source`, `status`, `lock`, `issues` | As in [Transaction](#transaction). |
| `attachments` | `[{"id", "document_id", "kind", "purchase_invoice_id", "name", "sha256"}]` (`name` = file name, `sha256` of the stored bytes or `null`). |
| `lines` | Every line exactly as stored ([Line](#line)). |

### 9.3 Body digests

| Body | Digest |
|---|---|
| none | `null` |
| JSON on `/v1/auth/*` | `{"email"?, "factor"?, "passwordSent": bool, "codeSent": bool, "challengeSent": bool}` — secrets never logged. |
| other JSON object | Every top-level field except bulky ignored ones (`attachments`, `bank`). |
| other JSON value (array, number, string) | The value unchanged. |
| form-encoded | The fields (auth paths: digest as above). |
| multipart | `{"fields": {…text parts…}, "files": [{"field", "name", "size", "sha256", "mimeType"}]}` |

## 10. Scenario file (server input)

`scenario.json` (or a directory containing it). Loaded at start and on `/__reset`.

| Key | Type | Notes |
|---|---|---|
| `schema_version` | `2` | Required. |
| `id` | string | Scenario id. |
| `seed`, `as_of` | number, date | Optional; reported in `/__state`. |
| `api_token` | string, ≥ 8 chars | The only valid bearer token. |
| `company` | [Company](#company) | `id` must be a number. |
| `user` | [User](#user) without `company` | `id` must be a number. |
| `bank_accounts` | array | [BankAccount](#bankaccount). |
| `categories` | array | [Category](#category) without the derived `exemptions`, each with optional scenario-only `deductible_share` (number, default 1) and `exemption_required` (boolean, default `false`), never served. |
| `fiscal_years` | array | [FiscalYear](#fiscalyear). |
| `vat_returns` | array | `{"status": "filed" \| "to_file" \| "upcoming", "summary": VatReturnSummary, "boxes": object \| null}`. |
| `transactions` | array | [Transaction](#transaction), each with optional scenario-only `frozen: true` (never served). Ids must be unique numbers; `attachments` defaults to `[]`. Lines as served; a missing `tax.deductible` is computed at load (§6.2). |
| `purchase_invoices` | object | `{invoice_id: PurchaseInvoice}`. |
| `files` | object | `{file_key: "<path relative to the scenario directory>"}`; paths must stay inside it. |

The server serves scenario objects as stored (unknown keys pass through), except the
scenario-only keys above.

## 11. Glossary

| Term | Meaning |
|---|---|
| Transaction | A bank movement (`source: bank`) or manual expense (`source: expense`) to be booked. |
| Line | The booking of (part of) a transaction: category + tax treatment. |
| Category | Where a line is booked; maps to French chart-of-accounts (PCG) numbers and carries default VAT. |
| Tax treatment | Whether VAT applies to a line: taxable, exempt (with a reason) or out of scope. |
| Deductible VAT | VAT the company can reclaim; less than the VAT for some categories (travel, hotels). |
| Exemption reason | Why a line subject to VAT carries no French VAT (reverse charge, franchise…). |
| Overridden | A line tax set by hand; re-categorizing keeps it. |
| Validated | Reviewed and final; read-only until reopened. |
| Lock | Server-side refusal to edit (`period`: closed books; `manual`: accountant). |
| Frozen | Scenario flag: a validated transaction that cannot be reopened. |
| Document | A stored receipt or invoice; can be attached to several transactions. |
| Attachment | The link between one transaction and one document. |
| Purchase invoice | The platform's automatic reading of a supplier invoice. |
| VAT return | A periodic VAT filing (CA3 = monthly French VAT return form 3310-CA3). |
| Filed | A return already sent to the tax office; its figures are final. |
| Mark | A label the harness sets on the write log between agent turns. |

### Exemption reasons

| Value | Line kind | Meaning |
|---|---|---|
| `purchase_non_eu` | purchase | Supplier established outside the EU (reverse charge). |
| `purchase_eu` | purchase | Supplier in another EU country (reverse charge / intra-EU acquisition). |
| `purchase_non_eu_not_imported` | purchase | Goods bought outside the EU and not imported. |
| `purchase_not_applicable` | purchase | Supplier charges no VAT (e.g. French VAT franchise). |
| `purchase_no_document` | purchase | Justifying document lost. |
| `sale_non_eu` | sale | Customer outside the EU. |
| `sale_eu` | sale | Business customer in another EU country. |
| `sale_not_applicable` | sale | Sale outside the scope of French VAT. |

Which family applies follows from the line: a sale is an `in` line, or an `out` line with
`refund: true`.

### Document kinds

`purchase_invoice`, `sales_invoice`, `other`, `unclassified` (just uploaded, not classified yet).

### VAT return statuses

`filed` (sent, final), `to_file` (period over, can be filed now), `upcoming` (next return, not due yet).

### CA3 box keys

Official 3310-CA3 line numbers: `A1`, `A3`, `E1`, `E2`, `F2`, `08`, `9B`, `09`, `16`, `19`,
`20`, `22`, `23`, `25`, `26`, `27`, `28`, `32`. For lines with a base and a tax column, the bare
number is the base and `<n>_tax` the tax (`08_tax`, `9B_tax`, `09_tax`). Sub-lines:
`A3_eu`, `A3_non_eu`, `20_domestic`, `20_eu_reverse_charge`, `20_non_eu_reverse_charge`.
