"""Claude Code adapter (`claude -p --output-format stream-json`), DESIGN.md §7.

Auth (`--claude-auth`, default `token`):
- `token`: `~/.config/french-cfo-bench/claude-oauth-token` (from `claude setup-token`) →
  `CLAUDE_CODE_OAUTH_TOKEN` + a fresh, empty `CLAUDE_CONFIG_DIR=<run>/agent-config` per run (the
  token is redacted from records). No keychain, `/usr/bin/security` not executable.
- `keychain` (explicit opt-in): `CLAUDE_CONFIG_DIR=~/.config/french-cfo-bench/claude-config`
  (or `$FRENCH_CFO_BENCH_CLAUDE_CONFIG_DIR`), a benchmark-only config dir whose login lives in the
  macOS login keychain (the item name is derived from the config dir path, so the path never
  changes). The dir is wiped and restored
  from a minimal template before and after every run; the keychain file is readable, not
  writable; Claude Code reads its credentials by running /usr/bin/security, which therefore
  stays executable — and with it the agent could query other items of the login keychain whose
  ACL trusts that tool. That residual exposure is why this mode is opt-in (README).

The prompt goes through stdin. Skill: `work/.claude/skills/compta/SKILL.md` (verbatim) and a
minimal `work/.claude/settings.json`; `--setting-sources project` loads only those.
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
from datetime import datetime
from pathlib import Path
from typing import Any

from .. import paths, ratelimit
from ..sandbox import AgentNeeds, Sandbox
from .base import STEP_BUDGET, AgentAdapter, HermeticityError, Normalized, Session, TurnResult, Usage

#: `Skill` is required for Claude Code to expose installed skills to the model at all (without it the
#: leak test showed "no skills, including no compta skill" although init listed it).
TOOLS = ("Bash", "Read", "Write", "Edit", "Glob", "Grep", "Skill")
MAX_TURNS = STEP_BUDGET  # --max-turns: model responses per conversation turn
#: Project settings: Claude Code 2.1.x ships bundled skills (design, doctor, dataviz, …) and
#: built-in plugins that load even from an empty config dir; they are switched off so the compta
#: skill is the only one (as Codex's bundled skills are). Auto memory off: no cross-run state.
SETTINGS = {
    "autoMemoryEnabled": False,
    "disableBundledSkills": True,
    "skillOverrides": {"design": "off", "doctor": "off"},
    "enabledPlugins": {
        "cc-plugin-agents-md@builtin": False,
        "cc-plugin-telemetry@builtin": False,
        "cc-plugin-plugin-authoring@builtin": False,
    },
}
#: Built-in subagent types listed by init; unusable here (no Agent/Task tool: it would fail
#: `check_init` as an unexpected tool), recorded only.
BUILTIN_AGENTS = ("claude", "general-purpose", "statusline-setup", "Explore", "Plan")

TOKEN_FILE = paths.BENCH_CONFIG_DIR / "claude-oauth-token"
#: Environment variable that replaces the keychain-mode config dir (an absolute path).
CONFIG_DIR_ENV = "FRENCH_CFO_BENCH_CLAUDE_CONFIG_DIR"


def shared_config_dir(environ: Any = None) -> Path:
    """The keychain-mode config dir: `$FRENCH_CFO_BENCH_CLAUDE_CONFIG_DIR` if set (e.g. a config
    dir that is already logged in: the keychain item is named after the path, so the path is used
    as given, `~` expanded, symlinks kept), else `~/.config/french-cfo-bench/claude-config`."""
    value = (os.environ if environ is None else environ).get(CONFIG_DIR_ENV, "").strip()
    if not value:
        return paths.BENCH_CONFIG_DIR / "claude-config"
    d = Path(os.path.expanduser(value))
    if not d.is_absolute():
        raise ValueError(f"{CONFIG_DIR_ENV} must be an absolute path, got {value!r}")
    return d


SHARED_CONFIG = shared_config_dir()
#: Pristine copy restored into SHARED_CONFIG around every keychain-mode run (0700, outside every
#: sandbox allow-list).
TEMPLATE = paths.BENCH_CONFIG_DIR / "claude-config.template"
#: `.claude.json` keys kept in the template. None: verified that Claude Code is logged in (auth
#: status, then a real Haiku turn) with an empty `.claude.json` — the OAuth credentials live in
#: the keychain item, and account details are re-fetched.
TEMPLATE_KEYS: tuple[str, ...] = ()
KEYCHAIN = paths.HOME / "Library" / "Keychains" / "login.keychain-db"
AUTH_MODES = ("token", "keychain")

#: settings keys that would change behaviour outside the fixed benchmark configuration
FORBIDDEN_SETTINGS = (
    "hooks", "mcpServers", "enabledPlugins", "extraKnownMarketplaces", "enabledMcpjsonServers",
    "enableAllProjectMcpServers", "apiKeyHelper", "env", "outputStyle", "statusLine", "agents",
)  # fmt: skip
CONTENT_DIRS = ("skills", "agents", "commands", "plugins", "output-styles", "hooks", "rules")


#: Claude Code version benchmarked (all Claude agents). Change deliberately, then rerun everything.
CLAUDE_CODE_VERSION = "2.1.303"


def pinned_claude_dir() -> Path:
    return paths.RUNTIME_DIR / "claude-code" / CLAUDE_CODE_VERSION


def pinned_claude() -> Path:
    b = pinned_claude_dir() / "claude.exe"
    if not b.exists():
        raise RuntimeError(
            f"Claude Code {CLAUDE_CODE_VERSION} is not pinned yet: run `uv run french-cfo-bench prepare-runtime` "
            f"while the installed `claude` is {CLAUDE_CODE_VERSION}"
        )
    return b


def _claude_version(binary: Path) -> str:
    return subprocess.run([str(binary), "--version"], capture_output=True, text=True, timeout=60,
                          env={"PATH": "/usr/bin:/bin", "HOME": str(paths.system_temp())}).stdout.strip()  # fmt: skip


def pin_claude() -> Path:
    """Put Claude Code CLAUDE_CODE_VERSION into the runtime dir (once). Source: the installed
    `claude` if it is that version, else that exact version from the npm registry, installed into a
    private temporary prefix (the machine's own installs are never changed). The binary is
    self-contained; its sha256 and source are written next to it."""
    import hashlib

    from ..runtime import npm_install

    dest = pinned_claude_dir() / "claude.exe"
    if dest.exists():
        return dest
    with tempfile.TemporaryDirectory(prefix="claude-pin-") as td:
        src: Path | None = None
        try:
            installed = paths.resolve_binary("claude")
            if _claude_version(installed).startswith(CLAUDE_CODE_VERSION):
                src, source = installed, f"installed claude ({installed})"
        except FileNotFoundError:
            pass
        if src is None:
            spec = f"@anthropic-ai/claude-code@{CLAUDE_CODE_VERSION}"
            npm_install(Path(td), spec)
            src, source = Path(td) / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe", f"npm {spec}"
        got = _claude_version(src)
        if not got.startswith(CLAUDE_CODE_VERSION):
            raise RuntimeError(f"{source} is {got!r}, pinned version is {CLAUDE_CODE_VERSION}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name("claude.exe.partial")
        shutil.copy2(src, tmp)
        tmp.rename(dest)
    (dest.parent / "sha256").write_text(hashlib.sha256(dest.read_bytes()).hexdigest() + "\n")
    (dest.parent / "source").write_text(source + "\n")
    return dest


def check_config_dir(d: Path) -> list[str]:
    """Hermeticity of a Claude config dir: problems found (empty list = clean)."""
    problems: list[str] = []
    if not d.exists():
        return problems
    for name in ("CLAUDE.md", "claude.md", ".mcp.json", "CLAUDE.local.md"):
        if (d / name).exists():
            problems.append(f"{name} present")
    # Caches Claude Code writes on its own after a login: account-synced skills (`skills/synced`),
    # the plugin marketplace catalog and its sync state. They are catalogs, not installed items;
    # whether anything from them is *loaded* is asserted per run on the init event (skills must be
    # exactly ["compta"], no plugins, no MCP servers).
    synced_caches = {"synced", "marketplaces", "known_marketplaces.json"}
    for sub in CONTENT_DIRS:
        p = d / sub
        if p.is_dir():
            extra = [c.name for c in p.iterdir() if c.name not in synced_caches]
            if extra:
                problems.append(f"{sub}/ not empty: {sorted(extra)}")
    for name in ("settings.json", "settings.local.json"):
        p = d / name
        if p.exists():
            try:
                s = json.loads(p.read_text() or "{}")
            except json.JSONDecodeError:
                problems.append(f"{name} unparsable")
                continue
            bad = [k for k in FORBIDDEN_SETTINGS if s.get(k)]
            if bad:
                problems.append(f"{name} sets {bad}")
    cj = d / ".claude.json"
    if cj.exists():
        try:
            c = json.loads(cj.read_text() or "{}")
        except json.JSONDecodeError:
            c = {}
        if c.get("mcpServers"):
            problems.append(".claude.json has mcpServers")
        for proj, v in (c.get("projects") or {}).items():
            if isinstance(v, dict) and v.get("mcpServers"):
                problems.append(f".claude.json project {proj} has mcpServers")
    projects = d / "projects"
    if projects.is_dir():
        for mem in projects.glob("*/memory"):
            if any(mem.iterdir()):
                problems.append(f"memory in {mem.parent.name}")
    return problems


class ClaudeCodeAgent(AgentAdapter):
    subscription = "claude"

    def __init__(self, id: str, model: str, *, max_turns: int = MAX_TURNS, auth: str = "token") -> None:
        if auth not in AUTH_MODES:
            raise ValueError(f"claude auth must be one of {AUTH_MODES}")
        self.auth = auth
        self.id = id
        self.model = model
        self.max_turns = max_turns
        self.step_budget = max_turns
        self._version: str | None = None

    @staticmethod
    def binary() -> Path:
        """The pinned Claude Code binary (copied into the runtime dir by `prepare-runtime`), so an
        auto-update of the machine's own `claude` can't change the agent mid-benchmark."""
        return pinned_claude()

    @classmethod
    def install_dir(cls) -> Path:
        b = cls.binary()
        # npm: …/@anthropic-ai/claude-code/bin/claude.exe → the package dir; native: its dir
        return b.parent.parent if b.parent.name == "bin" else b.parent

    def set_step_budget(self, n: int) -> None:
        self.step_budget = self.max_turns = n

    def version(self) -> str:
        if self._version is None:
            r = subprocess.run([str(self.binary()), "--version"], capture_output=True, text=True, timeout=60,
                               env={"PATH": "/usr/bin:/bin", "HOME": str(paths.system_temp())})  # fmt: skip
            self._version = r.stdout.strip()
        return self._version

    # ---- auth / hermeticity -----------------------------------------------------------------

    def token_mode(self) -> bool:
        return self.auth == "token"

    def preflight(self) -> None:
        if self.token_mode():
            if not TOKEN_FILE.exists() or not TOKEN_FILE.read_text().strip():
                raise RuntimeError(
                    f"no Claude token: run `claude setup-token` and save the token in {TOKEN_FILE} "
                    "(chmod 600), or opt in to the keychain login with --claude-auth keychain"
                )
            return
        ensure_template()
        reset_config_dir()
        if not keychain_logged_in(self.binary()):
            raise RuntimeError(
                f"no Claude keychain login for {SHARED_CONFIG}: log in once with "
                f"CLAUDE_CONFIG_DIR={SHARED_CONFIG} claude → /login"
            )
        problems = check_config_dir(SHARED_CONFIG)
        if problems:
            raise HermeticityError(f"{SHARED_CONFIG} is not hermetic after reset: {problems}")

    def config_dir(self, sb: Sandbox) -> Path:
        return sb.agent_config if self.token_mode() else SHARED_CONFIG

    def prepare_sandbox(self, sb: Sandbox) -> AgentNeeds:
        skill_dir = sb.work / ".claude" / "skills" / "compta"
        skill_dir.mkdir(parents=True)
        shutil.copy2(sb.runtime.skill_md, skill_dir / "SKILL.md")
        (sb.work / ".claude" / "settings.json").write_text(json.dumps(SETTINGS, indent=2) + "\n")
        env = {"DISABLE_AUTOUPDATER": "1"}
        install = self.install_dir()
        # Claude Code keeps its own temp dir at /tmp/claude-<uid> (TMPDIR is ignored), which is shared
        # with every other Claude session on the machine. Give each run a private, short one (Unix
        # socket paths are limited to ~104 bytes; its IPC sockets live there too, so the shared
        # /tmp/cc-socks is no longer opened); the profile denies the rest of /tmp.
        cc_tmp = Path("/private/tmp") / f"dbc-{hashlib.sha1(sb.run_id.encode()).hexdigest()[:10]}"
        shutil.rmtree(cc_tmp, ignore_errors=True)
        cc_tmp.mkdir(mode=0o700)
        sb.extra_cleanup.append(cc_tmp)
        env["CLAUDE_CODE_TMPDIR"] = str(cc_tmp)
        needs = AgentNeeds(env=env, reads=[install], writes=[cc_tmp],
                           notes={str(install): "Claude Code install", str(cc_tmp): "this run's private Claude Code temp dir"})  # fmt: skip
        if self.token_mode():
            env["CLAUDE_CODE_OAUTH_TOKEN"] = TOKEN_FILE.read_text().strip()
            env["CLAUDE_CONFIG_DIR"] = str(sb.agent_config)
            return needs
        # keychain mode: a pristine config dir for this run
        reset_config_dir()
        problems = check_config_dir(SHARED_CONFIG)
        if problems:
            raise HermeticityError(f"{SHARED_CONFIG} is not hermetic after reset: {problems}")
        env["CLAUDE_CONFIG_DIR"] = str(SHARED_CONFIG)
        # Claude Code finds its config-dir login in the macOS login keychain only through the
        # real HOME (verified: with any other HOME it reports "Not logged in", even with the
        # keychain reachable). So in login mode the Claude process keeps the real HOME; the
        # seatbelt profile still denies every read and write under it outside the allow-list,
        # and the compta wrapper sets its own per-run HOME. Recorded per run (env_keys/home).
        env["HOME"] = str(paths.HOME)
        env["USER"] = os.environ.get("USER") or paths.HOME.name  # keychain account of the login item
        needs.writes.append(SHARED_CONFIG)
        needs.notes[str(SHARED_CONFIG)] = "benchmark-only Claude config dir, reset from the template around each run"
        # Read-only access to the login keychain file only (verified enough to log in); no
        # write: an agent can't add/alter/delete keychain items. Claude Code reads the item by
        # running /usr/bin/security (verified: denying it logs Claude out), so it stays executable.
        needs.rules += [
            f"(allow file-read* (literal {json.dumps(str(KEYCHAIN))}))  ; Claude Code's keychain login (read-only)",
            f"(allow file-read-metadata (literal {json.dumps(str(KEYCHAIN.parent))}))",
            f"(allow file-read-metadata (literal {json.dumps(str(KEYCHAIN.parent.parent))}))",
        ]
        needs.allow_security_exec = True
        return needs

    # ---- turns ------------------------------------------------------------------------------

    def command(self, session: Session, turn: int) -> list[str]:
        argv = [
            str(self.binary()), "-p",
            "--output-format", "stream-json", "--verbose",
            "--model", self.model,
            "--permission-mode", "bypassPermissions",
            "--tools", ",".join(TOOLS),
            "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--setting-sources", "project",
            "--max-turns", str(self.max_turns),
        ]  # fmt: skip
        if turn > 1 and session.id:
            argv += ["--resume", session.id]
        return argv

    def run_turn(
        self, sb: Sandbox, prompt: str, session: Session, *, turn: int, record_dir: Path, timeout_s: float
    ) -> TurnResult:
        record_dir.mkdir(parents=True, exist_ok=True)
        prompt_file = record_dir / f"prompt-turn-{turn}.txt"
        prompt_file.write_text(prompt)
        events_file = record_dir / f"turn-{turn}.claude.jsonl"
        stderr_file = record_dir / f"turn-{turn}.claude.stderr.txt"
        argv = self.command(session, turn)
        proc = sb.run(argv, cwd=sb.work, stdin=prompt_file, stdout=events_file, stderr=stderr_file, timeout=timeout_s)
        token = sb.needs.env.get("CLAUDE_CODE_OAUTH_TOKEN")
        if token:
            redact(record_dir, token)
        norm = Normalized(record_dir, turn)
        parsed = parse_stream(events_file.read_text(errors="replace"), norm)
        norm.final(parsed["final_text"])
        if parsed["session_id"]:
            session.id = parsed["session_id"]
            session.data.setdefault("session_ids", [])
            if parsed["session_id"] not in session.data["session_ids"]:
                session.data["session_ids"].append(parsed["session_id"])
        # `total_cost_usd` is cumulative over a resumed session (Claude Code 2.1.303: turn 2 reports
        # turn 1 + turn 2): the turn's cost is the increase since the session's previous turn.
        cumulative = parsed["result"].get("total_cost_usd")
        seen = session.data.setdefault("cost_cumulative_usd", {})
        previous = seen.get(parsed["session_id"]) if parsed["session_id"] else None
        cost = cumulative if cumulative is None or previous is None else round(cumulative - previous, 9)
        if parsed["session_id"] and cumulative is not None:
            seen[parsed["session_id"]] = cumulative
        status, error, reset = classify(parsed, proc.returncode, proc.timed_out, stderr_file)
        if status == "ok" and parsed["model_requests"] > self.max_turns:
            # Claude Code enforces --max-turns itself; a "successful" turn beyond it would mean the
            # flag didn't hold — never accepted as within budget.
            status, error = "max_turns", f"step budget exceeded: {parsed['model_requests']} model requests > {self.max_turns}"
        init = parsed["init"]
        extra: dict[str, Any] = {
            "always_on_tools": [],
            "model_usage": parsed["result"].get("modelUsage"),
            "claude_num_turns": parsed["result"].get("num_turns"),  # Claude's own count, for audit
        }
        if init:
            problems, always_on = check_init(init, self.model)
            extra["always_on_tools"] = always_on
            if problems:
                status, error = "infra_error", "hermeticity: " + "; ".join(problems)
                extra["hermeticity_failed"] = True
        extra["cost_cumulative_usd"] = cumulative
        return TurnResult(
            turn=turn,
            final_text=parsed["final_text"],
            session_id=session.id,
            transcript=events_file.name,
            usage=parsed["usage"],
            cost_usd=cost,
            num_turns=parsed["model_requests"],
            model_requests=parsed["model_requests"],
            tool_calls=parsed["tool_calls"],
            duration_s=proc.duration_s,
            exit_status=status,
            rate_limit_reset=reset,
            resolved_config={"version": self.version(), "argv": argv[1:], "init": init},
            error=error,
            returncode=proc.returncode,
            extra=extra,
        )

    def private_strings(self, sb: Sandbox) -> list[str]:
        """Account strings from this run's own config (token mode: the fresh per-run config,
        once Claude Code has fetched the account) and from the keychain-mode dir/template."""
        return account_strings([self.config_dir(sb), SHARED_CONFIG, TEMPLATE])

    def finalize(self, sb: Sandbox, record_dir: Path) -> None:
        """Copy this run's session files into the record, record a hash list of everything the
        run left in its config dir, then (keychain mode) restore the pristine config."""
        cfg = self.config_dir(sb)
        token = sb.needs.env.get("CLAUDE_CODE_OAUTH_TOKEN")
        dest = record_dir / "claude-projects"
        projects = cfg / "projects"
        if projects.is_dir():
            slug = re.sub(r"[^A-Za-z0-9]", "-", str(sb.work))
            for p in projects.iterdir():
                if p.is_dir() and (p.name == slug or str(sb.root.name) in p.name):
                    shutil.copytree(p, dest / p.name, dirs_exist_ok=True)
        (record_dir / "claude-config-after.json").write_text(
            json.dumps({"config_dir": str(cfg), "files": snapshot_dir(cfg)}, indent=1) + "\n"
        )
        if token and dest.exists():
            redact(dest, token)
        if not self.token_mode():
            reset_config_dir()


def snapshot_dir(d: Path) -> list[dict[str, Any]]:
    """Every file under d: relative path, size, sha256 (what a run left behind)."""
    out = []
    if not d.is_dir():
        return out
    for p in sorted(d.rglob("*")):
        if p.is_file() and not p.is_symlink():
            out.append({"path": p.relative_to(d).as_posix(), "size": p.stat().st_size,
                        "sha256": hashlib.sha256(p.read_bytes()).hexdigest()})  # fmt: skip
    return out


def ensure_template() -> Path:
    """Create the pristine template once (0700): `.claude.json` with only TEMPLATE_KEYS."""
    if TEMPLATE.is_dir():
        return TEMPLATE
    TEMPLATE.mkdir(mode=0o700, parents=True)
    current: dict[str, Any] = {}
    try:
        current = json.loads((SHARED_CONFIG / ".claude.json").read_text())
    except (OSError, json.JSONDecodeError):
        pass
    kept = {k: current[k] for k in TEMPLATE_KEYS if k in current}
    fd = os.open(TEMPLATE / ".claude.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(kept, f)
    return TEMPLATE


def reset_config_dir(config: Path | None = None, template: Path | None = None) -> None:
    """Wipe the config dir (same path: the keychain item name depends on it) and restore the
    template's files."""
    config, template = config or SHARED_CONFIG, template or TEMPLATE
    if not template.is_dir():
        raise RuntimeError(f"no Claude config template at {template}")
    config.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(config, 0o700)
    for child in config.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()
    for child in template.iterdir():
        if child.is_dir():
            shutil.copytree(child, config / child.name)
        else:
            shutil.copy2(child, config / child.name)


