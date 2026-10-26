---
name: compta
description: Run French bookkeeping workflows in Compta with the compta CLI — find what needs attention, match invoices to bank lines, audit VAT (including reverse charge on foreign suppliers), preview the monthly CA3, apply categorisation rules and run pre-closing checks. Use when the user mentions Compta or their books (« la compta »), their accounting operations, receipts/justificatifs, TVA/VAT, CA3, categories or closing the books.
---

# Bookkeeping in Compta with the `compta` CLI

`compta` is the command-line client of Compta, the accounting platform that holds the books. It
prints JSON when piped (always add `--json` anyway) and never prompts when not in a terminal.

## Ground rules

1. **Read freely, write only through reviewed plans.** Produce a plan file, summarise it for the
   user, wait for approval, then `compta apply <plan> --yes --report <plan>.report.json`.
2. **Never handle credentials.** Check with `compta login --check` (exit 0 valid, 3 not) before
   long runs. On exit 3, ask the user to run `compta login` in their own terminal (email,
   password and 2FA code), or `compta login --with-token` with a token they create in the web
   app. Never ask for, type or store their password or API token. `CREDENTIAL_STORE_LOCKED` means the
   keychain is locked (SSH, cron): relay the hint; don't suggest logging in again first.
3. **Branch on exit codes**: 0 ok · 2 usage or confirmation required · 3 auth · 4 not found ·
   5 rejected by Compta · 6 network/API changed (run `compta doctor --json`) · 7 plan partially
   failed, conflicts, or side effects (read the report).
4. **Findings are signals.** Explain them; let the user (or their accountant) decide anything that
   is a matter of judgement. Never fabricate documents or change amounts.

## Working with the user

Most users are small-business owners, not accountants or developers. Talk about their books, not
about commands: answer in their language (French if they write French), summarise in plain
words, and show command names only if they ask.

| They say | You do |
|---|---|
| "What needs attention?" / « Qu'est-ce qui cloche ? » | `compta todo --json`; overdue VAT returns first (deadlines), then counts by kind, then the few items worth a look. |
| "Update my books for September" | `todo`, then `receipts match`, `vat check` and `rules apply` with `--plan` for that month; present the changes as one list. |
| "Find my invoices / receipts" | Collect the PDFs with your own tools (their mailbox, supplier sites, Downloads) into one folder, e.g. `./receipts-2026-09`, then `compta receipts match <folder> --plan …`. No mailbox access? Ask them to drop the PDFs in a folder. |
| "Fix the VAT" | `compta vat check --plan …` for the period. |
| "Check my VAT return" | `compta vat summary --month …`; explain each difference with Compta's figures; remind them they file it in Compta. |
| "How much did I spend on …?" | `compta export --json` for the period (and `categories list`), add it up, show the lines behind the total. |
| "Year-end checklist" | `compta close-check --year …`. |

**Asking for approval:** before any `apply`, show a short numbered list (date, wording, amount,
what changes, why) and ask "Apply these N changes?". Run `compta apply <plan> --yes --report …`
only after an explicit yes, then say what was done and anything that was refused.

## Orientation

```sh
compta login --check --json             # is the session valid? when does it expire?
compta whoami --json                    # user, companies, active company, auth source
compta doctor --json                    # auth + API shape check
compta commands --json                  # every command, flag and example
compta schema todo-item                 # JSON Schema of an output (also: plan, finding, operation…)
compta categories list --search <text> --json   # category ids for --category / rules
```

## Recipes

**Morning worklist**
```sh
compta todo --json --limit 100
```
Items with `reasons[0].code == "OVERDUE_DECLARATION"` come first (`op: null`, see
`declaration`): tell the user, they have deadlines. Other items: `op` (normalized operation),
`reasons[]` (`MISSING_RECEIPT` — severity `error` means
> 150 € and a full invoice is required; `UNCATEGORIZED`; `UNVALIDATED`; `VAT_SUSPECT` with
`rule`; `RULE_MATCH`), optional `suggestion[]` (plan steps). `compta todo --plan todo.plan.json`
writes the suggestions as a plan.

**Attach invoices the user downloaded**
```sh
compta receipts match ./inbox --json                       # review matched / ambiguous / unmatched
compta receipts match ./inbox --plan receipts.plan.json    # confident matches only
compta apply receipts.plan.json --dry-run --json
```
For ambiguous files, show the candidates and ask; you can then write `attach` steps by hand.

