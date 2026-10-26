"""Codex CLI adapter (`codex exec --json`), DESIGN.md §7.

Per run: a fresh `CODEX_HOME=<run>/agent-config` holding only a copy of the bench auth file and
the minimal `config.toml` below; the compta skill as `work/AGENTS.md` (SKILL.md body verbatim,
YAML frontmatter stripped). Codex runs with `--dangerously-bypass-approvals-and-sandbox` inside
the outer seatbelt sandbox (nested seatbelt is refused by macOS). The prompt always goes through
STDIN (never argv), output always to files.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from .. import paths, pricing, ratelimit
from ..sandbox import AgentNeeds, Sandbox
from .base import STEP_BUDGET, AgentAdapter, Normalized, Session, TurnResult, Usage

#: Features that would add tools, instructions or remote content the Claude agents don't get
#: (connectors/apps, plugins, browser/computer use, image generation, sub-agents, memories,
#: hooks, skill search). All off; checked again against `codex features list` before running.
DISABLED_FEATURES = (
    "apps", "plugins", "remote_plugin", "browser_use", "browser_use_external", "computer_use",
    "image_generation", "multi_agent", "multi_agent_v2", "memories", "hooks", "tool_suggest",
    "skill_search", "skill_mcp_dependency_install", "in_app_browser", "goals",
)  # fmt: skip


def config_toml(model: str, effort: str) -> str:
    features = "\n".join(f"{f} = false" for f in DISABLED_FEATURES)
    return f"""# french-cfo-bench: minimal Codex config (generated per run)
model = "{model}"
model_reasoning_effort = "{effort}"
approval_policy = "never"
allow_login_shell = false             # `zsh -lc` would run path_helper and reorder PATH
sandbox_mode = "danger-full-access"   # the outer seatbelt sandbox is the boundary
web_search = "disabled"               # no web search (the Claude agents have none either)
check_for_update_on_startup = false

[history]
persistence = "none"

[skills.bundled]
enabled = false                       # no system skills (imagegen, skill-creator, …)