def keychain_logged_in(binary: Path, config: Path | None = None) -> bool:
    """`claude auth status` for the keychain-mode config dir (Claude reads its own item; the
    harness only sees the boolean)."""
    config = config or SHARED_CONFIG
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(paths.HOME), "CLAUDE_CONFIG_DIR": str(config),
           "USER": os.environ.get("USER") or paths.HOME.name, "DISABLE_AUTOUPDATER": "1"}  # fmt: skip
    # Retried: the keychain item can be mid-refresh (e.g. another Claude process on the same config
    # dir renewing the OAuth token), which makes a single check report a transient logout.
    for attempt in range(3):
        try:
            r = subprocess.run([str(binary), "auth", "status", "--json"], capture_output=True, text=True,
                               timeout=60, env=env)  # fmt: skip
            if json.loads(r.stdout).get("loggedIn"):
                return True
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
            pass
        time.sleep(20 * (attempt + 1))
    return False


def account_strings(dirs: list[Path]) -> list[str]:
    """Emails of the subscription account found in these config dirs' `.claude.json`."""
    out: set[str] = set()
    for d in dirs:
        try:
            acct = json.loads((Path(d) / ".claude.json").read_text()).get("oauthAccount") or {}
        except (OSError, json.JSONDecodeError, AttributeError):
            continue
        for k in ("emailAddress", "email"):
            if isinstance(acct.get(k), str) and acct[k]:
                out.add(acct[k])
    return sorted(out, key=len, reverse=True)


