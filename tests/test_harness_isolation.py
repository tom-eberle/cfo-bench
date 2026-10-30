"""M3 review: no shared scratch between runs, pristine Claude config, keychain/security rules,
redaction from the run's own auth config."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import types
import uuid
from pathlib import Path

import pytest
from _harness_env import MINI, mini_scenario, needs_sandbox, runtime, sandbox_root, server  # noqa: F401

from bench.harness import protocol
from bench.harness.agents import claude_code as cc
from bench.harness.agents.codex import jwt_emails
from bench.harness.sandbox import (
    SHARED_SCRATCH_READ_DENIED,
    SHARED_WRITABLE,
    AgentNeeds,
    build_sandbox,
    selftest,
    shell_quote,
    user_dirs,
)


def make(runtime, server, root, run_id, agent=None):  # noqa: F811
    return build_sandbox(run_id, runtime=runtime, api_port=server.api_port, scenario=mini_scenario(),
                         scenario_dir=MINI, workspace=None, agent=agent, root=root)  # fmt: skip


class Private:
    """An agent with a private dir outside the run root (like Claude Code's CLAUDE_CODE_TMPDIR)."""

    def __init__(self, d: Path) -> None:
        self.d = d

    def prepare_sandbox(self, sb):
        self.d.mkdir(mode=0o700, exist_ok=True)
        sb.extra_cleanup.append(self.d)
        return AgentNeeds(writes=[self.d], notes={str(self.d): "private dir"})


@needs_sandbox
def test_cross_run_canaries(runtime, server, sandbox_root):  # noqa: F811
    """Run A tries to leave a canary everywhere it might; run B must find none of them."""
    canary = f"cfo-bench-canary-{uuid.uuid4().hex[:8]}"
    priv_a = Path(f"/private/tmp/dbt-{canary[-8:]}a")
    priv_b = Path(f"/private/tmp/dbt-{canary[-8:]}b")
    a = make(runtime, server, sandbox_root, "canary-a", Private(priv_a))
    b = make(runtime, server, sandbox_root, "canary-b", Private(priv_b))
    try:
        shared = [*SHARED_WRITABLE, *(str(p) for p in user_dirs().values()), "/private/tmp", str(sandbox_root)]
        allowed = [str(a.root), str(a.tmp), str(priv_a)]
        written = {}
        for d in shared + allowed:
            target = f"{d}/{canary}"
            r = a.sh(f"echo secret > {shell_quote(target)} && echo ok")
            written[d] = r.stdout.strip() == "ok"
        assert not any(written[d] for d in shared), {d: w for d, w in written.items() if w}
        assert all(written[d] for d in allowed), written
        # B sees nothing: not the shared places, not A's run dir, not A's private dir
        for d in shared + allowed:
            r = b.sh(f"cat {shell_quote(d + '/' + canary)} 2>/dev/null; ls {shell_quote(d)} 2>/dev/null | grep -c {canary}")
            assert "secret" not in r.stdout, d
            assert r.stdout.strip() in ("", "0"), (d, r.stdout)
        # and nothing exists outside the run's own dirs
        for d in shared:
            assert not Path(d, canary).exists(), d
    finally:
        for d in [*SHARED_WRITABLE, *(str(p) for p in user_dirs().values())]:
            Path(d, canary).unlink(missing_ok=True)
        a.cleanup()
        b.cleanup()
    assert not priv_a.exists() and not priv_b.exists()


@needs_sandbox
def test_selftest_covers_shared_scratch_and_security(runtime, server, sandbox_root):  # noqa: F811
    sb = make(runtime, server, sandbox_root, "st")
    res = selftest(sb, admin_port=server.admin_port, scenario_dir=MINI)
    names = {c["name"]: c["ok"] for c in res.checks}
    assert res.ok, [c for c in res.checks if not c["ok"]]
    assert names["exec_security"] and names["list_user_temp"]
    for d in SHARED_SCRATCH_READ_DENIED:
        assert names[f"shared_list:{d}"]
    assert "cc-socks" not in sb.profile.read_text()
    assert '(deny process-exec (literal "/usr/bin/security"))' in sb.profile.read_text()


# ---- Claude auth modes -------------------------------------------------------------------------


@pytest.fixture()
def claude_dirs(tmp_path, monkeypatch):
    cfg, tpl, tok = tmp_path / "claude-config", tmp_path / "claude-config.template", tmp_path / "token"
    monkeypatch.setattr(cc, "SHARED_CONFIG", cfg)
    monkeypatch.setattr(cc, "TEMPLATE", tpl)
    monkeypatch.setattr(cc, "TOKEN_FILE", tok)
    monkeypatch.setattr(protocol, "PRIVATE_STRINGS_FILE", tmp_path / "private-strings.json")
    return types.SimpleNamespace(cfg=cfg, tpl=tpl, tok=tok)


def test_shared_config_dir_env_override(tmp_path):
    """CFO_BENCH_CLAUDE_CONFIG_DIR replaces the keychain-mode config dir; unset or empty
    keeps the default; the path is used as given (no symlink resolution: the keychain item is
    named after it); a relative path is refused."""
    from bench.harness import paths

    default = paths.BENCH_CONFIG_DIR / "claude-config"
    assert cc.shared_config_dir({}) == default
    assert cc.shared_config_dir({cc.CONFIG_DIR_ENV: "  "}) == default
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "logged-in-config"
    link.symlink_to(real)
    assert cc.shared_config_dir({cc.CONFIG_DIR_ENV: str(link)}) == link
    assert cc.shared_config_dir({cc.CONFIG_DIR_ENV: "~/x/claude-config"}) == Path.home() / "x" / "claude-config"
    with pytest.raises(ValueError, match="absolute"):
        cc.shared_config_dir({cc.CONFIG_DIR_ENV: "relative/claude-config"})
    # read at import: the module constant, the reset target and the template location
    code = ("from bench.harness.agents import claude_code as cc; "
            "print(cc.SHARED_CONFIG); print(cc.TEMPLATE)")
    env = {k: v for k, v in os.environ.items() if k != cc.CONFIG_DIR_ENV}
    out = subprocess.run([sys.executable, "-c", code], env={**env, cc.CONFIG_DIR_ENV: str(link)},
                         capture_output=True, text=True, check=True, cwd=paths.REPO_ROOT).stdout.split()
    assert out == [str(link), str(cc.TEMPLATE)]
    out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, check=True,
                         cwd=paths.REPO_ROOT).stdout.split()
    assert out == [str(default), str(cc.TEMPLATE)]