[features]
{features}
"""


def strip_frontmatter(text: str) -> str:
    if text.startswith("---\n"):
        end = text.find("\n---\n", 4)
        if end != -1:
            return text[end + 5 :].lstrip("\n")
    return text


def _sha(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def _write_private(path: Path, data: bytes) -> None:
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


#: Codex CLI version benchmarked (both Codex agents). Change deliberately, then rerun everything.
CODEX_VERSION = "0.163.0"


def pinned_codex_dir() -> Path:
    """Private npm prefix holding `@openai/codex@CODEX_VERSION` (and its native binary package)."""
    return paths.RUNTIME_DIR / "codex" / CODEX_VERSION


def pinned_codex_js() -> Path:
    js = pinned_codex_dir() / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
    if not js.exists():
        raise RuntimeError(f"Codex CLI {CODEX_VERSION} is not pinned yet: run `uv run french-cfo-bench prepare-runtime`")
    return js


def pin_codex() -> Path:
    """Install `@openai/codex@CODEX_VERSION` from the npm registry into the runtime dir (once), into a
    private prefix (the machine's own `codex` is never changed). Returns the launcher."""
    from ..runtime import npm_install

    target = pinned_codex_dir()
    js = target / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
    if js.exists():
        return js
    staging = target.with_name(f"{CODEX_VERSION}.staging-{int(time.time() * 1000)}")
    spec = f"@openai/codex@{CODEX_VERSION}"
    try:
        npm_install(staging, spec)
        r = subprocess.run(
            [str(paths.node_binary()), str(staging / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"), "--version"],
            capture_output=True, text=True, timeout=60, env=_clean_env(),
        )  # fmt: skip
        got = (r.stdout.strip() or r.stderr.strip())
        if got != f"codex-cli {CODEX_VERSION}":
            raise RuntimeError(f"npm {spec} reports {got!r}")
        (staging / "source").write_text(f"npm {spec}\n")
        if target.exists():
            shutil.rmtree(target)
        staging.rename(target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    return js


class CodexAgent(AgentAdapter):
    subscription = "codex"

    def __init__(self, id: str = "codex", model: str = "gpt-6.1-sol", effort: str = "high",
                 step_budget: int = STEP_BUDGET) -> None:  # fmt: skip
        self.id = id
        self.step_budget = step_budget
        self.model = model
        self.effort = effort
        self._auth_hash: dict[str, str | None] = {}
        self._features: dict[str, bool] | None = None
        self._version: str | None = None

    # ---- installation -----------------------------------------------------------------------

    @staticmethod
    def codex_js() -> Path:
        """The pinned Codex CLI launcher (installed into the runtime dir by `prepare-runtime`), so an
        update of the machine's own `codex` can't change the agent between benchmark batches."""
        return pinned_codex_js()

    @classmethod
    def package_dir(cls) -> Path:
        # the private npm prefix's node_modules: @openai/codex (launcher) + its native binary package
        return pinned_codex_dir() / "node_modules"

    def version(self) -> str:
        if self._version is None:
            r = subprocess.run(
                [str(paths.node_binary()), str(self.codex_js()), "--version"],
                capture_output=True, text=True, timeout=60, env=_clean_env(),
            )  # fmt: skip
            self._version = r.stdout.strip() or r.stderr.strip()
        return self._version

    # ---- auth -------------------------------------------------------------------------------

    @staticmethod
    def master_auth() -> Path:
        """Dedicated bench login if `~/.config/french-cfo-bench/codex-home/` exists, else the bench
        master copy (created once from ~/.codex/auth.json, mode 600). Never ~/.codex itself."""
        home = paths.BENCH_CONFIG_DIR / "codex-home"
        if home.is_dir():
            return home / "auth.json"
        master = paths.BENCH_CONFIG_DIR / "codex-auth-master.json"
        if not master.exists():
            src = paths.HOME / ".codex" / "auth.json"
            if not src.exists():
                raise RuntimeError("no Codex login: ~/.codex/auth.json missing and no bench login")
            paths.BENCH_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
            os.chmod(paths.BENCH_CONFIG_DIR, 0o700)
            _write_private(master, src.read_bytes())
        return master

    def _sync_auth_back(self, sb: Sandbox) -> bool:
        """Codex may refresh its token inside the run copy: keep the master copy current."""
        run_auth = sb.agent_config / "auth.json"
        new = _sha(run_auth)
        if new is None or new == self._auth_hash.get(sb.run_id):
            return False
        data = run_auth.read_bytes()
        try:
            json.loads(data)
        except json.JSONDecodeError:
            return False
        _write_private(self.master_auth(), data)
        self._auth_hash[sb.run_id] = new
        return True

    # ---- checks -----------------------------------------------------------------------------

    def features(self) -> dict[str, bool]:
        """Effective feature flags under the bench config (`codex features list`, offline)."""
        if self._features is None:
            with tempfile.TemporaryDirectory() as d:
                (Path(d) / "config.toml").write_text(config_toml(self.model, self.effort))
                env = {**_clean_env(), "CODEX_HOME": d, "HOME": d}
                r = subprocess.run(
                    [str(paths.node_binary()), str(self.codex_js()), "features", "list"],
                    capture_output=True, text=True, timeout=60, env=env,
                )  # fmt: skip
            feats = {}
            for line in r.stdout.splitlines():
                parts = line.split()
                if len(parts) >= 2 and parts[-1] in ("true", "false"):
                    feats[parts[0]] = parts[-1] == "true"
            self._features = feats
        return self._features

    def preflight(self) -> None:
        self.master_auth()
        v = re.search(r"(\d+)\.(\d+)\.(\d+)", self.version())
        if not v or tuple(map(int, v.groups())) < (0, 159, 0):
            raise RuntimeError(f"codex >= 0.159 required, found {self.version()!r}")
        on = [f for f in DISABLED_FEATURES if self.features().get(f)]
        if on:
            from .base import HermeticityError

            raise HermeticityError(f"codex features still enabled: {on}")

    # ---- sandbox ----------------------------------------------------------------------------

    def prepare_sandbox(self, sb: Sandbox) -> AgentNeeds:
        (sb.agent_config / "config.toml").write_text(config_toml(self.model, self.effort))
        master = self.master_auth()
        _write_private(sb.agent_config / "auth.json", master.read_bytes())
        self._auth_hash[sb.run_id] = _sha(sb.agent_config / "auth.json")
        (sb.work / "AGENTS.md").write_text(strip_frontmatter(sb.runtime.skill_text))
        pkg = self.package_dir()
        return AgentNeeds(
            env={"CODEX_HOME": str(sb.agent_config)},
            reads=[pkg],
            notes={str(pkg): "Codex CLI package (launcher + native binary)"},
        )

    # ---- turns ------------------------------------------------------------------------------

    def command(self, sb: Sandbox, session: Session, turn: int, last_message: Path) -> list[str]:
        base = [str(sb.node), str(self.codex_js()), "exec"]
        common = [
            "--json", "-o", str(last_message), "--skip-git-repo-check", "--strict-config",
            "--dangerously-bypass-approvals-and-sandbox",
        ]  # fmt: skip
        if turn == 1 or not session.id:
            return [*base, *common, "-C", str(sb.work), "-"]
        return [*base, "resume", session.id, *common, "-"]

    def run_turn(
        self, sb: Sandbox, prompt: str, session: Session, *, turn: int, record_dir: Path, timeout_s: float
    ) -> TurnResult:
        record_dir.mkdir(parents=True, exist_ok=True)
        prompt_file = record_dir / f"prompt-turn-{turn}.txt"
        prompt_file.write_text(prompt)
        last = sb.root / f"codex-last-message-{turn}.txt"
        events_file = record_dir / f"turn-{turn}.codex.jsonl"
        stderr_file = record_dir / f"turn-{turn}.codex.stderr.txt"
        argv = self.command(sb, session, turn, last)
        prev_total = int(session.data.get("codex_prev_total_tokens", 0))
        monitor = StepMonitor(sb.agent_config, events_file, self.step_budget, prev_total, session.id)
        proc = sb.run(argv, cwd=sb.work, stdin=prompt_file, stdout=events_file, stderr=stderr_file,
                      timeout=timeout_s, monitor=monitor)  # fmt: skip
        self._sync_auth_back(sb)
        parsed = parse_events(events_file.read_text(errors="replace"), Normalized(record_dir, turn))
        final = last.read_text() if last.exists() else parsed["last_message"]
        if last.exists():
            shutil.copy2(last, record_dir / f"turn-{turn}.final.txt")
        Normalized(record_dir, turn).final(final)
        if parsed["thread_id"]:
            session.id = parsed["thread_id"]
        status, error, reset = classify(parsed, proc.returncode, proc.timed_out, proc.stopped)
        # Usage and cost per model request, from the session log's token_count events (exact
        # for this turn, also when the turn was stopped, long-context aware). turn.completed
        # usage is cumulative over the thread (a resumed turn reports turn 1 + turn 2), so the
        # fallback is the difference with the previous turn's report.
        reported = parsed["usage"]
        prev = session.data.get("codex_cumulative")
        if parsed["completed"]:
            session.data["codex_cumulative"] = dict(reported.__dict__)
        rollout = _find_rollout(sb.agent_config, session.id)
        requests, last_total = rollout_requests(rollout, prev_total) if rollout else ([], prev_total)
        session.data["codex_prev_total_tokens"] = last_total
        extra: dict[str, Any] = {"events": parsed["counts"], "reported_usage_cumulative": reported.__dict__,
                                 "budget_monitor_requests": monitor.requests}  # fmt: skip
        if requests:
            usage = Usage(reasoning_tokens=0, cache_write_tokens=0)
            for r in requests:
                usage = usage.add(r)
            cost = pricing.cost_usd_requests("openai", self.model, requests)
            model_requests: int | None = len(requests)
            if parsed["completed"]:
                diff = subtract_usage(reported, Usage(**prev)) if prev else reported
                extra["usage_crosscheck_ok"] = diff == usage
        else:
            usage = subtract_usage(reported, Usage(**prev)) if prev and parsed["completed"] else reported
            cost = pricing.cost_usd("openai", self.model, usage)
            model_requests = None
            extra["usage_source"] = "turn.completed"
        if proc.stopped:
            extra["stopped"] = proc.stopped
        if rollout is not None and model_requests is None:
            model_requests = 0
        # fail-closed budget accounting, checked after the process has ended (all files flushed)
        events_text = events_file.read_text(errors="replace")
        lower_bound = requests_lower_bound(events_text)
        reported_diff = subtract_usage(reported, Usage(**prev)) if prev else reported
        tok = lambda u: u.input_tokens + u.cached_input_tokens + u.output_tokens  # noqa: E731
        override, why = budget_check(
            requests=model_requests,
            lower_bound=lower_bound,
            budget=self.step_budget,
            rollout_found=rollout is not None,
            activity=bool(sum(parsed["counts"].values()) or parsed["tool_calls"]),
            completed=parsed["completed"],
            rollout_tokens=tok(usage) if requests else None,
            reported_tokens=tok(reported_diff) if parsed["completed"] else None,
        )
        extra["budget"] = {"limit": self.step_budget, "session_log_requests": model_requests,
                           "event_stream_lower_bound": lower_bound}  # fmt: skip
        if override and status not in ("rate_limited", "infra_error"):
            status, error = override, why
            if override == "infra_error":
                extra["budget_unknown"] = True
        elif proc.stopped and proc.stopped.startswith(ACCOUNTING_REASON):
            extra["budget_unknown"] = True
        resolved = self.resolved_config(sb, argv, session.id)
        hermetic_problems = check_resolved(resolved, parsed)
        if hermetic_problems:
            status, error = "infra_error", "hermeticity: " + "; ".join(hermetic_problems)
            extra["hermeticity_failed"] = True
        return TurnResult(
            turn=turn,
            final_text=final,
            session_id=session.id,
            transcript=events_file.name,
            usage=usage,
            cost_usd=cost,
            num_turns=model_requests,
            model_requests=model_requests,
            tool_calls=parsed["tool_calls"],
            duration_s=proc.duration_s,
            exit_status=status,
            rate_limit_reset=reset,
            resolved_config=resolved,
            error=error,
            returncode=proc.returncode,
            extra=extra,
        )

    def resolved_config(self, sb: Sandbox, argv: list[str], thread_id: str | None) -> dict[str, Any]:
        out: dict[str, Any] = {
            "version": self.version(),
            "argv": [a for a in argv[1:]],
            "config_toml": (sb.agent_config / "config.toml").read_text(),
            "features_enabled": sorted(k for k, v in self.features().items() if v),
            "expected_model": self.model,
            "expected_effort": self.effort,
        }
        rollout = _find_rollout(sb.agent_config, thread_id)
        if rollout:
            out.update(summarize_rollout(rollout))
        return out

    def private_strings(self, sb: Sandbox) -> list[str]:
        """The ChatGPT account email, from the run's auth.json id_token (JWT payload)."""
        return jwt_emails(sb.agent_config / "auth.json")

    def finalize(self, sb: Sandbox, record_dir: Path) -> None:
        self._sync_auth_back(sb)
        sessions = sb.agent_config / "sessions"
        if sessions.exists():
            shutil.copytree(sessions, record_dir / "codex-sessions", dirs_exist_ok=True)
        self._auth_hash.pop(sb.run_id, None)


def jwt_emails(auth_file: Path) -> list[str]:
    out: set[str] = set()
    try:
        tokens = json.loads(auth_file.read_text()).get("tokens") or {}
    except (OSError, json.JSONDecodeError, AttributeError):
        return []
    for key in ("id_token", "access_token"):
        tok = tokens.get(key)
        if not isinstance(tok, str) or tok.count(".") < 2:
            continue
        part = tok.split(".")[1]
        try:
            payload = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        except (ValueError, binascii.Error):
            continue
        for v in (payload.get("email"), (payload.get("https://api.openai.com/profile") or {}).get("email")):
            if isinstance(v, str) and "@" in v:
                out.add(v)
    return sorted(out)


def _clean_env() -> dict[str, str]:
    """Minimal env for harness-side codex calls (version/features): no API keys."""
    return {
        "PATH": f"{paths.node_binary().parent}:/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": str(paths.system_temp()),
        "LANG": "en_US.UTF-8",
    }


def _find_rollout(codex_home: Path, thread_id: str | None, strict: bool = False) -> Path | None:
    files = sorted((codex_home / "sessions").rglob("*.jsonl")) if (codex_home / "sessions").exists() else []
    if thread_id:
        matching = [f for f in files if thread_id in f.name]
        files = matching if (matching or strict) else files
    return files[-1] if files else None


def _usage_from(u: dict[str, Any]) -> Usage:
    total_in = int(u.get("input_tokens") or 0)
    cached = int(u.get("cached_input_tokens") or 0)
    return Usage(
        input_tokens=max(total_in - cached, 0),
        cached_input_tokens=cached,
        output_tokens=int(u.get("output_tokens") or 0),
        reasoning_tokens=int(u.get("reasoning_output_tokens") or 0),
        cache_write_tokens=int(u.get("cache_write_input_tokens") or 0),
    )


def subtract_usage(a: Usage, b: Usage) -> Usage:
    def opt(x: int | None, y: int | None) -> int | None:
        return None if x is None else max(x - (y or 0), 0)

    return Usage(
        max(a.input_tokens - b.input_tokens, 0),
        max(a.cached_input_tokens - b.cached_input_tokens, 0),
        max(a.output_tokens - b.output_tokens, 0),
        opt(a.reasoning_tokens, b.reasoning_tokens),
        opt(a.cache_write_tokens, b.cache_write_tokens),
    )


def rollout_requests(path: Path, after_total: int) -> tuple[list[Usage], int]:
    """Per-request usage (token_count events' `last_token_usage`) for requests whose cumulative
    total exceeds `after_total`; repeated events (same cumulative total) are skipped."""
    requests: list[Usage] = []
    last = after_total
    for line in path.read_text(errors="replace").splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        p = e.get("payload") or {}
        if p.get("type") != "token_count" or not p.get("info"):
            continue
        total = int(((p["info"].get("total_token_usage") or {}).get("total_tokens")) or 0)
        if total <= last:
            continue
        last = total
        requests.append(_usage_from(p["info"].get("last_token_usage") or {}))
    return requests, last


def summarize_rollout(path: Path) -> dict[str, Any]:
    """Effective settings recorded by Codex itself: session meta, turn context, and which
    instruction blocks it injected (by their leading tag)."""
    meta: dict[str, Any] = {}
    turn_contexts: list[dict[str, Any]] = []
    dev_blocks: list[str] = []
    forbidden: list[str] = []
    agents_md = None
    for line in path.read_text(errors="replace").splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        p = e.get("payload") or {}
        if e.get("type") == "session_meta":
            meta = {k: p.get(k) for k in ("cli_version", "originator", "source", "model_provider", "cwd")}
        elif e.get("type") == "turn_context":
            turn_contexts.append(
                {k: p.get(k) for k in ("model", "effort", "approval_policy", "sandbox_policy", "cwd", "summary")}
            )
        elif e.get("type") == "world_state":
            agents_md = (p.get("state") or {}).get("agents_md")
        elif e.get("type") == "response_item" and p.get("type") in FORBIDDEN_ROLLOUT_CALLS:
            forbidden.append(p["type"])
        elif p.get("type") == "message" and p.get("role") == "developer":
            for c in p.get("content") or []:
                m = re.match(r"\s*<([\w-]+)>", c.get("text") or "")
                dev_blocks.append(m.group(1) if m else (c.get("text") or "")[:40])
    return {
        "session_meta": meta,
        "turn_contexts": turn_contexts,
        "developer_blocks": dev_blocks,
        "agents_md": agents_md,
        "forbidden_calls": sorted(set(forbidden)),
    }


#: Tool use the configuration rules out (web search is disabled, image generation is off). Seen in
#: a turn's `--json` items or its rollout, it means the configuration did not hold: the run is a
#: configuration error (`infra_error`), never an agent result. Codex's own collaboration/subagent
#: tools, `request_user_input`, `view_image`, `apply_patch` and the built-in MCP resource listings
#: stay allowed: they are part of Codex as shipped (bench/harness/README.md, "Known asymmetry").
FORBIDDEN_ITEMS = ("web_search", "image_generation")
FORBIDDEN_ROLLOUT_CALLS = ("web_search_call", "image_generation_call")


def check_resolved(resolved: dict[str, Any], parsed: dict[str, Any]) -> list[str]:
    """Configuration problems of one turn (empty = hermetic). The resolved config must be the
    bench config (config.toml as generated, no disabled feature on), model and effort as
    requested, no extra instruction block, no MCP call but the built-in empty listings, and no
    forbidden tool use."""
    problems = []
    model, effort = resolved.get("expected_model"), resolved.get("expected_effort")
    if resolved.get("config_toml") is not None and model and effort and resolved["config_toml"] != config_toml(model, effort):
        problems.append("config.toml differs from the bench config")
    on = sorted(set(resolved.get("features_enabled") or []) & set(DISABLED_FEATURES))
    if on:
        problems.append(f"disabled features enabled: {on}")
    used = sorted({t for t in FORBIDDEN_ITEMS if parsed.get("counts", {}).get(t)}
                  | set(resolved.get("forbidden_calls") or []))
    if used:
        problems.append(f"forbidden tools used: {used}")
    if any(b in ("skills_instructions", "apps_instructions", "plugins_instructions") for b in resolved.get("developer_blocks", [])):
        problems.append(f"extra instruction blocks: {resolved['developer_blocks']}")
    for tc in resolved.get("turn_contexts", []):
        if tc.get("model") and tc["model"] != resolved.get("expected_model", tc["model"]):
            problems.append(f"model {tc['model']} != {resolved.get('expected_model')}")
        if tc.get("effort") and tc["effort"] != resolved.get("expected_effort", tc["effort"]):
            problems.append(f"effort {tc['effort']} != {resolved.get('expected_effort')}")
    bad = [c for c in parsed.get("mcp_calls", []) if not _builtin_empty_listing(c)]
    if bad or (parsed["counts"].get("mcp_tool_call") and "mcp_calls" not in parsed):
        problems.append(f"MCP tool calls present: {[(c.get('server'), c.get('tool')) for c in bad]}")
    return problems


#: Codex's own resource-listing tools (pseudo-server "codex"). With no MCP server configured they
#: return empty lists; the model sometimes calls them while exploring. Anything else is a leak.
BUILTIN_MCP_LISTINGS = {("codex", "list_mcp_resources"), ("codex", "list_mcp_resource_templates")}


def _builtin_empty_listing(item: dict[str, Any]) -> bool:
    if (item.get("server"), item.get("tool")) not in BUILTIN_MCP_LISTINGS or item.get("error"):
        return False
    for c in (item.get("result") or {}).get("content") or []:
        try:
            v = json.loads(c.get("text") or "")
        except json.JSONDecodeError:
            return False
        if not isinstance(v, dict) or any(x for x in v.values()):
            return False
    return True


#: item types that are not tool calls (everything else the model asked to run is one)
NON_TOOL_ITEMS = ("agent_message", "reasoning", "error", "user_message")


def parse_events(text: str, norm: Normalized | None = None) -> dict[str, Any]:
    """Parse `codex exec --json` output (thread.started, item.*, turn.completed/failed, error)."""
    thread_id = None
    usage = Usage(reasoning_tokens=0, cache_write_tokens=0)
    completed = False
    failed: list[str] = []
    errors: list[str] = []
    last_message = ""
    counts: dict[str, int] = {}
    mcp_calls: list[dict[str, Any]] = []
    started: dict[str, dict[str, Any]] = {}  # tool items started, not (yet) completed
    tool_calls = 0
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = e.get("type")
        if t == "thread.started":
            thread_id = e.get("thread_id")
        elif t == "turn.completed":
            completed = True
            usage = usage.add(_usage_from(e.get("usage") or {}))
        elif t == "turn.failed":
            failed.append(json.dumps(e.get("error") or e))
        elif t == "error":
            errors.append(str(e.get("message") or json.dumps(e)))
        elif t == "item.started":
            item = e.get("item") or {}
            if item.get("type") not in NON_TOOL_ITEMS:
                started[item.get("id") or f"anon-{len(started)}"] = item
        elif t == "item.completed":
            item = e.get("item") or {}
            it = item.get("type", "?")
            counts[it] = counts.get(it, 0) + 1
            started.pop(item.get("id"), None)
            if it == "mcp_tool_call":
                mcp_calls.append(item)
            if it == "agent_message":
                last_message = item.get("text") or ""
                if norm:
                    norm.message(last_message)
            elif it == "error":
                errors.append(str(item.get("message")))
            elif it not in NON_TOOL_ITEMS:
                tool_calls += 1
                if norm:
                    _norm_item(norm, item)
    for item in started.values():  # killed mid-call: requested, never finished
        tool_calls += 1
        if item.get("type") == "mcp_tool_call":
            mcp_calls.append(item)
        if norm:
            _norm_item(norm, {**item, "aggregated_output": None, "exit_code": None})
    return {
        "thread_id": thread_id,
        "usage": usage,
        "completed": completed,
        "failed": failed,
        "errors": errors,
        "last_message": last_message,
        "counts": counts,
        "mcp_calls": mcp_calls,
        "tool_calls": tool_calls,
    }


def _norm_item(norm: Normalized, item: dict[str, Any]) -> None:
    """Shell commands as `command` events (output = what the model sees: aggregated_output);
    every other tool item (file_change, mcp_tool_call, web_search, todo_list, …) as `tool`."""
    if item.get("type") == "command_execution":
        norm.command(item.get("command") or "", item.get("aggregated_output"), item.get("exit_code"))
        return
    payload = {k: v for k, v in item.items() if k not in ("id", "type")}
    output = payload.get("result") if payload.get("result") is not None else payload.get("error")
    if output is None:
        output = payload.get("status")
    norm.tool(item.get("type", "?"), payload, output)


BUDGET_REASON = "step budget"
ACCOUNTING_REASON = "budget accounting lost"


class StepMonitor:
    """Stops a Codex turn at the common step budget (STEP_BUDGET model requests), the unit of
    Claude Code's `--max-turns`. Polled by `run_sandboxed` while Codex runs; reads, as they are
    written, the session log (one `token_count` event per model response, deduplicated by the
    cumulative total) and the --json event stream (open tool items, turn.completed).

    Once the budget is reached and the turn hasn't completed, the turn is stopped as soon as the
    budget-th response's tool calls have finished (or after `idle_s` without any event and no
    tool running), i.e. before the next response is used; a response beyond the budget stops it
    immediately, completed or not. If the next response arrives within that window its tool
    calls may start before the stop (at most one extra request); this is recorded, not hidden
    (`model_requests` > budget, status `max_turns`).

    Fails closed: the session log lives in CODEX_HOME, which the agent's own commands can
    write. If it disappears, shrinks, holds an unparsable line, or never appears while the event
    stream (written by the harness, out of the agent's reach) shows activity, the turn is
    stopped with ACCOUNTING_REASON (→ `infra_error`, `budget_unknown`)."""

    def __init__(self, codex_home: Path, events_file: Path, budget: int, after_total: int,
                 thread_id: str | None = None, idle_s: float = 1.5, missing_grace_s: float = 10.0) -> None:  # fmt: skip
        self.codex_home = codex_home
        self.events_file = events_file
        self.budget = budget
        self.last_total = after_total
        self.thread_id = thread_id
        self.idle_s = idle_s
        self.missing_grace_s = missing_grace_s
        self.requests = 0
        self.rollout: Path | None = None
        self.lost: str | None = None
        self._offsets: dict[Path, int] = {}
        self._open: set[str] = set()
        self._items = 0
        self._first_activity: float | None = None
        self._completed = False
        self._tool_done_after_budget = False
        self._last_change = time.monotonic()

    def _new_lines(self, path: Path) -> list[str] | None:
        """Complete new lines; None if the file vanished or shrank below what was read."""
        try:
            with path.open("rb") as f:
                size = os.fstat(f.fileno()).st_size
                if size < self._offsets.get(path, 0):
                    return None
                f.seek(self._offsets.get(path, 0))
                data = f.read()
        except FileNotFoundError:
            return None
        except OSError:
            return []
        cut = data.rfind(b"\n") + 1  # complete lines only
        self._offsets[path] = self._offsets.get(path, 0) + cut
        return data[:cut].decode("utf-8", "replace").splitlines()

    def _read_rollout(self) -> bool:
        if self.rollout is None:
            self.rollout = _find_rollout(self.codex_home, self.thread_id, strict=bool(self.thread_id))
            if self.rollout is None:
                return False
        lines = self._new_lines(self.rollout)
        if lines is None:
            self.lost = "session log deleted or truncated during the turn"
            return False
        changed = False
        for line in lines:
            try:
                p = (json.loads(line).get("payload")) or {}
            except (json.JSONDecodeError, AttributeError):
                self.lost = "unparsable session log line"
                return False
            if p.get("type") != "token_count" or not p.get("info"):
                continue
            total = int(((p["info"].get("total_token_usage") or {}).get("total_tokens")) or 0)
            if total > self.last_total:
                self.last_total = total
                self.requests += 1
                changed = True
        return changed

    def _read_events(self) -> bool:
        lines = self._new_lines(self.events_file) or []
        for line in lines:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            t, item = e.get("type"), e.get("item") or {}
            if t in ("item.started", "item.completed") and self._first_activity is None:
                self._first_activity = time.monotonic()
            if t == "turn.completed" or t == "turn.failed":
                self._completed = True
            elif t == "item.started" and item.get("type") not in NON_TOOL_ITEMS:
                self._open.add(item.get("id"))
            elif t == "item.completed" and item.get("type") not in NON_TOOL_ITEMS:
                self._open.discard(item.get("id"))
                if self.requests >= self.budget:
                    self._tool_done_after_budget = True
        return bool(lines)

    def __call__(self) -> str | None:
        changed = self._read_rollout()
        changed = self._read_events() or changed
        now = time.monotonic()
        if changed:
            self._last_change = now
        if self.lost:
            return f"{ACCOUNTING_REASON}: {self.lost}"
        if self.rollout is None and self._first_activity is not None and now - self._first_activity >= self.missing_grace_s:
            self.lost = "no session log while the event stream shows activity"
            return f"{ACCOUNTING_REASON}: {self.lost}"
        reason = f"{BUDGET_REASON}: {self.budget} model requests"
        if self.requests > self.budget:
            return reason  # checked before completion: an over-budget turn never passes
        if self._completed or self.requests < self.budget:
            return None
        if not self._open and (self._tool_done_after_budget or now - self._last_change >= self.idle_s):
            return reason
        return None


def requests_lower_bound(text: str) -> int:
    """Model responses the --json event stream proves (a trusted channel: the harness owns the
    file). The first item needs a response; an agent message after a finished tool call needs a
    new one (the model must have seen the tool output); so does completing the turn after a
    finished tool call. Sequential tool items alone prove nothing (one response can hold several
    calls)."""
    lb, tool_done, completed = 0, False, False
    for line in text.splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        t, item = e.get("type"), e.get("item") or {}
        if t in ("item.started", "item.completed"):
            if lb == 0:
                lb = 1
                tool_done = False
            if t == "item.completed" and item.get("type") == "agent_message" and tool_done:
                lb += 1
                tool_done = False
            elif t == "item.completed" and item.get("type") not in NON_TOOL_ITEMS:
                tool_done = True
        elif t == "turn.completed":
            completed = True
    if completed and tool_done:
        lb += 1
    return lb


def budget_check(*, requests: int | None, lower_bound: int, budget: int, rollout_found: bool,
                 activity: bool, completed: bool, rollout_tokens: int | None,
                 reported_tokens: int | None) -> tuple[str | None, str | None]:  # fmt: skip
    """After the turn: (status override, error). Fail closed on inconsistent accounting."""
    if activity and not rollout_found:
        return "infra_error", f"{ACCOUNTING_REASON}: no session log"
    n = requests or 0
    if lower_bound > n:
        return "infra_error", f"{ACCOUNTING_REASON}: session log has {n} responses, event stream proves {lower_bound}"
    if completed and rollout_tokens is not None and reported_tokens is not None and rollout_tokens < reported_tokens:
        return "infra_error", (f"{ACCOUNTING_REASON}: session log accounts for {rollout_tokens} tokens, "
                               f"turn.completed reports {reported_tokens}")  # fmt: skip
    if n > budget:
        return "max_turns", f"{BUDGET_REASON} exceeded: {n} model requests > {budget}"
    return None, None


def classify(parsed: dict[str, Any], returncode: int | None, timed_out: bool, stopped: str | None = None):
    """(exit_status, error, rate_limit_reset) from structured events only."""
    if timed_out:
        return "timeout", "turn timed out", None
    if stopped:
        return ("infra_error" if stopped.startswith(ACCOUNTING_REASON) else "max_turns"), stopped, None
    if parsed["completed"] and not parsed["failed"]:
        return "ok", None, None
    fatal = parsed["failed"] + [m for m in parsed["errors"] if not m.startswith("Reconnecting")]
    text = "\n".join(fatal or parsed["errors"])
    if ratelimit.is_limit_message(text):
        return "rate_limited", text[-2000:], ratelimit.parse_reset(text)
    if not text and returncode == 0:
        return "agent_error", "no turn.completed event", None
    if parsed["failed"] and not ratelimit.is_auth_message(text):
        return "agent_error", text[-2000:], None
    return "infra_error", (text or f"codex exited {returncode}")[-2000:], None

