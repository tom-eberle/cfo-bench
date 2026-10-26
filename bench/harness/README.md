# bench/harness — running agents against the fake Compta server

The harness runs each (agent, task, repeat) under the same conditions: one fake Compta server per
batch, a fresh sandboxed run directory per attempt, the compta CLI built from `cli/`, the compta skill, the
two-phase approval protocol, and a run record that graders read. DESIGN.md §5–§7 and §10–§11
are the contract; this file says how the code implements it.

```
uv run french-cfo-bench prepare-runtime       # build cli/ and copy it to ~/.cache/french-cfo-bench/runtime
uv run french-cfo-bench selftest                   # check the sandbox (mini fixture scenario)
uv run french-cfo-bench run --agents all --repeats 3 [--tasks cat-sep,rc-aug] [--out runs/<ts>] [--seed 1]
uv run french-cfo-bench run --agents scripted-null,scripted-whoami --repeats 1   # free pipeline check
```

`--agents all` = `claude-opus`, `claude-sonnet`, `claude-haiku`, `codex`, `codex-luna`. `minimal` and the
`scripted-*` agents run only when named. Rerunning with the same `--out` resumes.

## Modules

| File | Role |
|---|---|
| `runtime.py` | Builds the CLI in `cli/` (`npm ci` when `node_modules` is missing or was installed from another lockfile, stamp `node_modules/.french-cfo-bench-lock.sha256`; then `npm run build`; `FRENCH_CFO_BENCH_CLI_SRC` overrides the source dir) and copies `dist/`, `package.json`, the production `node_modules/` (its `dependencies`: commander, unpdf, zod) and `skills/` to `~/.cache/french-cfo-bench/runtime/` (`FRENCH_CFO_BENCH_CACHE_DIR` moves the cache, e.g. one per checkout), with `ca.pem` (from `scripts/make-certs.sh`; the CA key stays in the repo) and `clock-shim.mjs`. `runtime.json` records `tree_sha256` (hash of every build input: `cli/src`, `cli/skills`, `cli/package.json`, `cli/package-lock.json`, `cli/tsconfig.json`, `cli/tsup.config.ts`), `cli_sha256` (the bundle) and the skill, shim and CA hashes; rebuilt when any input changes (the pinned agent CLIs, `claude-code/` and `codex/`, are kept). Agents read only this copy, never `~/Developer`. |
| `server.py` | `FakeServer` context manager: `node server/src/main.ts --api-port 0 --admin-port 0 …`, admin token random per batch (env `FRENCH_CFO_BENCH_ADMIN_TOKEN`, copy in `.state/admin-token`, git-ignored; never in a run dir, argv or agent env). `reset()`, `state()`, `log()`, `mark()`, `health()`. Killed (process group) on exit. |
| `sandbox.py` | Run directory, `compta` wrapper, logged-in compta config, mailbox copy, seatbelt profile, environment allow-list, process-group execution, `selftest()`. |
| `agents/` | `claude_code.py`, `codex.py`, `minimal.py` (off), `scripted.py` (tests, oracle/null/reckless plumbing); common interface in `base.py`. |
| `protocol.py` | `run_one()`: one attempt under the two-phase protocol; `TaskSpec` wraps the dicts from `bench/tasks.py`. |
| `scheduler.py` | `Batch`: seeded interleaved schedule, usage-limit pauses, retries, resume, `progress.json`, `manifest.json`. |
| `record.py` | `load_record(run_dir)`: everything a grader needs, as plain Python. |
| `ratelimit.py`, `pricing.py`, `prices.toml` | Limit classification / reset parsing; API-equivalent cost. |

## The sandbox (per attempt)

`$TMPDIR/french-cfo-bench/<run-id>-a<attempt>/` (real path, `/private/var/folders/…`):

```
work/          agent cwd: work/<dir>/ = the task's mailbox files; the skill (below)
home/          HOME for the agent and for compta; home/.config/compta-cli/config.json = logged in
bin/           compta (wrapper), node → the harness's Node, jq → /usr/bin/jq
agent-config/  CODEX_HOME (Codex) / CLAUDE_CONFIG_DIR in token mode (Claude)
tmp/           TMPDIR
sandbox.sb     seatbelt profile (also copied into the run record)
```