def test_pristine_config_reset_and_after_snapshot(tmp_path, claude_dirs):
    cfg = claude_dirs.cfg
    cfg.mkdir()
    (cfg / ".claude.json").write_text(json.dumps({"oauthAccount": {"emailAddress": "x@example.test"}, "numStartups": 3}))
    cc.ensure_template()
    assert json.loads((claude_dirs.tpl / ".claude.json").read_text()) == {}  # TEMPLATE_KEYS = ()
    assert oct(claude_dirs.tpl.stat().st_mode & 0o777) == "0o700"
    # a run leaves things behind (answers in a cache, sessions, memory)
    (cfg / "cache").mkdir()
    (cfg / "cache" / "answer.txt").write_text("42")
    (cfg / "projects" / "-work").mkdir(parents=True)
    (cfg / "projects" / "-work" / "s.jsonl").write_text("{}")
    sb = types.SimpleNamespace(work=Path("/w/work"), root=Path("/w"), needs=AgentNeeds(), agent_config=tmp_path / "ac")
    agent = cc.ClaudeCodeAgent("c", "claude-haiku-5-5", auth="keychain")
    rec = tmp_path / "rec"
    rec.mkdir()
    agent.finalize(sb, rec)
    after = json.loads((rec / "claude-config-after.json").read_text())
    assert {f["path"] for f in after["files"]} >= {"cache/answer.txt", "projects/-work/s.jsonl", ".claude.json"}
    assert sorted(p.name for p in cfg.iterdir()) == [".claude.json"]
    assert json.loads((cfg / ".claude.json").read_text()) == {}


@needs_sandbox
def test_keychain_mode_profile(runtime, server, sandbox_root, claude_dirs):  # noqa: F811
    claude_dirs.cfg.mkdir()
    (claude_dirs.cfg / "cache").mkdir()
    (claude_dirs.cfg / "cache" / "left-by-earlier-run").write_text("x")
    cc.ensure_template()
    agent = cc.ClaudeCodeAgent("c", "claude-haiku-5-5", auth="keychain")
    sb = make(runtime, server, sandbox_root, "kc", agent)
    try:
        text = sb.profile.read_text()
        kc = cc.KEYCHAIN
        assert f'(allow file-read* (literal "{kc}"))' in text
        assert str(kc.parent) not in [l.split('"')[1] for l in text.splitlines() if l.startswith("(allow file-write*")]
        assert "Keychains" not in "".join(l for l in text.splitlines() if l.startswith("(allow file-write*"))
        assert "(deny process-exec" not in text  # Claude Code reads its login with /usr/bin/security
        assert sb.needs.allow_security_exec
        assert sorted(p.name for p in claude_dirs.cfg.iterdir()) == [".claude.json"]  # reset before the run
        # the keychain file is readable, nothing else of the Keychains dir
        r = sb.sh(f"ls {shell_quote(str(kc.parent))}")
        assert r.returncode != 0
        r = sb.sh(f"touch {shell_quote(str(kc.parent / 'x'))} && echo wrote")
        assert "wrote" not in r.stdout
    finally:
        sb.cleanup()


