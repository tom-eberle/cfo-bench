"""Per-run sandbox (DESIGN.md §5): run directory, `compta` wrapper, logged-in compta CLI config,
mailbox subset, seatbelt profile, environment allow-list, process-group execution, self-test.

Layout (`$TMPDIR/cfo-bench/<run-id>/`, real path):

    work/          the agent's cwd: the task's mailbox subset (work/<dir>/) + the skill
    home/          HOME for the agent and for compta (XDG config/cache inside)
    bin/           compta (wrapper), node, jq — the only tools besides /usr/bin:/bin:/usr/sbin:/sbin
    agent-config/  CODEX_HOME (Codex) or a fresh CLAUDE_CONFIG_DIR (Claude, token mode)
    tmp/           TMPDIR for the agent
    sandbox.sb     the seatbelt profile for this run

Every agent process runs as `sandbox-exec -f sandbox.sb …`, in its own process group, with an
environment built from scratch (never inherited from the harness).
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from collections.abc import Callable
from typing import Any

from . import paths
from .runtime import Runtime

SANDBOX_EXEC = "/usr/bin/sandbox-exec"
SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
BASE_ENV_KEYS = ("PATH", "HOME", "TMPDIR", "TZ", "LANG", "LC_ALL")


class SandboxError(RuntimeError):
    pass


@dataclass
class AgentNeeds:
    """What an agent adds to the sandbox: extra env vars and allow-listed paths."""

    env: dict[str, str] = field(default_factory=dict)
    reads: list[Path] = field(default_factory=list)  # read-only
    writes: list[Path] = field(default_factory=list)  # read + write
    notes: dict[str, str] = field(default_factory=dict)  # path -> why (README/profile comments)
    #: extra SBPL rules (with a `; why` comment), appended after the allow-lists
    rules: list[str] = field(default_factory=list)
    #: /usr/bin/security may be executed (Claude Code's keychain login reads its credentials
    #: with it); denied otherwise so an agent can't query the keychain
    allow_security_exec: bool = False


@dataclass
class Sandbox:
    run_id: str
    root: Path
    api_port: int
    as_of: str
    company_id: str
    session: str
    runtime: Runtime
    node: Path
    workspace_dir: str | None = None
    provided_files: list[str] = field(default_factory=list)
    needs: AgentNeeds = field(default_factory=AgentNeeds)
    extra_cleanup: list[Path] = field(default_factory=list)  # e.g. Claude Code's private /tmp dir
    #: also unreadable wherever they live (the scenario being served, the run record, the batch)
    deny_reads: list[Path] = field(default_factory=list)

    work = property(lambda self: self.root / "work")
    home = property(lambda self: self.root / "home")
    bin = property(lambda self: self.root / "bin")
    agent_config = property(lambda self: self.root / "agent-config")
    tmp = property(lambda self: self.root / "tmp")
    profile = property(lambda self: self.root / "sandbox.sb")

    # ---- environment ------------------------------------------------------------------------

    def base_env(self) -> dict[str, str]:
        return {
            "PATH": f"{self.bin}:{SYSTEM_PATH}",
            "HOME": str(self.home),
            "TMPDIR": f"{self.tmp}/",
            "TZ": "Europe/Paris",
            "LANG": "fr_FR.UTF-8",
            "LC_ALL": "fr_FR.UTF-8",
        }

    @property
    def env(self) -> dict[str, str]:
        """The complete environment of agent processes: the allow-list, nothing inherited."""
        return {**self.base_env(), **self.needs.env}

    @property
    def allowed_env_keys(self) -> set[str]:
        return set(BASE_ENV_KEYS) | set(self.needs.env)

    # ---- execution --------------------------------------------------------------------------

    def run(
        self,
        argv: list[str],
        *,
        cwd: Path | None = None,
        env: dict[str, str] | None = None,
        stdin: bytes | Path | None = None,
        stdout: Path | None = None,
        stderr: Path | None = None,
        timeout: float = 900.0,
        monitor: Callable[[], str | None] | None = None,
    ) -> ProcResult:
        return run_sandboxed(
            self.profile, argv, env=env or self.env, cwd=cwd or self.work,
            stdin=stdin, stdout=stdout, stderr=stderr, timeout=timeout, monitor=monitor,
        )  # fmt: skip

    def sh(self, command: str, *, timeout: float = 120.0, cwd: Path | None = None) -> ProcResult:
        """`/bin/sh -c command` inside the sandbox, output captured (via files, not pipes)."""
        cap = self.tmp / f".cap-{time.monotonic_ns()}"
        out, err = cap.with_suffix(".out"), cap.with_suffix(".err")
        res = self.run(["/bin/sh", "-c", command], cwd=cwd, stdout=out, stderr=err, timeout=timeout)
        res.stdout = out.read_text(errors="replace")
        res.stderr = err.read_text(errors="replace")
        out.unlink(missing_ok=True)
        err.unlink(missing_ok=True)
        return res

    def cleanup(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)
        for extra in self.extra_cleanup:
            shutil.rmtree(extra, ignore_errors=True)


@dataclass
class ProcResult:
    returncode: int | None
    timed_out: bool
    duration_s: float
    stdout: str = ""
    stderr: str = ""
    stopped: str | None = None  # reason given by the monitor that stopped the process


def kill_group(pgid: int, grace: float = 2.0) -> None:
    """SIGTERM the whole process group, then SIGKILL whatever is left."""
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except PermissionError:
        pass
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        try:
            os.killpg(pgid, 0)
        except (ProcessLookupError, PermissionError):
            return
        time.sleep(0.05)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def run_sandboxed(
    profile: Path,
    argv: list[str],
    *,
    env: dict[str, str],
    cwd: Path,
    stdin: bytes | Path | None = None,
    stdout: Path | None = None,
    stderr: Path | None = None,
    timeout: float = 900.0,
    monitor: Callable[[], str | None] | None = None,
    poll_s: float = 0.25,
) -> ProcResult:
    """Run argv under the seatbelt profile in a new session (= process group). On timeout or
    once the main process has exited, the whole group is killed (no stray background jobs).
    `monitor`, if given, is polled every `poll_s` while the process runs; returning a reason
    string stops the turn (group killed) and is reported as `ProcResult.stopped`."""
    files = []

    def opened(p: Path | None, mode: str):
        if p is None:
            return subprocess.DEVNULL
        p.parent.mkdir(parents=True, exist_ok=True)
        f = p.open(mode)
        files.append(f)
        return f

    if isinstance(stdin, Path):
        stdin_arg: Any = opened(stdin, "rb")
    elif isinstance(stdin, bytes):
        stdin_arg = subprocess.PIPE
    else:
        stdin_arg = subprocess.DEVNULL
    start = time.monotonic()
    proc = subprocess.Popen(
        [SANDBOX_EXEC, "-f", str(profile), *argv],
        cwd=cwd,
        env=env,
        stdin=stdin_arg,
        stdout=opened(stdout, "ab"),
        stderr=opened(stderr, "ab"),
        start_new_session=True,
    )
    timed_out = False
    stopped = None
    try:
        if isinstance(stdin, bytes):
            assert proc.stdin
            try:
                proc.stdin.write(stdin)
                proc.stdin.close()
            except BrokenPipeError:
                pass
        if monitor is None:
            proc.wait(timeout=timeout)
        else:
            deadline = start + timeout
            while proc.poll() is None:
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(argv, timeout)
                reason = monitor()
                if reason:
                    stopped = reason
                    break
                time.sleep(poll_s)
    except subprocess.TimeoutExpired:
        timed_out = True
    finally:
        kill_group(proc.pid)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            pass
        for f in files:
            f.close()
    return ProcResult(
        returncode=None if (timed_out or stopped) else proc.returncode,
        timed_out=timed_out,
        stopped=stopped,
        duration_s=time.monotonic() - start,
    )


# ---- building ---------------------------------------------------------------------------------


def node_prefix(node: Path) -> Path:
    """The Node installation (…/versions/node/vX): node itself plus global packages (agents)."""
    return node.parent.parent


def build_sandbox(
    run_id: str,
    *,
    runtime: Runtime,
    api_port: int,
    scenario: dict[str, Any],
    scenario_dir: Path,
    workspace: dict[str, Any] | None,
    agent: Any = None,
    root: Path | None = None,
    node: Path | None = None,
    deny_reads: list[Path] | None = None,
) -> Sandbox:
    """Create the run directory, wrapper, compta CLI config, mailbox copy, agent files and profile.

    `agent` is an adapter with `prepare_sandbox(sb) -> AgentNeeds` (installs its skill/config)."""
    base = Path(root or paths.sandbox_root())
    base.mkdir(parents=True, exist_ok=True)
    run_root = base / run_id
    if run_root.exists():
        shutil.rmtree(run_root)
    sb = Sandbox(
        run_id=run_id,
        root=run_root,
        api_port=api_port,
        as_of=str(scenario["as_of"]),
        company_id=str(scenario["company"]["id"]),
        session=str(scenario["api_token"]),
        runtime=runtime,
        node=Path(node or paths.node_binary()),
        deny_reads=[Path(os.path.realpath(p)) for p in (deny_reads or [])],
    )
    for d in (sb.work, sb.home, sb.bin, sb.agent_config, sb.tmp):
        d.mkdir(parents=True)
    _write_wrapper(sb)
    os.symlink(sb.node, sb.bin / "node")
    jq = shutil.which("jq", path=SYSTEM_PATH) or shutil.which("jq")
    if jq:
        os.symlink(os.path.realpath(jq), sb.bin / "jq")
    _write_cli_config(sb)
    _copy_workspace(sb, scenario_dir, workspace)
    if agent is not None:
        sb.needs = agent.prepare_sandbox(sb) or AgentNeeds()
    sb.profile.write_text(render_profile(sb))
    return sb


def _write_wrapper(sb: Sandbox) -> None:
    rt = sb.runtime
    q = shell_quote
    script = f"""#!/bin/sh