**VAT audit (e.g. before the monthly return)**
```sh
compta vat check --from 2026-08-01 --to 2026-08-31 --json
compta vat check --from 2026-08-01 --to 2026-08-31 --plan vat.plan.json
compta vat summary --month 2026-08 --json
```
`REVERSE_CHARGE_SUSPECT` = a supplier established outside France booked with deductible French
VAT, or exempted with the wrong zone. Severity `error` = strong evidence (Compta's reverse-charge
code, an explicit reverse-charge invoice, a vendor in the rules file); plans contain only those.
Warnings (built-in vendor list, Compta's reading of the supplier country) need the user's review;
only then use `--include-warnings`. `vat summary` is an estimate, shown beside Compta's filed return
or draft.

**Rules**
```sh
compta rules init --json                                   # starter compta.rules.json from history
compta rules apply --unvalidated-only --plan rules.plan.json --json
```

**Pre-closing**
```sh
compta close-check --year 2025 --json      # meta.counts, findings[] (exit 0 even with findings)
```

**Single operations** (each still previews and needs `--yes` non-interactively)
```sh
compta ops get 10001 --json
compta ops set 10001 --category 77 --vat-exempt outside-eu --dry-run --json
compta ops attach 10001 ./invoice.pdf --yes --json
compta ops validate 10001 --yes --json
```

## Writing a plan by hand

```json
{
  "version": 1,
  "company": "999999",
  "createdAt": "2026-08-31T09:00:00.000Z",
  "createdBy": "agent: monthly VAT review",
  "steps": [
    { "id": "s1", "op": "10002", "action": "set",
      "set": { "category": 77, "vatExempt": "outside-eu" },
      "expect": { "vatAmount": 8 },
      "why": "Invoice shows a US supplier and 0.00 VAT (reverse charge)" },
    { "id": "s2", "op": "10005", "action": "attach", "file": "./inbox/invoice-aug.pdf",
      "why": "Total 48.00 EUR on 2026-08-01 matches the 2026-08-02 debit" }
  ]
}
```

- `vatExempt` says why there is no French VAT. On a **sale** (e.g. a B2B service invoiced to a
  company outside the EU): `outside-eu`, `inside-eu` or `not-applicable`. On a purchase: `outside-eu` / `inside-eu`
  (foreign supplier, reverse charge), `outside-eu-not-imported` (goods bought abroad, not
  imported), `not-applicable` (the supplier charges no VAT — e.g. a French micro-entrepreneur
  whose invoice says "TVA non applicable, art. 293 B du CGI"; fix this when Compta added 20 % VAT
  after a re-categorization, often reported as a side effect), `no-document` (receipt lost).
- Actions: `set` (`category`, `vatRate` in percent, `vatExempt`, `memo`), `attach` (`file`
  relative to the plan, optional `name`), `detach` (`attachmentId`), `validate`.
- Attach files must be receipts (`.pdf .png .jpg .jpeg .heic .webp`) inside the plan's directory or
  the current directory; otherwise `apply` refuses the whole plan (`UNSAFE_ATTACHMENT`, exit 2).
  Put the plan next to the documents rather than asking for `--allow-any-path`.
- Add `expect` with the values you saw (from `ops get --json`) so `apply` skips the step if
  someone changed the operation meanwhile. Use `"category": -1` for uncategorized.
- Split operations (several breakdowns) need `"breakdown": "<id>"` on `set` steps.
- Check it with `compta apply plan.json --dry-run --json` (exit 2 + `PLAN_INVALID` explains schema
  errors) before asking for approval.

## Refusals to expect (don't work around them silently)

- `LOCKED` (exit 5): the operation is locked in Compta; only an accountant can unlock it.
- `FILED_PERIOD` (exit 2): its VAT return is filed or the year is closed. Ask the user before
  `--allow-filed-periods`; such changes usually require a corrective return.
- `NOT_VALIDATABLE` (exit 2): fix the reported problems first.
- Editing a validated operation reopens it and validates it again (both appear in `changes`).
  `VALIDATED_READONLY` (exit 5): Compta refused to reopen it (often under accountant review);
  ask the user. `NOT_REVALIDATED`: the edit worked but the operation needs fixing before
  `compta ops validate`. A 403 on a write is never a login problem; don't ask the user to log in.
- `conflict` steps (apply exit 7): the operation changed since planning; re-plan.
- `notPlannable` in `vat check` / `rules apply` output: fixes apply would refuse (locked, filed
  period, no exemption possible…). Report them; don't try to force them through `ops set`.
- Zero VAT on bank fees, insurance, salaries or transfers is normal (`vatApplicable: false`):
  never add an exemption there.
- `MISSING_RECEIPT` skips transfers between accounts, capital, loans, subsidies, FX and tax
  settlements (`needsDocument: false` categories); use `--strict` only when asked.
- `sideEffects` on applied steps (exit 7): Compta changed something else too; report it to the user.

## Data notes

- Amounts are positive EUR with `direction` (`expense` / `income`); VAT rates are percent.
- `category: null` means uncategorized. `vatExemptReason`: `outside-eu`, `inside-eu`,
  `outside-eu-not-imported`, `not-applicable`, `no-document`, or a raw API value (sales).
- `attachments[].type` becomes `vendorInvoice` a little after an upload (classification is
  asynchronous).
- Use `--all` on lists when you need everything; the default limit is 50.
