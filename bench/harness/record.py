"""Load one run record (an attempt directory) into plain Python objects for the graders.

`load_record(dir)` returns a dict whose keys line up with `bench.graders.rundata.RunData`:
`task`, `final_state`, `log`, `finals`, `messages`, `tool_calls` (shell commands, dicts with
command/output/turn), `tools` (other tool calls), `proposal_text`, `proposal_plans`,
`provided_files`, `exit_status`, `tool_outputs` (every tool call, shell or not, with its
model-visible output), `proposal_texts` (text deliverables frozen after turn 1: {path: text}, None
in records made before they were frozen),
`workspace_dir` (the agent's work/ at the end), plus `run` (run.json) and `scenario_file`.

Every frozen proposal file is checked against the hash recorded when it was frozen
(`RecordIntegrityError` on a mismatch or a missing file).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

#: Text deliverables (reports, tables) frozen with the proposal and readable by the graders when
#: the agent's final message links them; larger files are not read (recorded as skipped).
TEXT_SUFFIXES = (".md", ".txt", ".csv")
TEXT_MAX_BYTES = 512 * 1024


class RecordIntegrityError(RuntimeError):
    """A frozen proposal file no longer has the hash recorded when it was frozen."""


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def attempt_dir(run_dir: Path) -> Path:
    """`<out>/<run-id>/` → the attempt the summary points to; an attempt dir is returned as is."""
    run_dir = Path(run_dir)
    summary = run_dir / "run.json"
    if summary.exists():
        rec = json.loads(summary.read_text())
        if rec.get("record_dir"):
            return run_dir / rec["record_dir"]
    return run_dir


def list_attempts(run_dir: Path) -> list[dict[str, Any]]:
    """Every attempt of a run (`<out>/<run-id>/`), in order, with its fate: each attempt dir is
    self-contained (run.json with usage/cost/exit_status, state.json, log.json, transcript) and
    gradable on its own; `final` is true for the graded attempt, false (+ `replaced_by`) for
    discarded ones (rate limit, infra error, interrupted batch)."""
    out = []
    for p in sorted((Path(run_dir) / "attempts").glob("*/run.json"), key=lambda p: int(p.parent.name)):
        rec = json.loads(p.read_text())
        out.append({"attempt": int(p.parent.name), "dir": str(p.parent), "final": rec.get("final"),
                    "replaced_by": rec.get("replaced_by"), "replacement_reason": rec.get("replacement_reason"),
                    "exit_status": rec.get("exit_status"), "cost_usd": rec.get("cost_usd"),
                    "usage": rec.get("usage")})  # fmt: skip
    return out


def load_record(run_dir: Path) -> dict[str, Any]:
    d = attempt_dir(Path(run_dir))
    run = json.loads((d / "run.json").read_text())
    events = read_jsonl(d / "transcript.normalized.jsonl")
    plans = []
    manifest_file = d / "proposal" / "manifest.json"
    manifest = json.loads(manifest_file.read_text()) if manifest_file.exists() else {"files": []}

    def frozen(entry: dict[str, Any]) -> bytes:
        path = d / "proposal" / "files" / entry["path"]
        try:
            data = path.read_bytes()
        except OSError as e:
            raise RecordIntegrityError(f"{d}: frozen proposal file {entry['path']} is missing ({e})") from e
        if _sha(data) != entry["sha256"]:
            raise RecordIntegrityError(
                f"{d}: frozen proposal file {entry['path']} has sha256 {_sha(data)[:12]}, recorded {entry['sha256'][:12]}"
            )
        return data

    for f in manifest.get("files", []):
        data = frozen(f)
        try:
            plans.append({"path": f["path"], "sha256": f["sha256"], "content": json.loads(data)})
        except (json.JSONDecodeError, UnicodeDecodeError):
            plans.append({"path": f["path"], "sha256": f["sha256"], "content": None})
    # text deliverables; None for records made before they were frozen (no "texts" in the manifest)
    texts = (
        {f["path"]: frozen(f).decode("utf-8", "replace") for f in manifest["texts"] if not f.get("skipped")}
        if "texts" in manifest
        else None
    )
    final_file = d / "proposal" / "final.txt"
    proposal_text = final_file.read_text() if final_file.exists() else ""
    if final_file.exists() and manifest.get("final_sha256") and _sha(final_file.read_bytes()) != manifest["final_sha256"]:
        raise RecordIntegrityError(
            f"{d}: proposal/final.txt has sha256 {_sha(final_file.read_bytes())[:12]}, recorded {manifest['final_sha256'][:12]}"
        )

    def load(name: str, default: Any) -> Any:
        p = d / name
        return json.loads(p.read_text()) if p.exists() else default

    return {
        "dir": str(d),
        "run": run,
        "task": run.get("task", {}),
        "scenario_file": run.get("scenario", {}).get("file"),
        "final_state": load("state.json", {}),
        "log": load("log.json", []),
        "finals": run.get("finals", []),
        "messages": [e["text"] for e in events if e.get("type") == "message"],
        "tool_calls": [
            {"command": e.get("command", ""), "output": e.get("output", ""), "turn": e.get("turn", 1),
             "exit_code": e.get("exit_code")}  # fmt: skip
            for e in events
            if e.get("type") == "command"
        ],
        "tools": [e for e in events if e.get("type") == "tool"],
        # every tool call with its model-visible output, shell or not (Read, Grep, file_change…)
        "tool_outputs": [
            {"turn": e.get("turn", 1), "kind": e["type"], "name": e.get("name", "shell"),
             "command": e.get("command"), "input": e.get("input"), "output": e.get("output") or "",
             "truncated": bool(e.get("truncated"))}  # fmt: skip
            for e in events
            if e.get("type") in ("command", "tool")
        ],
        "events": events,
        "proposal_text": proposal_text,
        "proposal_plans": plans,
        "proposal_texts": texts,
        "workspace_dir": str(d / "workspace"),
        "provided_files": run.get("provided_files", {}),
        "exit_status": run.get("exit_status", "ok"),
    }
