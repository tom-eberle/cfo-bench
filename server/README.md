# Compta server

A small HTTPS server that implements the **Compta API** over a fully synthetic scenario. Compta is
a fictional French accounting platform; the benchmark's agents use the `compta` CLI (`cli/`)
against this server. The complete contract (endpoints, objects, errors, storage, admin port, write
log, scenario format) is [`API.md`](API.md). This file only says how to run and test it.

No dependencies, no build step: Node ≥ 22.18 runs the TypeScript directly (type stripping).

| File | Role |
|---|---|
| `src/main.ts` | HTTPS API listener, admin listener, ready line, 500 envelope |
| `src/compta.ts` | `FakeCompta`: request order, auth, routes, update rules, attachments, storage, admin state |
| `src/scenario.ts` | scenario loader (`schema_version: 2`) and types |
| `src/ca3.ts` | CA3 recomputation of open VAT returns (API.md §6.6) |
| `src/log.ts` | write log, transaction snapshots, body digests |

## Run

```sh
scripts/make-certs.sh          # once: local CA + localhost cert in .certs/ (gitignored)
node server/src/main.ts \
  --scenario scenarios/<id>    # directory with scenario.json, or the .json file itself
  --api-port 0 --admin-port 0  # 0 = any free port
  --cert .certs/server.pem --key .certs/server-key.pem \
  [--log run.jsonl]            # also append log records to a JSONL file
  [--admin-token <t>]          # or env CFO_BENCH_ADMIN_TOKEN; random if neither
```

When listening it prints one line on stdout:

```json
{"ready":true,"apiPort":53001,"adminPort":53002,"adminToken":"…"}
```

- API: `https://127.0.0.1:<apiPort>`. Clients use `https://localhost:<apiPort>`
  (`COMPTA_API_BASE`) with `NODE_EXTRA_CA_CERTS=.certs/ca.pem` and
  `Authorization: Bearer <scenario api_token>`. File downloads redirect to
  `https://127.0.0.1:<apiPort>/storage/…`, a different origin, followed without credentials.
- Admin: `http://127.0.0.1:<adminPort>` (`/__health`, `/__state`, `/__log`, `/__mark`,
  `/__reset`), every request with `X-Admin-Token`. Never reachable from agent sandboxes.

## Test

```sh
cd server && npm test     # node --test 'test/*.test.ts'
```

- `test/compta.test.ts`: the API on the mini fixture (`test/fixtures/mini`), without sockets
  (`FakeCompta.handle(Request)`), plus `main.ts` over real HTTP (admin port, 500 envelope).
- `test/scenario.test.ts`: the server on the benchmark scenario (`scenarios/atelier-lumen-s1`):
  CA3 boxes equal to the stored returns, loader validation, update rules on the scenario's data.
- `test/contract.test.ts`: the real `compta` CLI (`cli/dist/cli.js`, override `COMPTA_CLI_JS`)
  against the running server.

## Design notes

- Semantics are those of the benchmark's original server, renamed to this API: same lock and
  validation rules, same re-categorization side effect, same CA3 formulas (API.md §6).
- Request bodies are read before any state changes; everything after is synchronous, so the
  write log's `before`/`after` snapshots are exact.
- A sale line with VAT at a rate the CA3 has no line for (not 20 / 10 / 5.5 %) is left out of
  the CA3.