def redact(directory: Path, secret: str) -> None:
    if not secret:
        return
    for f in directory.rglob("*"):
        if f.is_file():
            try:
                text = f.read_text()
            except (UnicodeDecodeError, OSError):
                continue
            if secret in text:
                f.write_text(text.replace(secret, "[REDACTED]"))


def check_init(init: dict[str, Any], model: str) -> tuple[list[str], list[str]]:
    """(problems, extra tools) from the stream-json system/init event.

    The tool list must be exactly TOOLS. Any other tool (WebSearch, WebFetch, Agent/Task, an MCP
    tool, …) is a configuration problem: the run becomes `infra_error` (retryable once the
    harness is fixed), never an agent result. Every recorded Claude run had exactly TOOLS."""
    problems = []
    tools = list(init.get("tools") or [])
    mcp_tools = [t for t in tools if t.startswith("mcp__")]
    if mcp_tools:
        problems.append(f"MCP tools {mcp_tools}")
    missing = [t for t in TOOLS if t not in tools]
    if missing:
        problems.append(f"missing tools {missing}")
    always_on = [t for t in tools if t not in TOOLS and not t.startswith("mcp__")]
    if always_on:
        problems.append(f"unexpected tools {always_on}")
    if init.get("mcp_servers"):
        problems.append(f"MCP servers {init['mcp_servers']}")
    if init.get("plugins"):
        problems.append(f"plugins {init['plugins']}")
    skills = [s if isinstance(s, str) else (s.get("name") if isinstance(s, dict) else str(s)) for s in init.get("skills") or []]
    other = [s for s in skills if s and s.split(":")[-1] != "compta"]
    if other:
        problems.append(f"skills other than compta {other}")
    agents = [a for a in init.get("agents") or [] if a not in BUILTIN_AGENTS]
    if agents:
        problems.append(f"custom agents {agents}")
    got = str(init.get("model") or "")
    if got and not (got == model or got.startswith(model)):
        problems.append(f"model {got} != {model}")
    return problems, always_on


