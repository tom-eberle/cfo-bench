# compta-cli

Command-line client for **Compta**, the accounting platform of french-cfo-bench, built for humans
and AI agents. The binary is `compta`. It talks to the Compta API (`server/API.md` in this
repository): read the books, find what needs attention, and change them only through reviewed
plans.

compta-cli is a fork of an MIT-licensed CLI (see [LICENSE](LICENSE)), rewritten for the Compta
API.

## Build and run

Node.js 22.13 or newer.

```sh
cd cli
npm ci
npm run build                 # → dist/cli.js
export COMPTA_API_BASE=https://localhost:8443
node dist/cli.js --help
```

`COMPTA_API_BASE` is required for every command that calls the API (`API_BASE_MISSING`, exit 2,
otherwise). There is no built-in default.

## Log in

```sh
compta login                          # email + password (+ 2FA code) on a terminal
compta login --with-token < token.txt # an API token created in the Compta web app
COMPTA_SESSION=<token> compta whoami  # or pass the token in the environment
compta login --check                  # exit 0 valid, 3 missing or expired
```

Requests carry `Authorization: Bearer <token>`. The token is kept in the OS credential store
(macOS Keychain, libsecret) or, without one, in `~/.config/compta-cli/config.json` (mode 0600).
`COMPTA_CREDENTIAL_STORE=file` forces the file. `compta logout [--remote]` forgets it.

## Commands

| Group | Commands |
|---|---|
| Workflows | `todo`, `receipts match`, `receipts download`, `vat check`, `vat summary`, `rules init`, `rules apply`, `close-check`, `apply` |
| Resources | `ops list/get/set/attach/detach/validate/download`, `categories list`, `accounts list`, `export` |
| Auth | `login`, `logout`, `whoami` |
| Agents & diagnostics | `api`, `skill`, `commands`, `schema`, `doctor` |

`compta commands --json` describes every command, flag and example; `compta schema <type>` prints
the JSON Schema of each output and input; `compta skill` prints the guide for AI agents
(`skills/compta/SKILL.md`).

## Safety model

- Bulk changes are planned first (`--plan file.json`), reviewed, then executed with
  `compta apply file.json --yes`. Single edits (`ops set`, …) use the same executor.
- Every step re-reads the transaction, skips what is already done, refuses locked transactions and
  filed VAT periods or closed years (unless `--allow-filed-periods`), writes, and reads back to
  verify. Unexpected changes are reported as side effects (exit 7).
- Mutations without `--yes` exit 2 (`CONFIRMATION_REQUIRED`) when not in a terminal.
- File downloads follow the signed storage redirect without the token.

## Output and exit codes

JSON when stdout is not a terminal (or with `--json`), tables otherwise. Errors in JSON mode are
one line on stderr: `{"error":{"code","message","hint","status"}}`.

| Exit | Meaning |
|---:|---|
| 0 | ok |
| 1 | unexpected |
| 2 | usage, confirmation required, filed period |
| 3 | auth missing or expired |
| 4 | not found |
| 5 | rejected by Compta (locked, forbidden, …) |
| 6 | network, API unavailable, unexpected API shape |
| 7 | partial: a step failed, conflicted or had side effects |

## Environment

| Variable | Use |
|---|---|
| `COMPTA_API_BASE` | API origin (required) |
| `COMPTA_SESSION` | API token; overrides the stored one |
| `COMPTA_COMPANY` | Company id (else the profile's, or the only one) |
| `COMPTA_PROFILE` | Credential profile |
| `COMPTA_CREDENTIAL_STORE` | `file` to keep the token in the config file |

Config: `~/.config/compta-cli/`; cache (categories, purchase-invoice readings, PDF text):
`~/.cache/compta-cli/<schema version>/<API origin>/<company>/` (`--no-cache` bypasses it). A cached
category list missing a category the data references is read again from the API.

## Development

```sh
npm run check   # lint + typecheck + test + build
```

Tests run offline against `test/helpers/fake-api.ts`, an in-memory model of the Compta API.
See [AGENTS.md](AGENTS.md) for the layout and conventions.

## License

MIT. See [LICENSE](LICENSE).
