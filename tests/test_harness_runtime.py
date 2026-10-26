"""The runtime fingerprint covers every CLI build input, and dependencies are reinstalled when the
lockfile changes (Phase A review, finding 5). npm is faked: no network, no real build."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bench.harness import paths, runtime


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A fake CLI source dir, certs, harness dir and runtime dir; npm recorded, not run."""
    src = tmp_path / "cli"
    (src / "src").mkdir(parents=True)
    (src / "src" / "cli.ts").write_text("console.log('compta')\n")
    (src / "skills" / "compta").mkdir(parents=True)
    (src / "skills" / "compta" / "SKILL.md").write_text("# compta\n")
    (src / "package.json").write_text(json.dumps({"name": "compta-cli", "version": "0.2.0", "dependencies": {"zod": "^3"}}))
    (src / "package-lock.json").write_text('{"lockfileVersion": 3, "zod": "3.0.0"}\n')
    (src / "tsconfig.json").write_text('{"compilerOptions": {"target": "ES2023"}}\n')
    (src / "tsup.config.ts").write_text("export default { target: 'node22' };\n")
    certs, harness = tmp_path / "certs", tmp_path / "harness"
    certs.mkdir()
    harness.mkdir()
    (certs / "ca.pem").write_text("CA\n")
    (certs / "server.pem").write_text("SERVER\n")
    (harness / "clock-shim.mjs").write_text("// shim\n")
    monkeypatch.setattr(paths, "CERTS_DIR", certs)
    monkeypatch.setattr(paths, "HARNESS_DIR", harness)
    monkeypatch.setattr(paths, "RUNTIME_DIR", tmp_path / "cache" / "runtime")
    monkeypatch.setattr(runtime.shutil, "which", lambda name: "/fake/npm")
    calls: list[str] = []

    def fake_run(argv, cwd=None, check=False, **kw):
        cmd = " ".join(argv[1:])
        calls.append(cmd)
        cwd = Path(cwd)
        if cmd.startswith("ci"):  # like npm ci: a fresh node_modules from the lockfile
            import shutil

            shutil.rmtree(cwd / "node_modules", ignore_errors=True)
            (cwd / "node_modules" / "zod").mkdir(parents=True)
            (cwd / "node_modules" / "zod" / "lock").write_text((cwd / "package-lock.json").read_text())
        elif cmd == "run build":
            (cwd / "dist").mkdir(exist_ok=True)
            inputs = "".join((cwd / f).read_text() for f in ("src/cli.ts", "tsconfig.json", "tsup.config.ts"))
            (cwd / "dist" / "cli.js").write_text(f"// built from {hash(inputs)}\n")

        class Done:
            returncode = 0

        return Done()

    monkeypatch.setattr(runtime.subprocess, "run", fake_run)
    return src, calls


def test_tree_hash_covers_every_build_input(env):
    src, _ = env
    for part in ("tsconfig.json", "tsup.config.ts", "package.json", "package-lock.json"):
        assert part in runtime.TREE_PARTS
    before = runtime.tree_sha256(src)
    for f in ("tsconfig.json", "tsup.config.ts", "src/cli.ts", "skills/compta/SKILL.md", "package-lock.json"):
        p = src / f
        old = p.read_text()
        p.write_text(old + " ")
        assert runtime.tree_sha256(src) != before, f
        p.write_text(old)
    assert runtime.tree_sha256(src) == before


@pytest.mark.parametrize("config", ["tsconfig.json", "tsup.config.ts"])
def test_build_config_change_rebuilds_the_runtime(env, config):
    src, calls = env
    first = runtime.ensure_runtime(src)
    assert calls == ["ci --no-audit --no-fund", "run build"]
    calls.clear()
    assert runtime.ensure_runtime(src).tree_sha256 == first.tree_sha256 and calls == []  # reused
    (src / config).write_text((src / config).read_text().replace("2", "3"))
    second = runtime.ensure_runtime(src)
    assert calls == ["run build"]  # same lockfile: no reinstall
    assert second.tree_sha256 != first.tree_sha256
    assert second.cli_sha256 != first.cli_sha256


def test_lockfile_change_reinstalls_dependencies(env):
    src, calls = env
    runtime.ensure_runtime(src)
    calls.clear()
    (src / "package-lock.json").write_text('{"lockfileVersion": 3, "zod": "3.1.0"}\n')
    rt = runtime.ensure_runtime(src)
    assert calls == ["ci --no-audit --no-fund", "run build"]  # node_modules existed, but was stale
    assert (rt.dir / "node_modules" / "zod" / "lock").read_text() == (src / "package-lock.json").read_text()


def test_node_modules_without_stamp_is_reinstalled(env):
    """A node_modules installed by hand (unknown lockfile) is not trusted."""
    src, calls = env
    (src / "node_modules" / "zod").mkdir(parents=True)
    runtime.ensure_runtime(src)
    assert calls[0].startswith("ci")
    assert runtime.deps_current(src)


def test_pinned_agent_clis_survive_rebuilds(env):
    src, calls = env
    rt = runtime.ensure_runtime(src)
    claude = rt.dir / "claude-code" / "2.1.303" / "claude.exe"
    codex = rt.dir / "codex" / "0.163.0" / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
    for f in (claude, codex):
        f.parent.mkdir(parents=True)
        f.write_text("pinned\n")
    (src / "tsup.config.ts").write_text("export default { target: 'node24' };\n")
    runtime.ensure_runtime(src)
    (src / "package-lock.json").write_text('{"lockfileVersion": 3, "zod": "3.2.0"}\n')
    rt = runtime.ensure_runtime(src)
    assert calls.count("run build") == 3
    assert claude.read_text() == "pinned\n" and codex.read_text() == "pinned\n"
    assert rt.dir == paths.RUNTIME_DIR
