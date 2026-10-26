# AGENTS.md

Guidance for AI agents: agents **using** compta-cli to do bookkeeping, and agents **working on**
this directory.

## Using compta-cli

Read [`skills/compta/SKILL.md`](skills/compta/SKILL.md) first (`compta skill` prints it); it has
the recipes and how to talk to a non-technical user. The essentials:

- Always pass `--json` (JSON is also the default when stdout is not a terminal). Errors are one
  JSON line on stderr: `{"error":{"code","message","hint","status"}}`. Branch on the exit code
  (0 ok, 2 usage/confirmation, 3 auth, 4 not found, 5 rejected, 6 network/API shape, 7 partial).
- Discover rather than guess: `compta commands --json` (every command, flag, example),
  `compta schema <type>` (JSON Schemas), `compta categories list --search <text> --json` (ids).
- **Never change data directly in bulk.** Write a plan (`--plan file.json` on `todo`,
  `vat check`, `receipts match`, `rules apply`, or a hand-written plan following
  `compta schema plan`), show it to the human, and only then run `compta apply file.json --yes`.
  Every step needs a `why` a human can check.
- Mutations without `--yes` exit with code 2 (`CONFIRMATION_REQUIRED`) when not in a terminal —
  that is the safety net, not an error to work around silently.
- Run `compta apply plan.json --dry-run` before applying; keep the `--report` output as an audit
  log.
- Before a long run, call `compta login --check` (exit 0 valid, 3 missing or expired; silent
  unless `--json`). On exit code 3, ask the human to run `compta login` in their own terminal
  (or `compta login --with-token`, or to provide `COMPTA_SESSION`). Never ask for, type, print
  or store their password or API token yourself.
- On exit code 6 with `API_SHAPE`, run `compta doctor --json` and report it.
- Accounting judgement stays with humans: `vat check` and `close-check` findings are signals,
  not verdicts. Do not invent invoices, change amounts, or validate operations you have not
  verified.

## Working on this directory

```sh
npm ci
npm run check          # = lint + typecheck + test + build; must pass before every commit
node dist/cli.js …     # run the built CLI (needs COMPTA_API_BASE)
```

Layout:

```
src/cli.ts             process entry: real stdin/stdout/fetch → program.run()
src/program.ts         commander wiring, global flags, error → exit code
src/commands/*.ts      one file per command group; render.ts = human tables
src/api/client.ts      fetch wrapper: bearer auth, retries, concurrency, error mapping
src/api/compta.ts      company-scoped endpoints (pagination, updates, documents, VAT returns)
src/api/schemas.ts     zod: raw API shapes (loose) + normalized output shapes
src/api/normalize.ts   raw → normalized (percent VAT, short exemption names, CLI vocabulary)
src/auth/              config/profiles, credential stores, password login
src/plan/              plan types, diff/satisfaction checks, the step executor
src/workflows/         todo, receipts, vat, rules, close-check, vendor registry
src/pdf/extract.ts     PDF text + amount/date/VAT-number heuristics
src/output/            Output (stdout/stderr discipline), tables, errors, colours
test/                  vitest; test/helpers/fake-api.ts is an in-memory Compta API
```

The API contract is `../server/API.md`. The CLI's normalized output, plan format, flags, exit
codes and error JSON are its own contract: they do not follow raw API names (e.g. `wording`,
`breakdowns`, category `-1` for uncategorized).

**Naming.** The CLI's normalized output keeps its upstream field names (`breakdowns`, the
`ready_to_complete` status, `wording`, …): they are the CLI's own output contract, unchanged from
the open-source CLI it derives from, and renaming them would change what agents see. The server
API is independent and does not use them.

Conventions:

- TypeScript strict, ESM, Node ≥ 22.13; Biome for lint/format (`npm run format`).
- Runtime dependencies stay minimal (`commander`, `zod`, `unpdf`). Ask before adding one.
- Every command has 1–3 real examples (`withExamples`), human output via a renderer, and the same
  data as JSON. Data → stdout, everything else → stderr through `Output`.
- New output shapes get a zod schema and an entry in `compta schema` (`src/commands/meta.ts`).
- Every mutation goes through the plan executor (`src/plan/apply.ts`): re-read, skip if
  satisfied, write, re-read to verify.
- Tests run offline against `FakeCompta`. When the API surprises you, encode the behaviour in the
  fake and add a test.
- Fixtures are synthetic (company `999999`, invented merchants). Never commit real data, tokens
  or passwords.
