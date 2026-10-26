"""Frozen grading inputs per batch (M3 review): `<out>/inputs/` holds the exact scenario,
truth, documents and task definitions the batch ran on, with `hashes.json`.

    inputs/
      scenario.json, truth.json, MANIFEST.sha256   the scenario as served (copied, not linked)
      files/, mailbox/                             documents already in the books / handed to agents
      tasks/*.yaml                                 the task definitions (all of tasks/)
      tasks.resolved.json                          {task id: the task dict as run (files, prompts)}
      hashes.json                                  {relative path: sha256} of everything above

Before anything runs, the scenario must match its `MANIFEST.sha256` exactly: every listed file
present with its hash, and no other file (`manifest_problems`). This is checked on the source
when the archive is made and on the archive at every start or resume; graders check it again.

The batch then *runs from the archive* (server reset and mailbox copies use `inputs/`), so what
was served and what is graded are the same bytes. A resumed batch keeps its archive even if the
repo's scenario or tasks changed since (a warning is logged); every run.json records the hashes
of the inputs it used (`inputs`). Graders read `inputs/` and refuse mismatching hashes.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

import yaml

from .protocol import TaskSpec

MANIFEST = "MANIFEST.sha256"
SCENARIO_FILES = ("scenario.json", "truth.json", MANIFEST)
SCENARIO_DIRS = ("files", "mailbox")
#: Top-level entries of `inputs/` that are the archive's own, not the scenario's.
ARCHIVE_ONLY = ("tasks", "tasks.resolved.json", "source.json", "hashes.json")
#: OS metadata, never part of a scenario, never copied into an archive.
IGNORED_NAMES = (".DS_Store",)


class ManifestMismatch(RuntimeError):
    """The scenario's files differ from its MANIFEST.sha256 (a file missing, changed or extra)."""


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def canonical_sha(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()


def hash_tree(root: Path) -> dict[str, str]:
    return {
        p.relative_to(root).as_posix(): _sha(p)
        for p in sorted(root.rglob("*"))
        if p.is_file() and p.name != "hashes.json"
    }


def read_manifest(path: Path) -> dict[str, str]:
    """MANIFEST.sha256 → {relative path: sha256}."""
    out = {}
    for line in path.read_text().splitlines():
        if line.strip():
            sha, rel = line.split(maxsplit=1)
            out[rel.strip().lstrip("*")] = sha
    return out


def manifest_problems(root: Path, hashes: dict[str, str] | None = None, skip: tuple[str, ...] = ()) -> list[str]:
    """The scenario under `root` against its MANIFEST.sha256: [] when every listed file exists with
    its hash and no other file exists. `skip`: top-level entries that are not scenario files (an
    archive's `tasks/`, `hashes.json`…). `hashes`: the tree's {relative path: sha256} when already
    known (an archive's verified hashes.json); otherwise the files are hashed here."""
    if not (root / MANIFEST).is_file():
        return [f"no {MANIFEST} in {root}"]
    listed = read_manifest(root / MANIFEST)
    if hashes is None:
        hashes = hash_tree(root)
    actual = {
        rel: sha
        for rel, sha in hashes.items()
        if rel != MANIFEST and rel.split("/", 1)[0] not in skip and rel.rsplit("/", 1)[-1] not in IGNORED_NAMES
    }
    problems = [f"missing: {rel}" for rel in sorted(set(listed) - set(actual))]
    problems += [f"not in the manifest: {rel}" for rel in sorted(set(actual) - set(listed))]
    problems += [f"hash differs: {rel}" for rel in sorted(set(listed) & set(actual)) if listed[rel] != actual[rel]]
    return problems


def check_manifest(root: Path, hashes: dict[str, str] | None = None, skip: tuple[str, ...] = ()) -> None:
    problems = manifest_problems(root, hashes, skip)
    if problems:
        more = f" (+{len(problems) - 10} more)" if len(problems) > 10 else ""
        raise ManifestMismatch(f"{root}: the scenario does not match its {MANIFEST}: " + "; ".join(problems[:10]) + more)


def tasks_source_dir() -> Path:
    from bench.tasks import TASKS_DIR

    return TASKS_DIR


def archive_inputs(out: Path, tasks: dict[str, TaskSpec], log=print) -> tuple[dict[str, TaskSpec], dict[str, Any]]:
    """Create `<out>/inputs/` once; return the tasks re-pointed at the archive and the batch's
    input description (hashes)."""
    inputs = out / "inputs"
    scenario_dirs = {t.scenario_dir for t in tasks.values()}
    if len(scenario_dirs) != 1:
        raise ValueError(f"a batch runs on one scenario (got {sorted(map(str, scenario_dirs))})")
    source = scenario_dirs.pop()
    if not (inputs / "hashes.json").exists():
        staging = out / ".inputs.staging"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        src_dir = source if source.is_dir() else source.parent
        check_manifest(src_dir)  # the complete scenario, before anything is copied or run
        for name in SCENARIO_FILES:
            if (src_dir / name).is_file():
                shutil.copy2(src_dir / name, staging / name)
        for name in SCENARIO_DIRS:
            if (src_dir / name).is_dir():
                shutil.copytree(src_dir / name, staging / name, ignore=shutil.ignore_patterns(*IGNORED_NAMES))
        (staging / "tasks").mkdir()
        tdir = tasks_source_dir()
        for y in sorted(tdir.glob("*.yaml")):
            shutil.copy2(y, staging / "tasks" / y.name)
        resolved = {tid: t.raw for tid, t in sorted(tasks.items())}
        (staging / "tasks.resolved.json").write_text(json.dumps(resolved, indent=1, ensure_ascii=False, default=str) + "\n")
        (staging / "source.json").write_text(json.dumps({"scenario": str(source), "tasks": str(tdir)}, indent=1) + "\n")
        (staging / "hashes.json").write_text(json.dumps(hash_tree(staging), indent=1) + "\n")
        staging.rename(inputs)
    hashes = json.loads((inputs / "hashes.json").read_text())
    if hash_tree(inputs) != hashes:
        raise RuntimeError(f"{inputs} was modified after the batch started (hashes.json mismatch)")
    check_manifest(inputs, hashes, skip=ARCHIVE_ONLY)  # what the agents get is the whole scenario
    resolved = json.loads((inputs / "tasks.resolved.json").read_text())
    # tasks requested now but not archived (a resumed batch extended with new tasks): refuse
    missing = sorted(set(tasks) - set(resolved))
    if missing:
        raise RuntimeError(f"tasks {missing} are not in this batch's archived inputs; use a new --out")
    yaml_of: dict[str, str] = {}
    for y in sorted((inputs / "tasks").glob("*.yaml")):
        try:
            tid = (yaml.safe_load(y.read_text()) or {}).get("id")
        except yaml.YAMLError:
            continue
        if tid:
            yaml_of[tid] = f"tasks/{y.name}"
    out_tasks: dict[str, TaskSpec] = {}
    for tid, t in tasks.items():
        raw = dict(resolved[tid])
        if canonical_sha(raw) != canonical_sha(t.raw):
            log(f"warning: task {tid} differs from the archived version; running the archived one")
        raw["scenario"] = str(inputs)
        out_tasks[tid] = TaskSpec(raw)
    if (source / "scenario.json").is_file() and (inputs / "scenario.json").is_file():
        if _sha(source / "scenario.json") != hashes.get("scenario.json"):
            log(f"warning: {source}/scenario.json changed since this batch started; running the archived one")
    info = {
        "dir": "inputs",
        "hashes_sha256": _sha(inputs / "hashes.json"),
        "files": {k: hashes[k] for k in SCENARIO_FILES if k in hashes},
        "task_yaml": yaml_of,
        "task_resolved_sha256": {tid: canonical_sha(resolved[tid]) for tid in tasks},
        "_hashes": hashes,  # not recorded as such (hashes.json is in the archive)
    }
    return out_tasks, info


def run_inputs(info: dict[str, Any] | None, task_id: str) -> dict[str, Any] | None:
    """The `inputs` block of one run.json."""
    if not info:
        return None
    hashes_file = info.get("_hashes", {})
    yaml_rel = info["task_yaml"].get(task_id)
    files = dict(info["files"])
    if yaml_rel and yaml_rel in hashes_file:
        files[yaml_rel] = hashes_file[yaml_rel]
    return {
        "dir": info["dir"],
        "hashes_sha256": info["hashes_sha256"],
        "files": files,
        "task_resolved_sha256": info["task_resolved_sha256"].get(task_id),
    }
