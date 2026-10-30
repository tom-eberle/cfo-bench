"""Sandbox: self-test (truth unreadable, admin unreachable, compta works), env allow-list,
process-group kill on timeout."""

from __future__ import annotations

import os
import time
from pathlib import Path

from _harness_env import MINI, mini_scenario, needs_sandbox, runtime, sandbox_root, server  # noqa: F401

from bench.harness import paths
from bench.harness.sandbox import BASE_ENV_KEYS, AgentNeeds, build_sandbox, render_profile, selftest

pytestmark = needs_sandbox


def make(runtime, server, sandbox_root, run_id="sb", agent=None, workspace=None):  # noqa: F811
    return build_sandbox(
        run_id,
        runtime=runtime,
        api_port=server.api_port,
        scenario=mini_scenario(),
        scenario_dir=MINI,
        workspace=workspace,
        agent=agent,
        root=sandbox_root,
    )


def test_selftest_passes(runtime, server, sandbox_root):  # noqa: F811
    sb = make(runtime, server, sandbox_root)
    res = selftest(sb, admin_port=server.admin_port, scenario_dir=MINI)
    names = {c["name"]: c["ok"] for c in res.checks}
    assert res.ok, res.checks
    for must in ("read_truth", "list_repo", "read_admin_token", "list_other_runs", "write_home",
                 "admin_port_127.0.0.1", "admin_port_localhost", "cli_whoami", "env_allow_list"):  # fmt: skip
        assert names[must], must


def test_selftest_detects_a_broken_profile(runtime, server, sandbox_root):  # noqa: F811
    sb = make(runtime, server, sandbox_root, "broken")
    sb.profile.write_text("(version 1)\n(allow default)\n")  # no restrictions at all
    res = selftest(sb, admin_port=server.admin_port, scenario_dir=MINI)
    failed = {c["name"] for c in res.checks if not c["ok"]}
    assert not res.ok
    assert {"read_truth", "list_repo", "admin_port_127.0.0.1"} <= failed


def test_compta_wrapper_and_workspace(runtime, server, sandbox_root):  # noqa: F811
    sb = make(runtime, server, sandbox_root, "ws",
              workspace={"dir": "factures", "source": "files", "files": ["cloud-2026-07.pdf"]})  # fmt: skip
    assert (sb.work / "factures" / "cloud-2026-07.pdf").exists()
    assert sb.provided_files == ["cloud-2026-07.pdf"]
    r = sb.sh("compta ops list --json")
    assert r.returncode == 0, r.stderr
    assert '"id": "1008"' in r.stdout
    # the clock shim (loaded by the wrapper with CFO_BENCH_NOW=as_of) shifts the CLI's "today"
    as_of = mini_scenario()["as_of"]
    assert f"export CFO_BENCH_NOW='{as_of}'" in (sb.bin / "compta").read_text()
    shim = runtime.clock_shim.as_uri()
    r = sb.sh(f"CFO_BENCH_NOW={as_of} node --import {shim} -e 'console.log(new Date().toISOString())'")
    assert r.stdout.startswith(as_of), r.stdout + r.stderr
    cfg = (sb.home / ".config" / "compta-cli" / "config.json").read_text()
    assert '"activeProfile": "bench"' in cfg and mini_scenario()["api_token"] in cfg
    assert oct((sb.home / ".config" / "compta-cli" / "config.json").stat().st_mode & 0o777) == "0o600"


