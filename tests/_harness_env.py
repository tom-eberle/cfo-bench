"""Shared fixtures for tests/test_harness_*.py: the CLI runtime, the mini scenario served by
the real fake server, and scripted tasks. Skipped where the macOS sandbox or the compta CLI
build (`cli/dist/cli.js`, `npm run build` in cli/) is unavailable."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

from bench.harness import paths

MINI = paths.REPO_ROOT / "server" / "test" / "fixtures" / "mini"
FIXTURES = Path(__file__).parent / "fixtures" / "harness"

needs_sandbox = pytest.mark.skipif(
    sys.platform != "darwin"
    or not Path("/usr/bin/sandbox-exec").exists()
    or not (paths.CLI_SRC / "dist" / "cli.js").exists()
    or shutil.which("node") is None,
    reason="needs macOS sandbox-exec, node and the compta CLI build (cli/dist/cli.js)",
)


def mini_scenario() -> dict:
    return json.loads((MINI / "scenario.json").read_text())


def mini_task(id: str = "t-mini", mode: str = "write", workspace: dict | None = None, **extra) -> dict:
    return {
        "id": id,
        "family": "test",
        "language": "fr",
        "mode": mode,
        "scenario": str(MINI),
        "prompt": "Teste le harnais.",
        "workspace": workspace or {"dir": None},
        **extra,
    }


@pytest.fixture(scope="session")
def runtime():
    from bench.harness.runtime import ensure_runtime

    return ensure_runtime()


@pytest.fixture(scope="session")
def server():
    from bench.harness.server import FakeServer

    with FakeServer(MINI) as s:
        yield s


@pytest.fixture()
def sandbox_root(tmp_path_factory):
    """A private sandbox base (still under the real temp dir, like production)."""
    root = paths.sandbox_root().parent / f"french-cfo-bench-test-{tmp_path_factory.getbasetemp().name}"
    root.mkdir(parents=True, exist_ok=True)
    yield root
    shutil.rmtree(root, ignore_errors=True)