def parse_stream(text: str, norm: Normalized | None = None) -> dict[str, Any]:
    init: dict[str, Any] | None = None
    result: dict[str, Any] = {}
    session_id = None
    pending: dict[str, dict[str, Any]] = {}
    rate_events: list[dict[str, Any]] = []
    api_errors: list[str] = []
    last_text = ""
    message_ids: list[str] = []  # one per model response (content blocks arrive as separate events)
    tool_uses = 0
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = e.get("type")
        session_id = e.get("session_id") or session_id
        if t == "system" and e.get("subtype") == "init":
            init = e
        elif t == "rate_limit_event":
            rate_events.append(e.get("rate_limit_info") or e)
        elif t == "assistant":
            if e.get("error"):
                api_errors.append(str(e.get("error")))
            msg = e.get("message") or {}
            if not e.get("is_api_error_message") and msg.get("model") != "<synthetic>":
                mid = msg.get("id") or f"anon-{len(message_ids)}"
                if mid not in message_ids:
                    message_ids.append(mid)
            for block in msg.get("content") or []:
                if block.get("type") == "text":
                    last_text = block.get("text") or ""
                    if norm:
                        norm.message(last_text)
                elif block.get("type") == "tool_use":
                    pending[block.get("id")] = block
                    tool_uses += 1
        elif t == "user":
            content = (e.get("message") or {}).get("content")
            for block in content if isinstance(content, list) else []:
                if block.get("type") != "tool_result":
                    continue
                use = pending.pop(block.get("tool_use_id"), None) or {}
                output = _tool_text(block.get("content"))
                name, inp = use.get("name", "?"), use.get("input") or {}
                if norm:
                    if name == "Bash":
                        norm.command(inp.get("command", ""), output, 1 if block.get("is_error") else 0)
                    else:
                        norm.tool(name, inp, output)
        elif t == "result":
            result = e
    for use in pending.values():  # tool calls without a result (killed mid-call)
        if norm:
            if use.get("name") == "Bash":
                norm.command((use.get("input") or {}).get("command", ""), "", None)
            else:
                norm.tool(use.get("name", "?"), use.get("input"), None)
    u = result.get("usage") or {}
    cache_write = int(u.get("cache_creation_input_tokens") or 0)
    usage = Usage(
        input_tokens=int(u.get("input_tokens") or 0) + cache_write,
        cached_input_tokens=int(u.get("cache_read_input_tokens") or 0),
        output_tokens=int(u.get("output_tokens") or 0),
        cache_write_tokens=cache_write,
    )
    final = result.get("result") if isinstance(result.get("result"), str) and not result.get("is_error") else last_text
    return {
        "init": init,
        "result": result,
        "session_id": session_id,
        "usage": usage,
        "final_text": final or "",
        "rate_events": rate_events,
        "api_errors": api_errors,
        "model_requests": len(message_ids),
        "tool_calls": tool_uses,
    }


