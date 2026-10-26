"""Batch scheduler: seeded, interleaved, sequential runs against ONE fake server, with
usage-limit pauses, retries and resume (DESIGN.md §7).

    <out>/
      manifest.json              versions, models, commit, seed, scenario hashes, dates
      progress.json              updated after every attempt
      server.log.jsonl           the server's own JSONL log (all runs, with reset lines)
      <run-id>/run.json          final summary once the run is done (points to the attempt)
      <run-id>/attempts/<n>/     every attempt, kept (rate-limited ones included)

Order: per agent, a seeded shuffle of (task, repeat); agents interleaved round-robin (agent order
seeded too), so one exhausted subscription doesn't stall the others. The three claude-* agents
share one subscription: a Claude usage limit pauses all three.
"""

from __future__ import annotations

import json
import os
import platform
import random
import subprocess
import sys
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from . import paths
from .agents.base import AgentAdapter, HermeticityError
from .inputs import archive_inputs, run_inputs
from .protocol import SelftestFailed, TaskSpec, run_one, sha256_bytes
from .ratelimit import PARIS
from .runtime import Runtime
from .server import FakeServer

BACKOFF_INITIAL_S = 5 * 60
BACKOFF_CAP_S = 30 * 60
RESET_MARGIN_S = 60
MAX_INFRA_RETRIES = 2
#: The agent's subscription login is gone: retrying can't help and every later run would fail the
#: same way, so the batch stops (fail closed) and waits for a new login.
AUTH_FAILURE_MARKERS = ("OAuth token revoked", "authentication_failed", "Not logged in", "Please run /login")


class AuthFailed(RuntimeError):
    pass


@dataclass(frozen=True)
class Item:
    agent: str
    task: str
    repeat: int

    @property
    def run_id(self) -> str:
        return f"{self.agent}__{self.task}__r{self.repeat}"


def build_schedule(agent_ids: list[str], task_ids: list[str], repeats: int, seed: int) -> list[Item]:
    rng = random.Random(seed)
    queues = {}
    for a in agent_ids:
        q = [Item(a, t, r) for t in task_ids for r in range(1, repeats + 1)]
        rng.shuffle(q)
        queues[a] = q
    order = list(agent_ids)
    rng.shuffle(order)
    out: list[Item] = []
    while any(queues.values()):
        for a in order:
            if queues[a]:
                out.append(queues[a].pop(0))
    return out


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=PARIS).isoformat(timespec="seconds")


