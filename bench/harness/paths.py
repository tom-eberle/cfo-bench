"""Fixed locations used by the harness. Everything the agent may read lives outside the repo."""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
HARNESS_DIR = Path(__file__).resolve().parent

#: Git-ignored harness state inside the repo (admin token, …). Unreadable from the sandbox.
STATE_DIR = REPO_ROOT / ".state"
CERTS_DIR = REPO_ROOT / ".certs"
SCENARIOS_DIR = REPO_ROOT / "scenarios"

HOME = Path(os.path.realpath(Path.home()))
#: The runtime copy of the compta CLI build (outside the repo and outside ~/Developer).
#: `FRENCH_CFO_BENCH_CACHE_DIR` moves it (e.g. one per checkout, so parallel checkouts don't
#: rebuild each other's runtime); it must stay outside the repo.
CACHE_DIR = Path(os.path.realpath(os.environ.get("FRENCH_CFO_BENCH_CACHE_DIR") or HOME / ".cache" / "french-cfo-bench"))
RUNTIME_DIR = CACHE_DIR / "runtime"
#: Benchmark-only agent logins (Claude config dir, Codex auth master copy).
BENCH_CONFIG_DIR = HOME / ".config" / "french-cfo-bench"

#: The compta CLI source the runtime is built from (vendored in the repo; DESIGN.md §5).
CLI_SRC = Path(os.environ.get("FRENCH_CFO_BENCH_CLI_SRC") or REPO_ROOT / "cli")


def sandbox_root() -> Path:
    """`$TMPDIR/french-cfo-bench`, as a real path (seatbelt matches real paths: /private/var/…)."""
    return Path(os.path.realpath(tempfile.gettempdir())) / "french-cfo-bench"


def system_temp() -> Path:
    return Path(os.path.realpath(tempfile.gettempdir()))


def resolve_binary(name: str) -> Path:
    """`which name`, symlinks followed."""
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(f"{name} not found on PATH")
    return Path(os.path.realpath(found))


def node_binary() -> Path:
    return resolve_binary(os.environ.get("FRENCH_CFO_BENCH_NODE", "node"))
