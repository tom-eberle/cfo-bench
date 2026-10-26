"""One run = one (agent, task, repeat) attempt, under the two-phase protocol (DESIGN.md §6).

    reset server → build sandbox → self-test → turn 1 (date + prompt [+ standing instruction])
    → kill process group → freeze proposal (final text + every *.json and text deliverable
      (*.md/*.txt/*.csv) in work/, hashed)
    → POST /__mark turn-2 → turn 2 (approval, write tasks only) → collect → run.json

Record layout (`<record_dir>/`, one per attempt):

    run.json                        summary (see `run_one`)
    transcript.normalized.jsonl     every message / command / tool call / final, by turn
    prompt-turn-N.txt               what the agent received
    turn-N.<agent>.jsonl            raw event stream (Claude stream-json, Codex --json)
    state.json, log.json            /__state and /__log at the end
    proposal/                       frozen turn-1 proposal: final.txt + plan files + text
                                    deliverables + manifest.json
    workspace/                      work/ at the end, minus unchanged harness-provided files
                                    (mailbox copy, skill, settings); run.json lists any the
                                    agent modified (`modified_inputs`)
    selftest.json, sandbox.sb       sandbox evidence
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from . import paths
from .agents.base import STEP_BUDGET, AgentAdapter, Session, TurnResult, Usage
from .record import TEXT_MAX_BYTES, TEXT_SUFFIXES
from .runtime import Runtime
from .sandbox import build_sandbox, selftest
from .server import FakeServer

DEFAULT_TIMEOUT_S = 15 * 60
SCHEMA = 1


class SelftestFailed(RuntimeError):
    pass


# ---- tasks --------------------------------------------------------------------------------------


@dataclass
class TaskSpec:
    """Thin wrapper over a task dict from `bench.tasks.load_tasks` (extra keys kept in `raw`)."""

    raw: dict[str, Any]

    id = property(lambda self: self.raw["id"])
    family = property(lambda self: self.raw.get("family"))
    language = property(lambda self: self.raw.get("language", "fr"))
    mode = property(lambda self: self.raw.get("mode", "write"))
    prompt = property(lambda self: self.raw.get("prompt", ""))
    workspace = property(lambda self: self.raw.get("workspace") or {})
    limits = property(lambda self: self.raw.get("limits") or {})

    @property
    def turn1_prompt(self) -> str:
        if self.raw.get("turn1_prompt"):
            return self.raw["turn1_prompt"]
        from bench.tasks import first_turn_prompt

        return first_turn_prompt(self.raw)

    @property
    def turn2_prompt(self) -> str | None:
        if "turn2_prompt" in self.raw:
            return self.raw["turn2_prompt"]
        from bench.tasks import approval_prompt

        return approval_prompt(self.raw) if self.mode == "write" else None

    @property
    def scenario_dir(self) -> Path:
        s = str(self.raw.get("scenario") or "")
        p = Path(s)
        if p.is_absolute():
            return p
        if "/" in s:
            return (paths.REPO_ROOT / p).resolve()
        return paths.SCENARIOS_DIR / s

    def step_budget(self) -> int:
        return int(self.limits.get("max_responses", STEP_BUDGET))

    def timeout_s(self, default: float = DEFAULT_TIMEOUT_S) -> float:
        return float(self.limits.get("timeout_s", default))

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> TaskSpec:
        return cls(dict(d))


def load_task_specs(scenario: str | Path | None = None, only: list[str] | None = None) -> list[TaskSpec]:
    from bench.tasks import DEFAULT_SCENARIO, load_tasks

    sd = Path(scenario) if scenario else paths.SCENARIOS_DIR / DEFAULT_SCENARIO
    if not sd.is_absolute():
        sd = (paths.REPO_ROOT / sd) if "/" in str(scenario) else paths.SCENARIOS_DIR / str(scenario)
    return [TaskSpec(t) for t in load_tasks(sd, only)]


# ---- helpers ------------------------------------------------------------------------------------


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _dump(path: Path, obj: Any) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1, default=str) + "\n")


#: harness-installed files that are not the agent's output
_INSTALLED = {".claude/settings.json", ".claude/skills/compta/SKILL.md", "AGENTS.md"}


def freeze_proposal(work: Path, final_text: str, dest: Path, baseline: dict[str, str] | None = None) -> dict[str, Any]:
    """Copy the turn-1 final message, every *.json under work/ (plan files, wherever the agent
    saved them) and every text deliverable (*.md, *.txt, *.csv: the reports a final message
    links to) into dest, hashed. Harness-installed files and files still identical to what the
    harness provided (`baseline`) are left out of the texts; a text file over TEXT_MAX_BYTES is
    listed with `skipped` and not copied. Returns the manifest: `files` (plans, as before) and `texts`."""
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "final.txt").write_text(final_text)
    baseline = baseline or {}

    def copy(p: Path, *, text: bool = False) -> dict[str, Any] | None:
        rel = p.relative_to(work).as_posix()
        if rel in _INSTALLED or not p.is_file() or (text and p.is_symlink()):
            return None
        data = p.read_bytes()
        if text and baseline.get(rel) == sha256_bytes(data):
            return None
        entry = {"path": rel, "sha256": sha256_bytes(data), "size": len(data)}
        if text and len(data) > TEXT_MAX_BYTES:
            return {**entry, "skipped": f"over {TEXT_MAX_BYTES} bytes"}
        target = dest / "files" / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return entry

    files = [e for p in sorted(work.rglob("*.json")) if (e := copy(p))]
    texts = [e for p in sorted(work.rglob("*")) if p.suffix.lower() in TEXT_SUFFIXES and (e := copy(p, text=True))]
    manifest = {
        "final_sha256": sha256_bytes(final_text.encode()),
        "files": files,
        "texts": texts,
        "present": bool(final_text.strip()) or bool(files),
    }
    _dump(dest / "manifest.json", manifest)
    return manifest


def snapshot(work: Path) -> dict[str, str]:
    """sha256 of every file the harness put in work/ (skill, settings, mailbox copy)."""
    return {p.relative_to(work).as_posix(): sha256_bytes(p.read_bytes())
            for p in sorted(work.rglob("*")) if p.is_file() and not p.is_symlink()}  # fmt: skip


def copy_workspace(work: Path, dest: Path, baseline: dict[str, str]) -> tuple[list[str], list[str]]:
    """Copy work/ minus the unchanged harness-provided files (mailbox copy, skill, settings).
    Returns (copied paths, provided files the agent modified or deleted)."""
    copied, modified = [], []
    seen = set()
    for p in sorted(work.rglob("*")):
        if not p.is_file() or p.is_symlink():
            continue
        rel = p.relative_to(work).as_posix()
        seen.add(rel)
        if rel in baseline:
            if sha256_bytes(p.read_bytes()) == baseline[rel]:
                continue
            modified.append(rel)
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, target)
        copied.append(rel)
    modified += [f"{rel} (deleted)" for rel in baseline if rel not in seen]
    return copied, modified


#: Private strings discovered so far (0600, outside every sandbox allow-list), so a record is
#: redacted even when the run's own config no longer holds them (keychain mode resets it).
PRIVATE_STRINGS_FILE = paths.BENCH_CONFIG_DIR / "private-strings.json"


def private_strings(discovered: list[str] | None = None) -> list[str]:
    """Personal strings that must never reach a run record: the subscription account's email
    (Claude Code injects it into the model context as `userEmail`). Sources: the strings the
    agent adapter found in this run's own auth config (`agent.private_strings(sb)`), the
    keychain-mode config dir, and the persisted list of earlier discoveries (updated here)."""
    from .agents.claude_code import SHARED_CONFIG, TEMPLATE, account_strings

    known: set[str] = set()
    try:
        known.update(json.loads(PRIVATE_STRINGS_FILE.read_text()))
    except (OSError, json.JSONDecodeError):
        pass
    new = set(discovered or []) | set(account_strings([SHARED_CONFIG, TEMPLATE]))
    if new - known:
        known |= new
        try:
            PRIVATE_STRINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(PRIVATE_STRINGS_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(sorted(known), f)
        except OSError:
            pass
    return sorted((k for k in known if k), key=len, reverse=True)


def redact_record(record_dir: Path, discovered: list[str] | None = None) -> int:
    """Replace private strings in every text file of a run record; returns files changed. A frozen
    proposal file changed here gets its manifest hash updated (old hash kept as
    `sha256_before_redaction`, in proposal/manifest.json and run.json), so the record stays
    verifiable (`record.load_record` checks every frozen hash)."""
    secrets = private_strings(discovered)
    changed: list[Path] = []
    if not secrets:
        return 0
    for f in record_dir.rglob("*"):
        if not f.is_file() or f.suffix in (".pdf", ".png", ".jpg"):
            continue
        try:
            text = f.read_text()
        except (UnicodeDecodeError, OSError):
            continue
        new = text
        for s in secrets:
            new = new.replace(s, "<redacted-email>")
        if new != text:
            f.write_text(new)
            changed.append(f)
    _rehash_redacted_proposal(record_dir, changed)
    return len(changed)


def _rehash_redacted_proposal(record_dir: Path, changed: list[Path]) -> None:
    """Update the manifest of every frozen proposal (record_dir may hold several records) a
    redacted file belongs to."""
    by_proposal: dict[Path, set[str]] = {}
    for p in changed:
        proposal = next((a for a in p.parents if a.name == "proposal" and (a / "manifest.json").is_file()), None)
        if proposal is not None and proposal.is_relative_to(record_dir):
            by_proposal.setdefault(proposal, set()).add(p.relative_to(proposal).as_posix())
    for proposal, redacted in by_proposal.items():
        if not redacted - {"manifest.json"}:
            continue
        manifest = json.loads((proposal / "manifest.json").read_text())

        def rehash(entry: dict[str, Any], rel: str, key: str = "sha256") -> None:
            if rel in redacted:
                entry[f"{key}_before_redaction"] = entry[key]
                entry[key] = sha256_bytes((proposal / rel).read_bytes())

        rehash(manifest, "final.txt", "final_sha256")
        for e in [*manifest.get("files", []), *manifest.get("texts", [])]:
            if not e.get("skipped"):
                rehash(e, f"files/{e['path']}")
        _dump(proposal / "manifest.json", manifest)
        run_json = proposal.parent / "run.json"
        if run_json.exists():
            rec = json.loads(run_json.read_text())
            if rec.get("proposal"):
                rec["proposal"] = manifest
                _dump(run_json, rec)


def combine_status(turns: list[TurnResult]) -> str:
    statuses = [t.exit_status for t in turns]
    for s in ("rate_limited", "infra_error", "agent_error", "timeout", "max_turns"):
        if s in statuses:
            return s
    return "ok" if statuses else "infra_error"


# ---- one run --------------------------------------------------------------------------------------


def run_one(
    *,
    server: FakeServer,
    runtime: Runtime,
    agent: AgentAdapter,
    task: TaskSpec,
    repeat: int,
    record_dir: Path,
    run_id: str,
    attempt: int = 1,
    timeout_s: float | None = None,
    keep_sandbox: bool = False,
    sandbox_root: Path | None = None,
    inputs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    record_dir.mkdir(parents=True, exist_ok=True)
    started, t0 = _now(), time.monotonic()
    scenario_dir = task.scenario_dir
    scenario_file = scenario_dir / "scenario.json" if scenario_dir.is_dir() else scenario_dir
    scenario_bytes = scenario_file.read_bytes()
    scenario = json.loads(scenario_bytes)
    server.reset(scenario_dir)
    if hasattr(agent, "task"):
        agent.task = task.raw  # scripted agents see their task
    sb = build_sandbox(
        f"{run_id}-a{attempt}",
        runtime=runtime,
        api_port=server.api_port,
        scenario=scenario,
        scenario_dir=scenario_dir if scenario_dir.is_dir() else scenario_dir.parent,
        workspace=task.workspace,
        agent=agent,
        root=sandbox_root,
        # wherever the scenario/inputs and the records live (e.g. a --out outside $HOME)
        deny_reads=[scenario_dir if scenario_dir.is_dir() else scenario_dir.parent, record_dir.parent],
    )
    shutil.copy2(sb.profile, record_dir / "sandbox.sb")
    baseline = snapshot(sb.work)
    provided = {}
    for name in sb.provided_files:
        provided[sha256_bytes((sb.work / sb.workspace_dir / name).read_bytes())] = name
    record: dict[str, Any] = {
        "schema": SCHEMA,
        "run_id": run_id,
        "attempt": attempt,
        "repeat": repeat,
        "task": {k: task.raw.get(k) for k in ("id", "family", "language", "mode")}
        | {"scenario": str(scenario_dir), "workspace_dir": task.workspace.get("dir")},
        "agent": agent.describe(),
        "scenario": {"id": scenario.get("id"), "file": str(scenario_file), "sha256": sha256_bytes(scenario_bytes),
                     "as_of": scenario.get("as_of")},  # fmt: skip
        "runtime": {"tree_sha256": runtime.tree_sha256, "cli_sha256": runtime.cli_sha256},
        "provided_files": provided,
        "sandbox": {"root": str(sb.root), "profile_sha256": sha256_bytes(sb.profile.read_bytes()),
                    "env_keys": sorted(sb.env)},  # fmt: skip
        "started": started,
        # set by the scheduler once the attempt's fate is known: final=true (the graded
        # attempt), or final=false + replaced_by=<attempt n> (kept, graded as an audit row)
        # hashes of the batch's archived grading inputs this run used (<out>/inputs/, inputs.py)
        "inputs": inputs,
        "final": None,
        "replaced_by": None,
        "budget": {"step_budget_model_requests": task.step_budget(),
                   "timeout_s_per_turn": timeout_s or task.timeout_s()},  # fmt: skip
    }
    turns: list[TurnResult] = []
    try:
        st = selftest(sb, admin_port=server.admin_port, scenario_dir=scenario_dir if scenario_dir.is_dir() else None)
        _dump(record_dir / "selftest.json", {"ok": st.ok, "checks": st.checks})
        record["selftest"] = {"ok": st.ok, "summary": st.summary()}
        if not st.ok:
            record.update(exit_status="infra_error", error=f"sandbox self-test failed: {st.summary()}")
            raise SelftestFailed(st.summary())
        timeout = timeout_s or task.timeout_s()
        # Per-task response budget (same for every agent); compound tasks get a larger one.
        agent.set_step_budget(task.step_budget())
        session = Session()
        # turn 1
        r1 = agent.run_turn(sb, task.turn1_prompt, session, turn=1, record_dir=record_dir, timeout_s=timeout)
        turns.append(r1)
        proposal = freeze_proposal(sb.work, r1.final_text, record_dir / "proposal", baseline)
        record["proposal"] = proposal
        # turn 2 (write tasks), unless the attempt is already void
        if task.turn2_prompt and r1.exit_status not in ("rate_limited", "infra_error"):
            mark = server.mark("turn-2")
            record["mark"] = mark
            r2 = agent.run_turn(sb, task.turn2_prompt, session, turn=2, record_dir=record_dir, timeout_s=timeout)
            turns.append(r2)
        record["session"] = {"id": session.id}
    finally:
        try:
            _dump(record_dir / "state.json", server.state())
            _dump(record_dir / "log.json", server.log())
        except Exception as e:  # noqa: BLE001 - keep the record even if the server died
            record["collect_error"] = repr(e)
        record["workspace_files"], record["modified_inputs"] = copy_workspace(sb.work, record_dir / "workspace", baseline)
        try:
            discovered = list(agent.private_strings(sb))  # before finalize resets the agent config
        except Exception:  # noqa: BLE001
            discovered = []
        try:
            agent.finalize(sb, record_dir)
        except Exception as e:  # noqa: BLE001
            record["finalize_error"] = repr(e)
        usage = Usage()
        for t in turns:
            usage = usage.add(t.usage)
        costs = [t.cost_usd for t in turns]

        def total(key: str) -> int | None:
            vals = [getattr(t, key) for t in turns]
            return None if any(v is None for v in vals) else sum(vals)

        record.update(
            turns=[t.to_json() for t in turns],
            finals=[t.final_text for t in turns],
            exit_status=record.get("exit_status") or combine_status(turns),
            usage=usage.__dict__,
            cost_usd=None if any(c is None for c in costs) else round(sum(costs), 6),
            model_requests=total("model_requests"),
            tool_calls=total("tool_calls"),
            ended=_now(),
            duration_s=round(time.monotonic() - t0, 3),
            hermeticity_failed=any(t.extra.get("hermeticity_failed") for t in turns),
            files={
                "transcript": "transcript.normalized.jsonl",
                "state": "state.json",
                "log": "log.json",
                "proposal": "proposal",
                "workspace": "workspace",
                "raw": sorted({t.transcript for t in turns if t.transcript}),
            },
        )
        _dump(record_dir / "run.json", record)
        redact_record(record_dir, discovered)
        if not keep_sandbox:
            sb.cleanup()
    return record