class Batch:
    def __init__(
        self,
        out_dir: Path,
        *,
        agents: dict[str, AgentAdapter],
        tasks: dict[str, TaskSpec],
        repeats: int,
        seed: int,
        runtime: Runtime,
        timeout_s: float | None = None,
        keep_sandboxes: bool = False,
        retry_infra_errors: bool = False,
        sandbox_root: Path | None = None,
        server_factory: Callable[..., FakeServer] = FakeServer,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        backoff_initial_s: float = BACKOFF_INITIAL_S,
        backoff_cap_s: float = BACKOFF_CAP_S,
        max_infra_retries: int = MAX_INFRA_RETRIES,
        log: Callable[[str], None] = lambda s: print(s, file=sys.stderr, flush=True),
    ) -> None:
        self.out = Path(out_dir)
        self.agents = agents
        self.tasks = tasks
        self.repeats = repeats
        self.seed = seed
        self.runtime = runtime
        self.timeout_s = timeout_s
        self.keep_sandboxes = keep_sandboxes
        self.retry_infra_errors = retry_infra_errors
        self.sandbox_root = sandbox_root
        self.server_factory = server_factory
        self.clock = clock
        self.sleep = sleep
        self.backoff_initial_s = backoff_initial_s
        self.backoff_cap_s = backoff_cap_s
        self.max_infra_retries = max_infra_retries
        self.log = log
        self.schedule = build_schedule(list(agents), list(tasks), repeats, seed)
        self.paused_until: dict[str, float] = {}
        self.consecutive_limits: dict[str, int] = {}
        self.infra_retries: dict[str, int] = {}
        self.current: str | None = None
        self.inputs_info: dict[str, Any] | None = None
        self.aborted: str | None = None

    # ---- bookkeeping on disk ------------------------------------------------------------------

    def run_dir(self, item: Item) -> Path:
        return self.out / item.run_id

    def is_done(self, item: Item) -> bool:
        p = self.run_dir(item) / "run.json"
        return p.exists() and json.loads(p.read_text()).get("final") is True

    def next_attempt(self, item: Item) -> int:
        d = self.run_dir(item) / "attempts"
        nums = [int(p.name) for p in d.iterdir() if p.name.isdigit()] if d.exists() else []
        return max(nums, default=0) + 1

    def subscription(self, agent_id: str) -> str:
        return self.agents[agent_id].subscription

    def write_manifest(self) -> None:
        path = self.out / "manifest.json"
        now = _iso(self.clock())
        if path.exists():
            m = json.loads(path.read_text())
            m.setdefault("resumed", []).append(now)
        else:
            m = build_manifest(self, now)
        path.write_text(json.dumps(m, indent=1, ensure_ascii=False, default=str) + "\n")

    def write_progress(self) -> None:
        per_agent: dict[str, dict[str, Any]] = {}
        total = completed = failures = 0
        for item in self.schedule:
            a = per_agent.setdefault(item.agent, {
                "total": 0, "completed": 0, "failures": 0, "attempts": 0, "rate_limited_attempts": 0,
                "spend_usd": 0.0, "spend_complete": True,
                "tokens": {"input": 0, "cached_input": 0, "output": 0},
            })  # fmt: skip
            a["total"] += 1
            total += 1
            rd = self.run_dir(item)
            for rec_file in sorted(rd.glob("attempts/*/run.json")):
                rec = json.loads(rec_file.read_text())
                a["attempts"] += 1
                a["rate_limited_attempts"] += rec.get("exit_status") == "rate_limited"
                if rec.get("cost_usd") is None:
                    a["spend_complete"] = False
                else:
                    a["spend_usd"] = round(a["spend_usd"] + rec["cost_usd"], 6)
                u = rec.get("usage") or {}
                a["tokens"]["input"] += u.get("input_tokens", 0)
                a["tokens"]["cached_input"] += u.get("cached_input_tokens", 0)
                a["tokens"]["output"] += u.get("output_tokens", 0)
            if self.is_done(item):
                a["completed"] += 1
                completed += 1
                final = json.loads((rd / "run.json").read_text())
                if final.get("exit_status") in ("agent_error", "infra_error"):
                    a["failures"] += 1
                    failures += 1
        now = self.clock()
        paused = {
            g: f"paused: usage limit until {datetime.fromtimestamp(t, tz=PARIS):%H:%M}"
            for g, t in self.paused_until.items()
            if t > now
        }
        progress = {
            "updated": _iso(now),
            "total": total,
            "completed": completed,
            "failures": failures,
            "remaining": total - completed,
            "current": self.current,
            "paused": paused,
            "paused_until": {g: _iso(t) for g, t in self.paused_until.items() if t > now},
            "per_agent": per_agent,
            "spend_usd": round(sum(a["spend_usd"] for a in per_agent.values()), 6),
            "aborted": self.aborted,
        }
        tmp = self.out / ".progress.json.tmp"
        tmp.write_text(json.dumps(progress, indent=1) + "\n")
        os.replace(tmp, self.out / "progress.json")

    def mark_attempt(self, item: Item, attempt: int, *, final: bool, replaced_by: int | None = None,
                     reason: str | None = None) -> None:  # fmt: skip
        """Record the attempt's fate in its own run.json (every attempt dir stays gradable)."""
        p = self.run_dir(item) / "attempts" / str(attempt) / "run.json"
        if not p.exists():
            return
        rec = json.loads(p.read_text())
        rec.update(final=final, replaced_by=replaced_by, replacement_reason=reason)
        tmp = p.with_name(".run.json.tmp")
        tmp.write_text(json.dumps(rec, ensure_ascii=False, indent=1, default=str) + "\n")
        os.replace(tmp, p)

    def reopen_infra_errors(self) -> None:
        """Runs that ended as infra_error (e.g. a revoked login) are redone: the final attempt is
        kept and marked replaced, the run summary is set aside, and the run is queued again."""
        for item in self.schedule:
            p = self.run_dir(item) / "run.json"
            if not p.exists():
                continue
            rec = json.loads(p.read_text())
            if rec.get("final") is not True or rec.get("exit_status") != "infra_error":
                continue
            n = int(str(rec.get("record_dir", "attempts/0")).rsplit("/", 1)[-1])
            self.mark_attempt(item, n, final=False, replaced_by=n + 1, reason="infra_error, redone (--retry-infra-errors)")
            os.replace(p, p.with_name(f"run.infra-error-{n}.json"))
            self.log(f"reopened {item.run_id} (infra_error at attempt {n})")

    def mark_stale_attempts(self, item: Item, next_attempt: int) -> None:
        """Attempts left undecided by an interrupted batch are replaced by the next one."""
        for p in (self.run_dir(item) / "attempts").glob("*/run.json"):
            n = int(p.parent.name)
            rec = json.loads(p.read_text())
            if n < next_attempt and rec.get("final") is not True and rec.get("replaced_by") is None:
                self.mark_attempt(item, n, final=False, replaced_by=next_attempt,
                                  reason=rec.get("replacement_reason") or "interrupted")  # fmt: skip

    def finalize(self, item: Item, attempt: int, rec: dict[str, Any]) -> None:
        self.mark_attempt(item, attempt, final=True)
        discarded = []
        for p in sorted((self.run_dir(item) / "attempts").glob("*/run.json"), key=lambda p: int(p.parent.name)):
            if int(p.parent.name) == attempt:
                continue
            r = json.loads(p.read_text())
            discarded.append({"attempt": int(p.parent.name), "exit_status": r.get("exit_status"),
                              "error": r.get("error"), "cost_usd": r.get("cost_usd")})  # fmt: skip
        summary = {
            "final": True,
            "run_id": item.run_id,
            "agent": item.agent,
            "task": item.task,
            "repeat": item.repeat,
            "record_dir": f"attempts/{attempt}",
            "attempts": attempt,
            "discarded_attempts": discarded,
            "exit_status": rec.get("exit_status"),
            "error": rec.get("error"),
            "usage": rec.get("usage"),
            "cost_usd": rec.get("cost_usd"),
            # all attempts of this run, discarded ones included; null if any cost is unknown
            "cost_usd_all_attempts": (
                None
                if rec.get("cost_usd") is None or any(d["cost_usd"] is None for d in discarded)
                else round(rec["cost_usd"] + sum(d["cost_usd"] for d in discarded), 6)
            ),
            "attempt_dirs": [f"attempts/{d['attempt']}" for d in discarded] + [f"attempts/{attempt}"],
            "model_requests": rec.get("model_requests"),
            "tool_calls": rec.get("tool_calls"),
            "duration_s": rec.get("duration_s"),
        }
        (self.run_dir(item) / "run.json").write_text(json.dumps(summary, indent=1, default=str) + "\n")

    # ---- main loop --------------------------------------------------------------------------------

    def pause(self, group: str, reset: str | None) -> None:
        now = self.clock()
        k = self.consecutive_limits.get(group, 0) + 1
        self.consecutive_limits[group] = k
        until = None
        if reset:
            try:
                until = datetime.fromisoformat(reset).timestamp() + RESET_MARGIN_S
            except ValueError:
                until = None
        if until is None or until <= now:
            until = now + min(self.backoff_cap_s, self.backoff_initial_s * 2 ** (k - 1))
        self.paused_until[group] = until
        self.log(f"[{group}] usage limit: paused until {_iso(until)}")

    def run(self) -> dict[str, Any]:
        self.out.mkdir(parents=True, exist_ok=True)
        for a in self.agents.values():
            a.preflight()
        self.tasks, self.inputs_info = archive_inputs(self.out, self.tasks, log=self.log)
        self.write_manifest()
        if self.retry_infra_errors:
            self.reopen_infra_errors()
        queues: dict[str, deque[Item]] = {a: deque() for a in self.agents}
        for item in self.schedule:
            if not self.is_done(item):
                queues[item.agent].append(item)
        order = list(dict.fromkeys(i.agent for i in self.schedule))
        self.write_progress()
        if not any(queues.values()):
            return json.loads((self.out / "progress.json").read_text())
        first = next(i for q in queues.values() for i in q)
        with self.server_factory(
            self.tasks[first.task].scenario_dir,
            log_path=self.out / "server.log.jsonl",
            stderr_path=self.out / "server.stderr.txt",
        ) as server:
            rr = 0
            while any(queues.values()):
                now = self.clock()
                pick = None
                for k in range(len(order)):
                    a = order[(rr + k) % len(order)]
                    if queues[a] and self.paused_until.get(self.subscription(a), 0) <= now:
                        pick = a
                        rr = (rr + k + 1) % len(order)
                        break
                if pick is None:
                    wake = min(self.paused_until[self.subscription(a)] for a in order if queues[a])
                    self.current = None
                    self.write_progress()
                    self.sleep(max(1.0, min(wake - now, 60.0)))
                    continue
                item = queues[pick].popleft()
                attempt = self.next_attempt(item)
                self.mark_stale_attempts(item, attempt)
                self.current = f"{item.run_id} (attempt {attempt})"
                self.write_progress()
                self.log(f"run {item.run_id} attempt {attempt}")
                try:
                    rec = run_one(
                        server=server,
                        runtime=self.runtime,
                        agent=self.agents[item.agent],
                        task=self.tasks[item.task],
                        repeat=item.repeat,
                        record_dir=self.run_dir(item) / "attempts" / str(attempt),
                        run_id=item.run_id,
                        attempt=attempt,
                        timeout_s=self.timeout_s,
                        keep_sandbox=self.keep_sandboxes,
                        sandbox_root=self.sandbox_root,
                        inputs=run_inputs(self.inputs_info, item.task),
                    )
                except (SelftestFailed, HermeticityError) as e:
                    self.mark_attempt(item, attempt, final=False, reason=f"batch aborted: {type(e).__name__}")
                    self.aborted = f"{type(e).__name__}: {e}"
                    self.current = None
                    self.write_progress()
                    raise
                status = rec.get("exit_status")
                group = self.subscription(item.agent)
                if rec.get("hermeticity_failed"):
                    self.mark_attempt(item, attempt, final=False, reason="batch aborted: hermeticity")
                    self.aborted = f"hermeticity check failed in {item.run_id}: {rec.get('turns', [{}])[-1].get('error')}"
                    self.write_progress()
                    raise HermeticityError(self.aborted)
                err = " ".join([str(rec.get("error") or "")] + [str(t.get("error") or "") for t in rec.get("turns", [])])
                if status == "infra_error" and any(m in err for m in AUTH_FAILURE_MARKERS):
                    self.mark_attempt(item, attempt, final=False, reason="batch aborted: login lost")
                    self.aborted = f"login lost in {item.run_id}: {err.strip()[:200]}"
                    self.current = None
                    self.write_progress()
                    raise AuthFailed(self.aborted)
                if status == "rate_limited":
                    reset = next((t.get("rate_limit_reset") for t in rec.get("turns", []) if t.get("rate_limit_reset")), None)
                    self.pause(group, reset)
                    self.mark_attempt(item, attempt, final=False, replaced_by=attempt + 1, reason="rate_limited")
                    queues[item.agent].appendleft(item)
                elif status == "infra_error" and self.infra_retries.get(item.run_id, 0) < self.max_infra_retries:
                    self.infra_retries[item.run_id] = self.infra_retries.get(item.run_id, 0) + 1
                    self.mark_attempt(item, attempt, final=False, replaced_by=attempt + 1, reason="infra_error")
                    queues[item.agent].append(item)
                else:
                    self.consecutive_limits[group] = 0
                    self.finalize(item, attempt, rec)
                self.current = None
                self.write_progress()
        return json.loads((self.out / "progress.json").read_text())