def _block_text(block: Any) -> str:
    """Model-visible text of one tool_result content block. Documents/images (Read of a PDF or
    an image) are rendered as a marker with the media type and the sha256 of the bytes."""
    if not isinstance(block, dict):
        return str(block)
    if block.get("type") == "text":
        return block.get("text", "")
    src = block.get("source") or {}
    media = src.get("media_type") or block.get("type", "?")
    data = src.get("data")
    digest = ""
    if isinstance(data, str):
        try:
            digest = " sha256=" + hashlib.sha256(base64.b64decode(data)).hexdigest()
        except (ValueError, binascii.Error):
            digest = ""
    return f"[{block.get('type', 'block')} {media}{digest}]"


def _tool_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(_block_text(c) for c in content)
    return "" if content is None else json.dumps(content)


def classify(parsed: dict[str, Any], returncode: int | None, timed_out: bool, stderr_file: Path | None = None):
    """(exit_status, error, rate_limit_reset) from structured events only."""
    res = parsed["result"]
    rejected = [r for r in parsed["rate_events"] if str(r.get("status", "")).lower() == "rejected"]
    reset: datetime | None = None
    for r in rejected:
        at = r.get("resetsAt") or r.get("resets_at")
        if at:
            reset = datetime.fromtimestamp(int(at), tz=ratelimit.PARIS)
    if timed_out:
        return "timeout", "turn timed out", None
    err_text = "\n".join([str(res.get("result") or "") if res.get("is_error") else "", *parsed["api_errors"],
                          str(res.get("api_error_status") or "")])  # fmt: skip
    if rejected or "rate_limit" in parsed["api_errors"] or res.get("api_error_status") == 429 or (
        res.get("is_error") and ratelimit.is_limit_message(err_text)
    ):
        return "rate_limited", err_text.strip()[-2000:] or "rate limit", reset or ratelimit.parse_reset(err_text)
    if not res:
        stderr = stderr_file.read_text(errors="replace")[-2000:] if stderr_file and stderr_file.exists() else ""
        return "infra_error", f"no result event (exit {returncode}) {stderr}".strip(), None
    sub = res.get("subtype")
    if sub == "error_max_turns":
        return "max_turns", "max turns reached", None
    if res.get("is_error") or (sub and sub != "success"):
        if ratelimit.is_auth_message(err_text) or "authentication_failed" in parsed["api_errors"]:
            return "infra_error", err_text.strip()[-2000:], None
        return "agent_error", (err_text.strip() or str(sub))[-2000:], None
    return "ok", None, None
