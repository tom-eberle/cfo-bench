"""The runtime copy of the compta CLI that agents execute.

`~/.cache/french-cfo-bench/runtime/` holds `dist/`, `package.json`, the production
`node_modules/` (commander, unpdf, zod), `skills/`, the local CA certificate and the clock shim,
plus `runtime.json` (source tree hash, bundle and file hashes). Agents read this copy, never the
repo or `~/Developer`, which the sandbox denies.

The CLI is vendored in the repo (`cli/`). The runtime is (re)built from it when its build inputs
(`tree_sha256`: `cli/src`, `cli/skills`, `cli/package.json`, `cli/package-lock.json`,
`cli/tsconfig.json`, `cli/tsup.config.ts`) or the shim/CA change: `npm ci` when
`cli/node_modules` is missing or was installed from another lockfile (stamp
`node_modules/.french-cfo-bench-lock.sha256`), then `npm run build`. The pinned agent CLIs
(`claude-code/`, `codex/`) are kept across rebuilds.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from . import paths

FORMAT = 3
#: Everything the CLI's build reads (relative to the CLI source dir): the sources, the skill
#: shipped next to the bundle, the dependency manifest and lock, the TypeScript and tsup configs.
TREE_PARTS = ("src", "skills", "package.json", "package-lock.json", "tsconfig.json", "tsup.config.ts")
LOCKFILE = "package-lock.json"
#: Written into `node_modules/` after `npm ci`: the sha256 of the lockfile it was installed from.
DEPS_STAMP = ".french-cfo-bench-lock.sha256"
SKILL = Path("skills") / "compta" / "SKILL.md"


@dataclass(frozen=True)
class Runtime:
    dir: Path
    cli_js: Path
    ca_pem: Path
    clock_shim: Path
    skill_md: Path
    tree_sha256: str
    cli_sha256: str
    version: str

    @property
    def skill_text(self) -> str:
        return self.skill_md.read_text()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tree_sha256(src: Path) -> str:
    """One hash over the CLI's build inputs: every file under TREE_PARTS, by relative path."""
    h = hashlib.sha256()
    for part in TREE_PARTS:
        root = src / part
        files = sorted(p for p in root.rglob("*") if p.is_file()) if root.is_dir() else [root]
        for f in files:
            if not f.is_file():
                raise FileNotFoundError(f"compta CLI source incomplete: {f} missing")
            h.update(f.relative_to(src).as_posix().encode() + b"\0" + sha256_file(f).encode() + b"\n")
    return h.hexdigest()


def ensure_certs() -> None:
    if not (paths.CERTS_DIR / "ca.pem").exists() or not (paths.CERTS_DIR / "server.pem").exists():
        subprocess.run([str(paths.REPO_ROOT / "scripts" / "make-certs.sh")], check=True)


def deps_current(src: Path) -> bool:
    """`node_modules` exists and was installed (by `build_cli`) from the current lockfile."""
    stamp = src / "node_modules" / DEPS_STAMP
    return stamp.is_file() and stamp.read_text().strip() == sha256_file(src / LOCKFILE)


def build_cli(src: Path) -> None:
    """`npm ci` when node_modules is missing or was installed from another lockfile, then
    `npm run build`, in the CLI source dir."""
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("npm not found on PATH: needed to build the compta CLI")
    if not deps_current(src):
        lock = sha256_file(src / LOCKFILE)
        subprocess.run([npm, "ci", "--no-audit", "--no-fund"], cwd=src, check=True)
        (src / "node_modules" / DEPS_STAMP).write_text(lock + "\n")
    subprocess.run([npm, "run", "build"], cwd=src, check=True)
    if not (src / "dist" / "cli.js").is_file():
        raise RuntimeError(f"`npm run build` in {src} produced no dist/cli.js")