**`bin/compta`** is a `/bin/sh` script with absolute paths: it unsets `COMPTA_SESSION` /
`COMPTA_COMPANY`, sets `COMPTA_API_BASE=https://localhost:<apiPort>`, `NODE_EXTRA_CA_CERTS=<runtime>/ca.pem`,
`COMPTA_CREDENTIAL_STORE=file` (never the macOS keychain), `COMPTA_PROFILE=bench`,
`HOME`/`XDG_CONFIG_HOME`/`XDG_CACHE_HOME` inside the run dir and `FRENCH_CFO_BENCH_NOW=<as_of>`, then
`exec node --import <runtime>/clock-shim.mjs <runtime>/dist/cli.js "$@"`. The config file is
`{"activeProfile":"bench","profiles":{"bench":{"session":…,"source":"token","companyId":"…"}}}`
(`session` = the scenario's `api_token`), mode 600, like the CLI's `test/helpers/run.ts`.

**Skill.** Claude: `work/.claude/skills/compta/SKILL.md`, a verbatim copy of the runtime's
`skills/compta/SKILL.md`, plus `work/.claude/settings.json` (see Claude below). Codex:
`work/AGENTS.md` = the same file with its YAML frontmatter (name/description) stripped, body
verbatim; Codex loads AGENTS.md as instructions, where the frontmatter would only be noise.

**Environment allow-list.** Agent processes get exactly `PATH=<run>/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
`HOME=<run>/home`, `TMPDIR=<run>/tmp/`, `TZ=Europe/Paris`, `LANG=LC_ALL=fr_FR.UTF-8`, plus the
agent's own variables: Codex `CODEX_HOME`; Claude `CLAUDE_CONFIG_DIR`, `DISABLE_AUTOUPDATER=1`
(no self-update mid-batch) and, in token mode, `CLAUDE_CODE_OAUTH_TOKEN`. Nothing is inherited
from the harness (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `COMPTA_*` included); a test asserts the
exact set of names an agent process sees.

**Seatbelt profile** (`sandbox-exec -f sandbox.sb …`, generated per run; later rules win):

| Rule | Why |
|---|---|
| `(allow default)` | Agents need the normal OS (dyld, system frameworks, `/usr/bin` tools, DNS, TLS to their model API). Everything below narrows it. |
| deny `file-read*` under `$HOME` | The repo (truth, scenarios, harness, other results), `~/Developer`, `~/.claude`, `~/.codex`, `~/.ssh`, `~/.config`, `~/Library` are unreadable. |
| deny `file-read*` under `$TMPDIR/french-cfo-bench` and under the user's temp dir (`/private/var/folders/…/T`) | Other runs' directories; files the harness or other programs leave in the temp dir. |
| deny `file-read*` on the shared scratch dirs `/private/tmp`, `/private/var/tmp`, `/Users/Shared` (stat of the dir itself allowed) | World-writable places other programs (and, before this profile, earlier runs) leave files in. |
| deny `file-read*` on the scenario being served (the batch's `inputs/`) and the record dir | Wherever `--out` lives (it may be outside `$HOME`). |
| allow reads: the run dir | The agent's own files. |
| allow reads: the Node prefix (`~/.nvm/versions/node/v22.21.1`) | `node` for the compta CLI, and both agent CLIs are global npm packages there (`@anthropic-ai/claude-code`, `@openai/codex` incl. its native binary). Narrower than the whole `~/.nvm`. |
| allow reads: `~/.cache/french-cfo-bench/runtime` | The compta CLI runtime copy, CA cert, clock shim. |
| allow reads: the agent's install dir (resolved with `which` + symlinks) | Explicit even though it is inside the Node prefix. |
| allow `file-read-metadata` on every ancestor of the run dir and of the allowed dirs (`$HOME`, `~/.nvm`, the temp dir, `/tmp/a/b` for `TMPDIR=/tmp/a/b/c`, …) | `realpath`/`stat` while resolving paths (node's `realpathSync` lstats each one: without this a `TMPDIR` deeper than `/tmp/x` broke `compta ops attach`); no listing, no reading. |
| **deny `file-write*` everywhere** (`subpath "/"`), then allow `/dev` (null, ttys, ptys), the run dir and the agent's own entries | No shared scratch at all: `/tmp`, `/var/tmp`, `/Users/Shared`, `/Library/Caches`, `/private/var/OOPJit`, `/private/var/db/{mds,DiagnosticsReporter,…}` (the world-writable dirs found with `find -x <root> -maxdepth 2 -type d -perm -0002`), the user's `T`/`C`/`0` dirs, admin-writable `/Applications`, `/usr/local`: nothing a later run could find. A cross-run canary test checks every one of them. |
| Claude only: read+write its private `CLAUDE_CODE_TMPDIR` (`/private/tmp/dbc-<hash of run id>`, created per run, removed after) | Claude Code ignores TMPDIR and would otherwise use the machine-wide `/tmp/claude-<uid>`; its IPC sockets live there too, so the shared `/tmp/cc-socks` is no longer opened. |
| Claude keychain mode only: read+write `~/.config/french-cfo-bench/claude-config` (or `$FRENCH_CFO_BENCH_CLAUDE_CONFIG_DIR`); **read-only** `~/Library/Keychains/login.keychain-db` (the file only, not the dir); `/usr/bin/security` executable | See Claude Code below. |
| deny `process-exec` of `/usr/bin/security` (every other case) | The agent can't query the keychain. |
| deny `network-outbound` to `localhost:*`, allow `localhost:<apiPort>` | The admin port (and anything else on loopback) is unreachable even with the token; the fake API port is the only local service. The server binds `127.0.0.1` only, so LAN/Tailscale addresses don't reach it either. |
| deny `process-info*` on other processes | The agent can't read other processes' argv/env (`ps`/`pgrep` see nothing), e.g. the server's scenario path. |

Verified on this machine (macOS 15.7.2): Codex CLI 0.163 runs fully inside the profile with
`--dangerously-bypass-approvals-and-sandbox` (nested seatbelt is refused by macOS, so Codex's own
sandbox can't be used), reaches the model API, and its `compta` calls reach the fake server.
Claude Code 2.1.289 runs inside it in keychain mode (pristine config from the template,
read-only keychain file, global write deny): a real Haiku turn answered through `compta`.

**Self-test** (`selftest()`, before every run, recorded in `selftest.json`; a failure aborts the
batch): inside the profile, with the agent's environment, these must fail: `cat` truth.json,
`ls` the repo, `cat .state/admin-token`, `ls` the other-runs dir, `ls ~/.codex ~/.claude ~/.ssh
~/Developer`, `touch ~/…`, `curl` the admin port on 127.0.0.1 and localhost, writing a canary
into every shared writable dir above and the user's T/C/0 dirs, listing `/tmp`, `/var/tmp`,
`/Users/Shared` and the user's temp dir, running `/usr/bin/security` (except keychain mode); and these must
succeed: `compta whoami --json` (returns the scenario's company) and `env` showing only
allow-listed names.

**Process groups.** Every agent process starts in its own session; at the end of a turn (normal
exit or the timeout, 15 min default, `--timeout` / task `limits.timeout_s`) the whole group gets
SIGTERM, then SIGKILL after 2 s, before the harness moves the log marker. Limitation: a process
that calls `setsid()` itself would escape the group.

Not prevented: general internet access (the agents need their model APIs; seatbelt can't filter
by host name). The only credential in the sandbox is the bench token of the fake server, and the CLI has no default API address: `COMPTA_API_BASE` points at the fake server.

## Agents

All share `run_turn(sandbox, prompt, session, turn, record_dir, timeout_s) -> TurnResult`:
`final_text`, `session_id`, raw `transcript`, `usage`, `cost_usd`, `model_requests`,
`tool_calls`, `num_turns`, `duration_s`, `exit_status` ∈ {ok, timeout, max_turns, agent_error,
rate_limited, infra_error}, `rate_limit_reset`, `resolved_config`. Limits and errors are
classified only from structured events of the CLIs, never from the agent's prose.

`usage` field names (per turn in `turns[]`, summed in run.json `usage`): `input_tokens`
(uncached input, cache writes included), `cached_input_tokens` (cache reads), `output_tokens`
(reasoning included), `reasoning_tokens` (subset of output; Codex only, else null),
`cache_write_tokens` (subset of input; null when the agent doesn't report it). Unknown costs
are `null`, never 0.

**Common budget (same for every agent).** 15 min wall clock per conversation turn and
**40 model requests per conversation turn** (`STEP_BUDGET`). The unit is Claude Code's own:
`--max-turns` counts one turn per assistant message, i.e. per model response. Verified on a
recorded Claude stream (Haiku probe): content blocks arrive as separate `assistant` events
sharing a message id; `result.num_turns` = 8 = distinct message ids = 7 tool-using responses +
the final answer; one response can carry several tool calls. Codex has no such flag, so the
harness enforces it (`StepMonitor`): while Codex runs it reads its session log (one
`token_count` event per model response, deduplicated by the cumulative total; the log and the
`--json` stream are written incrementally — checked on a live run) and, once the 40th response's
tool calls have finished (or 1.5 s pass with nothing running), kills the process group →
`max_turns`, as Claude Code reports `error_max_turns`. If the 41st response comes back within
that window its tool calls may start before the kill (at most one extra request; it then shows
in `model_requests` = 41). The minimal agent loops at most 40 times. Scripted agents have no
model (`model_requests` null).

Counters, recorded separately per turn and summed in run.json (null if any turn's is unknown):
- `model_requests` — model responses: Claude = distinct assistant message ids in the stream
  (Claude's own `result.num_turns` kept as `extra.claude_num_turns` for audit); Codex =
  `token_count` events of the session log for this turn; minimal = API calls.
- `tool_calls` — tool executions the model requested (any tool): Claude = `tool_use` blocks;
  Codex = non-message items (command_execution, file_change, mcp_tool_call, web_search,
  todo_list), including ones killed before completing; scripted = `ctx.sh` commands.
- `num_turns` = `model_requests` (one meaning everywhere).

### Claude Code (`claude_code.py`)

`claude -p --output-format stream-json --verbose --model <id> --permission-mode bypassPermissions
--tools Bash,Read,Write,Edit,Glob,Grep --strict-mcp-config --mcp-config '{"mcpServers":{}}'
--setting-sources project --max-turns 40`, prompt on stdin; turn 2 adds `--resume <session_id>`. A turn that reports
success with more model responses than the budget is `max_turns` anyway (stand-in test).

- Auth, `--claude-auth token|keychain` (default `token`; fails closed: no token → no run):
  - **token** (recommended): `~/.config/french-cfo-bench/claude-oauth-token` from `claude setup-token`
    → `CLAUDE_CODE_OAUTH_TOKEN`, a fresh empty `CLAUDE_CONFIG_DIR=<run>/agent-config` per run,
    token redacted from every record file. No keychain access, `/usr/bin/security` not executable.
  - **keychain** (opt-in): `CLAUDE_CONFIG_DIR=~/.config/french-cfo-bench/claude-config`, whose login
    lives in the macOS login keychain under an item named after that path (so the path never
    changes). The dir is made **pristine around every run**: wiped and restored from
    `~/.config/french-cfo-bench/claude-config.template/` (0700, outside every allow-list) before the
    run, and after it (a hash list of everything the run left there is kept as
    `claude-config-after.json`, its session transcript copied to `claude-projects/`). The
    template is minimal: `.claude.json` = `{}` — verified that Claude Code logs in (auth status,
    then a real Haiku turn through `compta`) with nothing else: the OAuth state is in the keychain
    item and account details are re-fetched. Nothing is copied back from a run. Keychain: the
    `login.keychain-db` file is readable, **not writable** (verified enough to log in; no other
    keychain file or the dir listing is reachable). Claude Code reads its item by running
    `/usr/bin/security` (verified: denying that exec logs it out), so `security` stays executable
    in this mode — and an agent could use it to read other items of the login keychain whose ACL
    trusts that tool. Seatbelt can't tell Claude's exec from the agent's, hence opt-in. Not
    verified: whether a token refresh needs to write the keychain file (it can't be exercised
    without modifying the keychain); if it does, the refreshed token isn't saved and the bench
    login may need a new `/login` — visible as `infra_error` runs, not silent.
  - `FRENCH_CFO_BENCH_CLAUDE_CONFIG_DIR=/abs/path` replaces the keychain-mode config dir, e.g. a
    benchmark config dir that is already logged in elsewhere (the keychain item follows the
    path, so it is used as given: `~` is expanded, symlinks are kept; a relative path is an
    error). Unset: `~/.config/french-cfo-bench/claude-config`. The template stays at
    `~/.config/french-cfo-bench/claude-config.template/`, and the same reset, preflight and
    sandbox rules apply to the dir it names. Use a dir that holds nothing but that login: it
    is wiped around every run. Its path is written into the run records
    (`claude-config-after.json`), which are never published.
  - Preflight (keychain mode) also refuses a config dir with `CLAUDE.md`, `.mcp.json`, non-empty
    `skills/agents/commands/plugins/hooks/output-styles/rules`, forbidden settings or MCP servers
    after the reset.
- Project settings (`work/.claude/settings.json`): Claude Code 2.1.289 loads **bundled skills**
  (deep-research, design, dataviz, code-review, claude-api, …) and three **built-in plugins**
  (`cc-plugin-agents-md`, `-telemetry`, `-plugin-authoring`) even from an empty config dir. They
  are turned off — `disableBundledSkills: true`, `skillOverrides: {design: off, doctor: off}`,
  `enabledPlugins: {…@builtin: false}` — plus `autoMemoryEnabled: false`. Verified on the
  init event: tools = exactly the seven, skills = `["compta"]`, plugins = `[]`, MCP servers = `[]`.
- Post-turn assertion on the `system/init` event: tools = exactly the seven (any other tool,
  e.g. WebSearch, WebFetch, Agent/Task or an `mcp__*` tool, fails; it is also listed in
  `always_on_tools`), no MCP server, no plugin, no skill but `compta`, no custom subagent type,
  model = requested. The built-in subagent types (`claude`, `general-purpose`, `Explore`, `Plan`,
  `statusline-setup`) are listed but unusable without the Agent tool. A failed assertion makes
  the run `infra_error` (a configuration error, not an agent result: the attempt is not final,
  the batch aborts, and the run is redone once the harness is fixed).
- Rate limits: `rate_limit_event` with status `rejected` (`resetsAt`), assistant `error:
  "rate_limit"`, `api_error_status: 429`, or an `is_error` result whose CLI text is a limit
  message. `error_max_turns` → `max_turns`; `authentication_failed` / "Not logged in" → `infra_error`.
- Cost: `result.total_cost_usd` is cumulative over a resumed session; each turn records the increase
  since the session's previous turn (`extra.cost_cumulative_usd` keeps the raw value).
- After the run, the session's `projects/<cwd-slug>/` directory is moved from the config dir into
  the record (`claude-projects/`), so later runs can't read earlier transcripts.

### Codex (`codex.py`)

Fresh `CODEX_HOME=<run>/agent-config` per attempt: `auth.json` (0600) copied from
`~/.config/french-cfo-bench/codex-home/auth.json` if that dedicated bench login exists, else from
`~/.config/french-cfo-bench/codex-auth-master.json` (created once from `~/.codex/auth.json`). After
every turn a changed run `auth.json` (token refresh) is copied back to that master — never to
`~/.codex`. `config.toml`:

- `model = "gpt-6.1-sol"`, `model_reasoning_effort = "high"`, `approval_policy = "never"`,
  `sandbox_mode = "danger-full-access"` (the outer seatbelt is the boundary);
- `web_search = "disabled"`, `[skills.bundled] enabled = false` (Codex otherwise installs and
  advertises imagegen, skill-creator, skill-installer, openai-docs, review-agent), and features
  off: apps, plugins, remote_plugin, browser_use(_external), computer_use, image_generation,
  multi_agent(_v2), memories, hooks, tool_suggest, skill_search, skill_mcp_dependency_install,
  in_app_browser, goals — so neither agent gets web search, connectors, images or bundled skills;
- `allow_login_shell = false`: Codex otherwise runs commands with `zsh -lc`, whose
  `/etc/zprofile` (`path_helper`) puts `/usr/local/bin` (Homebrew) ahead of the run's `bin/`;
- `check_for_update_on_startup = false`, `[history] persistence = "none"`.

`codex exec --json -o <run>/codex-last-message-N.txt --skip-git-repo-check --strict-config
--dangerously-bypass-approvals-and-sandbox -C <work> -` with the prompt on **stdin** (from a
file), stdout/stderr to files; turn 2: `codex exec resume <thread_id> … -` (cwd = work).
`--strict-config` makes an unknown key fail loudly after a Codex upgrade. Preflight checks the
version (≥ 0.159) and that every disabled feature really is off (`codex features list`).

- Parsed: `thread.started`, `item.started`/`item.completed` (agent_message, command_execution,
  file_change, …), `turn.completed` usage, `error` / `turn.failed`.
- Budget accounting fails closed: the session log is in `CODEX_HOME`, which the agent's commands
  can write, so the monitor stops the turn as `infra_error` (`extra.budget_unknown`) if the log
  vanishes, shrinks or gets an unparsable line, or never appears while the event stream (owned by
  the harness) shows activity; after the turn, the log must show at least as many responses as
  the event stream proves (an agent message after a finished tool call, or completing after one,
  needs a new response) and at least the tokens `turn.completed` reports. A completed turn over
  the budget is `max_turns` (overflow is checked before completion).
- Usage: summed per model request from the session log's `token_count` events
  (`last_token_usage`) for this turn — exact also for a stopped turn. **`turn.completed` usage is
  cumulative over the thread** (a resumed turn reports turn 1 + turn 2, verified with a real
  two-turn probe); it is kept as `extra.reported_usage_cumulative` and the difference is
  cross-checked (`extra.usage_crosscheck_ok`) and used as fallback.
- Cost: per model request from the same `token_count` events, priced
  with `prices.toml` (gpt-6.1-sol, 2026-10-19: $2.00 input, $0.10 cached, $2.50 cache writes,
  $10.00 output per 1M; > 272K-input requests at the long-context rates). The session's
  `model_context_window` is 475,000, so long-context pricing can apply.
- `resolved_config`: Codex version, argv, the config.toml, enabled feature flags, and from the
  rollout file: `session_meta`, each `turn_context` (model, effort, approval and sandbox policy),
  the instruction blocks injected (by tag). Assertion: config.toml = the bench config, no
  disabled feature on, model and effort as requested, no `skills_instructions`/apps/plugins
  block, no MCP tool call (the built-in empty resource listings aside), no web search or image
  generation (`--json` items or rollout calls). A failure is `infra_error`, as for Claude.
- Rate limits: `error`/`turn.failed` messages matching a usage/rate-limit pattern
  (reset parsed from "try again at …", "in N minutes", epoch fields); 401/403 → `infra_error`.
- Known asymmetry: Codex's native tools still include its collaboration tools
  (`spawn_agent`, …), `request_user_input`, `view_image`, `apply_patch`, `exec_command`,
  `write_stdin`, `list_mcp_resources` (no MCP servers configured). They stay allowed. The Claude
  agents get exactly Bash/Read/Write/Edit/Glob/Grep/Skill. Each product's own minimal tool set is
  benchmarked "as shipped"; the full list (as reported by the model) is in the probe fixture.

### Minimal agent (`minimal.py`)

~150 lines: Anthropic SDK, one `bash` tool (runs through the same sandbox and env allow-list),
`claude-opus-5-5`, history kept for turn 2, skill text as the system prompt. Off by default;
refuses to run unless `ANTHROPIC_API_KEY` is set **and** `--allow-paid-api` is passed. Optional
dependency: `uv sync --extra minimal`. It is unpriced in `prices.toml` (its cost is recorded as `null`).

### Scripted agents (`scripted.py`)

`ScriptedAgent(id, policy)`; `policy(ctx) -> final text`, where `ctx.sh(cmd)` runs a command in
the same sandbox/env (so writes go through the real wrapper and server), `ctx.say()`,
`ctx.write_file()`, `ctx.turn`, `ctx.task`, `ctx.state` (kept across turns). Raise
`ScriptedRateLimit` to simulate a usage limit. `register_agent()` makes a policy selectable with
`--agents`. Examples: `scripted-null`, `scripted-whoami`. The graders' oracle / null / reckless
policies plug in here.

## Protocol (`protocol.py`)

`run_one()`: `POST /__reset` (task scenario) → build sandbox → self-test → turn 1 with the task's
`turn1_prompt` (from `bench/tasks.py`: date context + prompt + standing instruction for write
tasks) → group killed → **proposal frozen** (turn-1 final text + every `*.json` under `work/`
except harness files, and every text deliverable `*.md`/`*.txt`/`*.csv` the agent wrote, up to
512 KiB each, copied and hashed into `proposal/`) → `POST /__mark {"label":"turn-2"}` →
turn 2 with `turn2_prompt` (« OK, vas-y, j'approuve le plan. » / "OK, go ahead, I approve the
plan."), sent whatever turn 1 contained unless turn 1 was rate-limited or an infra error → collect.
Read-only tasks are one turn.

Record (one directory per attempt, `<out>/<run-id>/attempts/<n>/`):

| File | Content |
|---|---|
| `run.json` | task, agent (id, model, version), repeat, attempt, scenario path + sha256 + `as_of`, runtime `tree_sha256` + `cli_sha256`, provided files (sha256 → name), sandbox env names + profile hash, self-test summary, per-turn results (status, usage, cost, timing, resolved config, errors), `finals`, combined `exit_status`, total usage/cost, proposal manifest, the turn-2 mark, `workspace_files`, `modified_inputs`, timings |
| `transcript.normalized.jsonl` | `{turn, type: message/command/tool/final, …}` for every agent; `command` and `tool` events carry the model-visible `output` (Claude's tool_result content for Bash, Read, Grep, Glob, Write, Edit; Codex's aggregated output / tool result), whole up to 200,000 characters (`truncated`, `output_chars` beyond); PDFs/images given to the model as `[document application/pdf sha256=…]` |
| `turn-N.claude.jsonl` / `turn-N.codex.jsonl` (+ stderr) | raw event streams |
| `prompt-turn-N.txt` | exactly what the agent received |
| `state.json`, `log.json` | `/__state` and `/__log` after the run |
| `proposal/` | `final.txt`, `files/…`, `manifest.json` (hashes: `files` = plan JSONs, `texts` = text deliverables; a file redacted afterwards keeps `sha256_before_redaction`). `load_record` refuses a file whose hash no longer matches |
| `workspace/` | `work/` at the end minus unchanged harness files (mailbox copy, skill, settings) |
| `selftest.json`, `sandbox.sb` | sandbox evidence |
| `codex-sessions/`, `claude-projects/` | the agent's own session files |

`record.load_record(dir)` returns these as the fields of `bench.graders.rundata.RunData`
plus `tool_outputs` (every tool call, shell or not, with its output)
(`finals`, `messages`, `tool_calls`, `proposal_text`, `proposal_plans`, `provided_files`,
`final_state`, `log`, `exit_status`, …).

## Frozen inputs (`inputs.py`)

Before anything runs, the scenario must match its `MANIFEST.sha256` exactly: every listed file
present with its hash, no other file (`.DS_Store` aside, never copied); the source is checked
before it is archived, the archive at every start and resume, and the graders check it again.
At batch start the exact grading inputs are copied to `<out>/inputs/`: `scenario.json`,
`truth.json`, `MANIFEST.sha256`, `files/`, `mailbox/`, `tasks/*.yaml`, `tasks.resolved.json`
(each task as run: selected files, prompts) and `hashes.json` (sha256 of every file). The batch
then **runs from the archive** (server reset and mailbox copies read `inputs/`), so served and
graded inputs are the same bytes; a resumed batch keeps its archive even if the repo's scenario
or tasks changed (warning), refuses tasks that aren't archived, and refuses an archive whose
files no longer match `hashes.json`. Every run.json has `inputs` {`hashes_sha256`, `files`
(scenario.json, truth.json, MANIFEST.sha256, the task's yaml → sha256), `task_resolved_sha256`}.

## Redaction

Private strings (the subscription account's email, which Claude Code puts in the model context)
are discovered from the run's **own** auth config before it is reset (`agent.private_strings`:
Claude token mode = the fresh per-run `.claude.json`; keychain mode = the shared dir before its
reset; Codex = the email in the run's `auth.json` id_token), merged with earlier discoveries kept
in `~/.config/french-cfo-bench/private-strings.json` (0600), and replaced by `<redacted-email>` in
every text file of the record. The Claude token is replaced by `[REDACTED]`.

## Scheduler (`scheduler.py`)

Per agent, a seeded shuffle of (task, repeat); agents interleaved round-robin (order seeded). ONE
server per batch, runs sequential. After each attempt:

- `rate_limited` → attempt kept, the agent's subscription paused until the parsed reset (+60 s)
  or an exponential backoff (5 → 10 → 20 → 30 min cap); other subscriptions continue; the run is
  redone later from a fresh state (server reset, new sandbox and caches). The three `claude-*`
  agents share the `claude` subscription and pause together.
- `infra_error` → retried up to 2 times, then final.
- self-test failure or hermeticity failure → batch aborted.
- otherwise final: `<out>/<run-id>/run.json` points to the attempt (`record_dir`), lists the
  discarded attempts, `attempt_dirs`, and `cost_usd_all_attempts` (null if any is unknown).

Every attempt dir is self-contained (run.json with usage/cost/exit_status/counters, state.json,
log.json, the transcripts) and gradable on its own. Its run.json says what became of it:
`final: true` (the graded attempt), or `final: false` + `replaced_by: <n>` +
`replacement_reason` (rate_limited, infra_error, interrupted, batch aborted). Discarded
attempts keep their safety events and spend; `record.list_attempts(run_dir)` lists them.

`progress.json` (after every attempt): completed / total / failures / remaining, current run,
`paused: usage limit until HH:MM` per subscription, per-agent attempts, rate-limited attempts,
tokens and spend (all attempts, discarded ones included). `manifest.json`: agent versions and
models, the CLI's `tree_sha256` + bundle hash + version (key `cli`), harness git commit (+ dirty flag), Node/Python, OS, TZ,
locale, seed, repeats, tasks, scenario `MANIFEST.sha256` and `scenario.json` hashes, dates (and
`resumed` timestamps).

## Tests

`uv run pytest tests/test_harness_*.py` (sandbox tests skip outside macOS or without the pinned
build): self-test passes and catches a broken profile; env allow-list exact; process group
killed on timeout and at turn end; scripted writes in turn 1 land before the marker and in turn
2 after it; proposal freezing; read-only single turn; mailbox copy; scripted timeout; adapters
parse genuine Codex streams (two-turn resume probe, whoami probe, rollout token counts) and a
genuine Claude not-logged-in stream, plus synthetic Claude/Codex streams in the same formats
(success, usage limit, max turns, leaky init); reset-time parsing; scheduler interleaving,
shared-subscription pause, retry with the attempt kept, resume.