# cfo-bench: the compta CLI (compta-cli {rt.version}, source tree {rt.tree_sha256[:12]}) against the fake Compta server.
unset COMPTA_SESSION COMPTA_COMPANY
export COMPTA_API_BASE={q(f"https://localhost:{sb.api_port}")}
export NODE_EXTRA_CA_CERTS={q(str(rt.ca_pem))}
export COMPTA_CREDENTIAL_STORE=file
export COMPTA_PROFILE=bench
export HOME={q(str(sb.home))}
export XDG_CONFIG_HOME={q(str(sb.home / ".config"))}
export XDG_CACHE_HOME={q(str(sb.home / ".cache"))}
export CFO_BENCH_NOW={q(sb.as_of)}
exec {q(str(sb.node))} --import {q(rt.clock_shim.as_uri())} {q(str(rt.cli_js))} "$@"
"""
    wrapper = sb.bin / "compta"
    wrapper.write_text(script)
    wrapper.chmod(0o755)


def _write_cli_config(sb: Sandbox) -> None:
    """Logged in exactly like the CLI's test/helpers/run.ts (profile "bench", file store, API token)."""
    d = sb.home / ".config" / "compta-cli"
    d.mkdir(parents=True)
    cfg = {
        "activeProfile": "bench",
        "profiles": {"bench": {"session": sb.session, "source": "token", "companyId": sb.company_id}},
    }
    p = d / "config.json"
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f)