@needs_sandbox
def test_token_mode_profile(runtime, server, sandbox_root, claude_dirs):  # noqa: F811
    claude_dirs.tok.write_text("sk-ant-oat01-test-token\n")
    agent = cc.ClaudeCodeAgent("c", "claude-haiku-5-5", auth="token")
    agent.preflight()
    sb = make(runtime, server, sandbox_root, "tok", agent)
    try:
        text = sb.profile.read_text()
        assert "Keychains" not in text and '(deny process-exec (literal "/usr/bin/security"))' in text
        assert sb.needs.env["CLAUDE_CONFIG_DIR"] == str(sb.agent_config)
        assert sb.needs.env["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-ant-oat01-test-token"
        res = selftest(sb, admin_port=server.admin_port, scenario_dir=MINI)
        assert res.ok, [c for c in res.checks if not c["ok"]]
    finally:
        sb.cleanup()
    with pytest.raises(RuntimeError, match="setup-token"):
        claude_dirs.tok.unlink()
        agent.preflight()


# ---- redaction ---------------------------------------------------------------------------------


def _record_with(tmp_path: Path, text: str) -> Path:
    rec = tmp_path / "rec"
    rec.mkdir()
    (rec / "transcript.normalized.jsonl").write_text(text)
    return rec


def test_redaction_token_mode_uses_the_runs_own_config(tmp_path, claude_dirs):
    """Token mode, no shared config at all: the email comes from the fresh per-run config."""
    ac = tmp_path / "agent-config"
    ac.mkdir()
    (ac / ".claude.json").write_text(json.dumps({"oauthAccount": {"emailAddress": "owner@example.test"}}))
    claude_dirs.tok.write_text("tok")
    agent = cc.ClaudeCodeAgent("c", "m", auth="token")
    sb = types.SimpleNamespace(agent_config=ac)
    found = agent.private_strings(sb)
    assert found == ["owner@example.test"]
    rec = _record_with(tmp_path, '{"text": "userEmail: owner@example.test"}')
    assert protocol.redact_record(rec, found) == 1
    assert "owner@example.test" not in (rec / "transcript.normalized.jsonl").read_text()
    # remembered for later records, even once the run config is gone
    shutil.rmtree(ac)
    rec2 = tmp_path / "rec2"
    rec2.mkdir()
    (rec2 / "x.txt").write_text("owner@example.test")
    assert protocol.redact_record(rec2) == 1


def test_redaction_keychain_mode(tmp_path, claude_dirs):
    claude_dirs.cfg.mkdir()
    (claude_dirs.cfg / ".claude.json").write_text(json.dumps({"oauthAccount": {"emailAddress": "kc@example.test"}}))
    agent = cc.ClaudeCodeAgent("c", "m", auth="keychain")
    found = agent.private_strings(types.SimpleNamespace(agent_config=tmp_path / "none"))
    assert "kc@example.test" in found
    rec = _record_with(tmp_path, "mail kc@example.test")
    assert protocol.redact_record(rec, found) == 1


def test_redaction_rehashes_frozen_proposal_files(tmp_path, claude_dirs):
    """A redacted frozen proposal file stays verifiable: its manifest hash (in manifest.json and
    run.json) is updated, the pre-redaction hash kept (M5 review #2)."""
    from bench.harness.record import load_record

    work = tmp_path / "work"
    work.mkdir()
    (work / "review.md").write_text("contact: me@example.test")
    (work / "p.plan.json").write_text('{"version": 1, "steps": []}')
    rec = tmp_path / "batch" / "run-1" / "attempts" / "1"  # redacted from the batch dir (leak test)
    rec.mkdir(parents=True)
    manifest = protocol.freeze_proposal(work, "Plan for me@example.test", rec / "proposal")
    (rec / "run.json").write_text(json.dumps({"task": {}, "finals": ["Plan for me@example.test"], "proposal": manifest}))
    assert protocol.redact_record(tmp_path / "batch", ["me@example.test"]) == 3  # final.txt, review.md, run.json
    r = load_record(rec)
    assert r["proposal_text"] == "Plan for <redacted-email>"
    assert r["proposal_texts"] == {"review.md": "contact: <redacted-email>"}
    m = json.loads((rec / "proposal" / "manifest.json").read_text())
    assert m["final_sha256_before_redaction"] == manifest["final_sha256"] != m["final_sha256"]
    assert "sha256_before_redaction" in m["texts"][0] and "sha256_before_redaction" not in m["files"][0]
    assert json.loads((rec / "run.json").read_text())["proposal"] == m


def test_codex_email_from_id_token(tmp_path):
    import base64

    payload = base64.urlsafe_b64encode(json.dumps({"email": "dev@example.test"}).encode()).decode().rstrip("=")
    (tmp_path / "auth.json").write_text(json.dumps({"tokens": {"id_token": f"h.{payload}.s"}}))
    assert jwt_emails(tmp_path / "auth.json") == ["dev@example.test"]