def test_env_allow_list_exact(runtime, server, sandbox_root, monkeypatch):  # noqa: F811
    """Nothing from the harness environment leaks into agent processes."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-leak")
    monkeypatch.setenv("COMPTA_SESSION", "should-not-leak")
    monkeypatch.setenv("SOME_RANDOM_VAR", "x")

    class Agent:
        def prepare_sandbox(self, sb):
            return AgentNeeds(env={"CODEX_HOME": str(sb.agent_config)})

    sb = make(runtime, server, sandbox_root, "env", agent=Agent())
    r = sb.sh("/usr/bin/env")
    names = {line.split("=", 1)[0] for line in r.stdout.splitlines() if "=" in line}
    assert names - {"PWD", "SHLVL", "_", "OLDPWD"} == set(BASE_ENV_KEYS) | {"CODEX_HOME"}
    assert "sk-should-not-leak" not in r.stdout
    env = dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)
    assert env["HOME"] == str(sb.home) and env["TZ"] == "Europe/Paris" and env["LANG"] == "fr_FR.UTF-8"
    assert env["PATH"].split(":")[0] == str(sb.bin)


def test_process_group_killed_on_timeout(runtime, server, sandbox_root):  # noqa: F811
    sb = make(runtime, server, sandbox_root, "kill")
    pidfile = sb.tmp / "bg.pid"
    t0 = time.monotonic()
    r = sb.run(["/bin/sh", "-c", f"sleep 300 & echo $! > {pidfile}; sleep 300"], timeout=2)
    assert r.timed_out and time.monotonic() - t0 < 15
    pid = int(pidfile.read_text())
    time.sleep(0.2)
    try:
        os.kill(pid, 0)
        alive = True
    except ProcessLookupError:
        alive = False
    assert not alive, "background child survived the turn"


def test_leftover_background_jobs_killed_at_turn_end(runtime, server, sandbox_root):  # noqa: F811
    sb = make(runtime, server, sandbox_root, "leftover")
    pidfile = sb.tmp / "bg.pid"
    r = sb.run(["/bin/sh", "-c", f"sleep 300 & echo $! > {pidfile}"], timeout=30)
    assert not r.timed_out and r.returncode == 0
    pid = int(pidfile.read_text())
    time.sleep(0.2)
    try:
        os.kill(pid, 0)
        alive = True
    except ProcessLookupError:
        alive = False
    assert not alive


def test_profile_allow_list(runtime, server, sandbox_root):  # noqa: F811
    sb = make(runtime, server, sandbox_root, "prof")
    text = render_profile(sb)
    assert f'(deny file-read* (subpath "{paths.HOME}"))' in text
    assert f'(allow network-outbound (remote ip "localhost:{server.api_port}"))' in text
    assert str(server.admin_port) not in text
    assert "(deny process-info* (target others))" in text


def test_deep_tmpdir_resolves_paths(runtime, server, tmp_path_factory):  # noqa: F811
    """A sandbox root several directories below /tmp (TMPDIR=/tmp/a/b/c): the agent can still
    resolve paths in its run dir (realpath stats every ancestor), so `compta ops attach` finds
    its file. Before the fix, /tmp/a was unreadable even as metadata (FILE_NOT_FOUND)."""
    import shutil
    import tempfile

    top = Path(os.path.realpath(tempfile.mkdtemp(prefix="fcb-deep-", dir="/tmp")))
    root = top / "b" / "c" / "cfo-bench"
    root.mkdir(parents=True)
    try:
        sb = make(runtime, server, root, "deep",
                  workspace={"dir": "factures", "source": "files", "files": ["cloud-2026-07.pdf"]})  # fmt: skip
        r = sb.sh("node -e \"console.log(require('fs').realpathSync('factures/cloud-2026-07.pdf'))\"")
        assert r.returncode == 0 and r.stdout.strip().endswith("factures/cloud-2026-07.pdf"), r.stderr
        r = sb.sh("compta ops attach 1008 factures/cloud-2026-07.pdf --dry-run --json")
        assert "FILE_NOT_FOUND" not in r.stdout + r.stderr, r.stdout + r.stderr
        assert r.returncode == 0, r.stdout + r.stderr
        profile = sb.profile.read_text()
        for d in (top, top / "b", top / "b" / "c"):
            assert f'(allow file-read-metadata (literal "{d}"))' in profile, d
        # still no listing of the shared scratch dir or of the ancestors
        assert sb.sh(f"ls {top}").returncode != 0
        assert sb.sh("ls /private/tmp").returncode != 0
    finally:
        shutil.rmtree(top, ignore_errors=True)