def _copy_workspace(sb: Sandbox, scenario_dir: Path, workspace: dict[str, Any] | None) -> None:
    if not workspace or not workspace.get("dir"):
        return
    dest = sb.work / workspace["dir"]
    dest.mkdir(parents=True, exist_ok=True)
    src_dir = scenario_dir / workspace.get("source", "mailbox")
    for name in workspace.get("files") or []:
        src = src_dir / name
        if not src.is_file():
            raise SandboxError(f"workspace file missing: {src}")
        shutil.copy2(src, dest / Path(name).name)
        sb.provided_files.append(Path(name).name)
    sb.workspace_dir = workspace["dir"]


def shell_quote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


# ---- seatbelt profile ---------------------------------------------------------------------------


def _sb(s: str | Path) -> str:
    return json.dumps(str(s))  # SBPL strings use C-style escapes; JSON quoting is compatible


#: Places shared by every process of the user (world-writable dirs found with
#: `find -x <root> -maxdepth 2 -type d -perm -0002` on /private, /Users, /Library, plus the
#: user's own temp dir): another run, the harness or another program could leave files there.
#: Unreadable from the sandbox; writes are denied everywhere outside the allow-list anyway.
SHARED_SCRATCH_READ_DENIED = ("/private/tmp", "/private/var/tmp", "/Users/Shared")
#: Writable by this user outside $HOME (world-writable or admin-writable), denied by the global
#: write deny; listed for the self-test and the cross-run canary test.
SHARED_WRITABLE = (
    "/private/tmp", "/private/var/tmp", "/Users/Shared", "/Library/Caches", "/private/var/OOPJit",
    "/private/var/db/mds", "/private/var/db/DiagnosticsReporter", "/Applications", "/usr/local",
)  # fmt: skip
SECURITY_BINARIES = ("/usr/bin/security",)