# ---- manifest ------------------------------------------------------------------------------------


def _cmd(argv: list[str]) -> str:
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def build_manifest(batch: Batch, now: str) -> dict[str, Any]:
    scenarios = {}
    for t in batch.tasks.values():
        sd = t.scenario_dir
        if str(sd) in scenarios:
            continue
        man = sd / "MANIFEST.sha256"
        scen = sd / "scenario.json" if sd.is_dir() else sd
        scenarios[str(sd)] = {
            "manifest_sha256": sha256_bytes(man.read_bytes()) if man.exists() else None,
            "scenario_sha256": sha256_bytes(scen.read_bytes()) if scen.exists() else None,
        }
    node = paths.node_binary()
    return {
        "created": now,
        "seed": batch.seed,
        "repeats": batch.repeats,
        "agents": {a.id: a.describe() for a in batch.agents.values()},
        "tasks": sorted(batch.tasks),
        "schedule_length": len(batch.schedule),
        "timeout_s": batch.timeout_s,
        "cli": {"tree_sha256": batch.runtime.tree_sha256, "cli_sha256": batch.runtime.cli_sha256,
                "version": batch.runtime.version},  # fmt: skip
        "harness": {
            "repo_commit": _cmd(["git", "-C", str(paths.REPO_ROOT), "rev-parse", "HEAD"]),
            "repo_dirty": bool(_cmd(["git", "-C", str(paths.REPO_ROOT), "status", "--porcelain"])),
        },
        "node": {"path": str(node), "version": _cmd([str(node), "--version"])},
        "python": sys.version.split()[0],
        "os": {"platform": platform.platform(), "macos": platform.mac_ver()[0], "machine": platform.machine()},
        "tz": "Europe/Paris",
        "locale": "fr_FR.UTF-8",
        "scenarios": scenarios,
        "inputs": {k: v for k, v in (batch.inputs_info or {}).items() if not k.startswith("_")},
    }