def _inputs(src: Path) -> dict:
    """Everything except the bundle hash, which needs a build first."""
    return {
        "format": FORMAT,
        "tree_sha256": tree_sha256(src),
        "skill_sha256": sha256_file(src / SKILL),
        "shim_sha256": sha256_file(paths.HARNESS_DIR / "clock-shim.mjs"),
        "ca_sha256": sha256_file(paths.CERTS_DIR / "ca.pem"),
    }


def ensure_runtime(src: Path | None = None, *, force: bool = False) -> Runtime:
    """Create (or reuse) the runtime dir and return its description. Rebuilds the CLI from
    source when the source tree, skill, shim or CA differ from the runtime's (or with `force`)."""
    src = Path(src or paths.CLI_SRC)
    ensure_certs()
    wanted = _inputs(src)
    target = paths.RUNTIME_DIR
    meta_path = target / "runtime.json"
    current = json.loads(meta_path.read_text()) if meta_path.exists() else None
    if force or not current or any(current.get(k) != v for k, v in wanted.items()):
        build_cli(src)
        _build(src, target, {**wanted, "cli_sha256": sha256_file(src / "dist" / "cli.js")})
    return load_runtime(target)


def _build(src: Path, target: Path, wanted: dict) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    staging = target.parent / f"runtime.staging-{int(time.time() * 1000)}"
    staging.mkdir()
    shutil.copytree(src / "dist", staging / "dist")
    shutil.copy2(src / "package.json", staging / "package.json")
    shutil.copytree(src / "skills", staging / "skills")
    package = json.loads((src / "package.json").read_text())
    for pkg in sorted(package.get("dependencies") or {}):  # production packages only
        shutil.copytree(src / "node_modules" / pkg, staging / "node_modules" / pkg, symlinks=False)
    shutil.copy2(paths.CERTS_DIR / "ca.pem", staging / "ca.pem")
    shutil.copy2(paths.HARNESS_DIR / "clock-shim.mjs", staging / "clock-shim.mjs")
    meta = {**wanted, "version": package["version"], "source": str(src), "created": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    (staging / "runtime.json").write_text(json.dumps(meta, indent=2) + "\n")
    old = None
    if target.exists():
        old = target.parent / f"runtime.old-{int(time.time() * 1000)}"
        target.rename(old)
        # the pinned agent CLIs (Claude Code, Codex) live in the runtime dir too; keep them across
        # CLI rebuilds
        for pinned in ("claude-code", "codex"):
            if (old / pinned).is_dir():
                (old / pinned).rename(staging / pinned)
    staging.rename(target)
    if old:
        shutil.rmtree(old, ignore_errors=True)


def load_runtime(target: Path | None = None) -> Runtime:
    target = Path(target or paths.RUNTIME_DIR)
    meta = json.loads((target / "runtime.json").read_text())
    return Runtime(
        dir=target,
        cli_js=target / "dist" / "cli.js",
        ca_pem=target / "ca.pem",
        clock_shim=target / "clock-shim.mjs",
        skill_md=target / SKILL,
        tree_sha256=meta["tree_sha256"],
        cli_sha256=meta["cli_sha256"],
        version=meta["version"],
    )


def npm_install(prefix: Path, spec: str) -> None:
    """`npm install <spec>` into a private prefix (never a global install). Used to pin the exact
    agent CLI versions the benchmark was run with (agents/claude_code.py, agents/codex.py)."""
    node = paths.node_binary()
    npm = node.parent / "npm"
    if not npm.exists():
        npm = paths.resolve_binary("npm")
    prefix.mkdir(parents=True, exist_ok=True)
    env = {"PATH": f"{node.parent}:/usr/bin:/bin", "HOME": str(paths.HOME), "TMPDIR": str(paths.system_temp())}
    r = subprocess.run(
        [str(npm), "install", "--no-save", "--no-audit", "--no-fund", "--prefix", str(prefix), spec],
        capture_output=True, text=True, timeout=900, env=env,
    )  # fmt: skip
    if r.returncode != 0:
        raise RuntimeError(f"npm install {spec} failed ({r.returncode}): {r.stderr.strip()[-2000:]}")