def user_dirs() -> dict[str, Path]:
    """The user's per-user dirs under /private/var/folders (temp T, cache C, 0)."""
    t = paths.system_temp()
    return {"T": t, "C": t.parent / "C", "0": t.parent / "0"}


def render_profile(sb: Sandbox) -> str:
    home = paths.HOME
    runs = Path(os.path.realpath(sb.root.parent))
    root = Path(os.path.realpath(sb.root))
    user_t = user_dirs()["T"]
    reads: list[tuple[Path, str]] = [
        (node_prefix(sb.node), "Node (compta CLI, agent CLIs installed as global npm packages)"),
        (sb.runtime.dir, "runtime copy of the compta CLI build, CA cert, clock shim"),
        *[(Path(p), sb.needs.notes.get(str(p), "agent")) for p in sb.needs.reads],
    ]
    writes: list[tuple[Path, str]] = [
        (Path(p), sb.needs.notes.get(str(p), "agent")) for p in sb.needs.writes
    ]
    lines = [
        "(version 1)",
        f";; cfo-bench seatbelt profile for run {sb.run_id} (generated; see bench/harness/README.md)",
        "(allow default)",
        "",
        ";; --- reads: nothing under $HOME, nothing of other runs, no shared scratch space ...",
        f"(deny file-read* (subpath {_sb(home)}))",
        f"(deny file-read* (subpath {_sb(runs)}))",
        f"(deny file-read* (subpath {_sb(user_t)}))  ; the user's temp dir (harness, other programs)",
        *[f"(deny file-read* (subpath {_sb(d)}))  ; shared scratch" for d in SHARED_SCRATCH_READ_DENIED],
        *[f"(allow file-read-metadata (literal {_sb(d)}))" for d in SHARED_SCRATCH_READ_DENIED],
        *[f"(deny file-read* (subpath {_sb(d)}))  ; harness data (scenario served, records)" for d in sb.deny_reads],
        ";; ... except this allow-list (later rules win)",
        f"(allow file-read* (subpath {_sb(root)}))  ; this run",
    ]
    # every ancestor of the run root and of the allowed dirs, whatever TMPDIR is: with
    # TMPDIR=/tmp/a/b/c, /private/tmp/a and /private/tmp/a/b sit inside the denied /private/tmp,
    # and realpath() (node's included) lstat()s each of them
    meta: set[Path] = {runs, *runs.parents, *root.parents}
    for p, why in reads + writes:
        p = Path(os.path.realpath(p))
        lines.append(f"(allow file-read* (subpath {_sb(p)}))  ; {why}")
        meta.update(p.parents)
    lines.append(";; path resolution (stat/realpath) through the parents of allowed dirs, no listing")
    for m in sorted(meta | {user_t}):
        lines.append(f"(allow file-read-metadata (literal {_sb(m)}))")
    lines += [
        "",
        ";; --- writes: nowhere (no shared scratch, no caches, nothing a later run could find) ...",
        '(deny file-write* (subpath "/"))',
        ";; ... except devices (null, ttys, ptys), this run, and the agent's allow-list",
        '(allow file-write* (subpath "/dev"))',
        f"(allow file-write* (subpath {_sb(root)}))",
    ]
    for p, why in writes:
        lines.append(f"(allow file-write* (subpath {_sb(os.path.realpath(p))}))  ; {why}")
    if sb.needs.rules:
        lines += ["", ";; --- agent-specific rules", *sb.needs.rules]
    lines += [
        "",
        ";; --- network: no loopback except the fake API port (the admin port stays unreachable)",
        '(deny network-outbound (remote ip "localhost:*"))',
        f'(allow network-outbound (remote ip "localhost:{sb.api_port}"))',
        "",
        ";; --- no peeking at other processes (argv/env of the server and the harness)",
        "(deny process-info* (target others))",
    ]
    if not sb.needs.allow_security_exec:
        lines += [";; --- no keychain queries", *[f"(deny process-exec (literal {_sb(b)}))" for b in SECURITY_BINARIES]]
    lines.append("")
    return "\n".join(lines)


# ---- self-test ------------------------------------------------------------------------------------


@dataclass
class SelftestResult:
    ok: bool
    checks: list[dict[str, Any]]

    def summary(self) -> str:
        return "; ".join(f"{c['name']}={'ok' if c['ok'] else 'FAIL'}" for c in self.checks)


def selftest(sb: Sandbox, *, admin_port: int, scenario_dir: Path | None = None) -> SelftestResult:
    """Inside the profile: truth/scenario unreadable, repo unlistable, other runs and the agent
    homes unlistable, $HOME unwritable, admin port unreachable, `compta whoami` works, and the
    environment holds only allow-listed names."""
    checks: list[dict[str, Any]] = []

    def must_fail(name: str, cmd: str) -> None:
        r = sb.sh(cmd, timeout=30)
        ok = r.returncode not in (0, None) and not r.stdout.strip()
        checks.append({"name": name, "ok": ok, "rc": r.returncode, "stderr": r.stderr.strip()[-300:]})

    must_fail("tmp_unwritable", "echo x > /tmp/cfo-bench-selftest-$$ && echo wrote")
    must_fail("tmp_unlistable", "/bin/ls /tmp/")
    canary = f".cfo-bench-selftest-{sb.run_id}"
    for d in [*SHARED_WRITABLE, *[str(p) for p in user_dirs().values()]]:
        if Path(d).is_dir():
            target = Path(d) / canary
            must_fail(f"shared_write:{d}", f"/usr/bin/touch {shell_quote(str(target))} && echo written")
            if target.exists():
                target.unlink()
    for d in SHARED_SCRATCH_READ_DENIED:
        must_fail(f"shared_list:{d}", f"/bin/ls {shell_quote(d)}")
    must_fail("list_user_temp", f"/bin/ls {shell_quote(str(user_dirs()['T']))}")
    if not sb.needs.allow_security_exec:
        must_fail("exec_security", "/usr/bin/security list-keychains && echo ran")

    q = shell_quote
    if scenario_dir is not None:
        secret = scenario_dir / "truth.json"
        if not secret.exists():
            secret = scenario_dir / "scenario.json"
        must_fail("read_truth", f"/bin/cat {q(str(secret))}")
    must_fail("list_repo", f"/bin/ls {q(str(paths.REPO_ROOT))}")
    must_fail("read_admin_token", f"/bin/cat {q(str(paths.STATE_DIR / 'admin-token'))}")
    must_fail("list_other_runs", f"/bin/ls {q(str(sb.root.parent))}")
    for d in (".codex", ".claude", ".ssh", "Developer"):
        if (paths.HOME / d).exists():
            must_fail(f"list_home_{d.strip('.')}", f"/bin/ls {q(str(paths.HOME / d))}")
    probe = paths.HOME / f".cfo-bench-selftest-{sb.run_id}"
    must_fail("write_home", f"/usr/bin/touch {q(str(probe))} && echo written")
    if probe.exists():
        probe.unlink()
    for host in ("127.0.0.1", "localhost"):
        must_fail(
            f"admin_port_{host}",
            f"/usr/bin/curl -s -m 5 -o /dev/null http://{host}:{admin_port}/__health && echo reached",
        )
    r = sb.sh("compta whoami --json", timeout=60)
    who_ok = r.returncode == 0
    try:
        who_ok = who_ok and sb.company_id in json.dumps(json.loads(r.stdout))
    except json.JSONDecodeError:
        who_ok = False
    checks.append({"name": "cli_whoami", "ok": who_ok, "rc": r.returncode, "stderr": r.stderr.strip()[-300:]})
    r = sb.sh("/usr/bin/env", timeout=30)
    keys = {line.split("=", 1)[0] for line in r.stdout.splitlines() if "=" in line}
    extra = sorted(keys - sb.allowed_env_keys - {"PWD", "SHLVL", "_", "OLDPWD"})
    checks.append({"name": "env_allow_list", "ok": r.returncode == 0 and not extra, "extra": extra})
    return SelftestResult(ok=all(c["ok"] for c in checks), checks=checks)
