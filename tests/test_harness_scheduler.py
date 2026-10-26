"""Scheduler: seeded interleaving, usage-limit pause (shared subscription), retry from a fresh
state with every attempt kept, resume, progress.json."""

from __future__ import annotations

import json

from _harness_env import mini_task, needs_sandbox, runtime, sandbox_root  # noqa: F401

from bench.harness.agents.scripted import ScriptedAgent, ScriptedRateLimit
from bench.harness.protocol import TaskSpec
from bench.harness.scheduler import Batch, build_schedule


def test_schedule_seeded_round_robin():
    a = build_schedule(["x", "y", "z"], ["t1", "t2", "t3"], 2, seed=7)
    assert a == build_schedule(["x", "y", "z"], ["t1", "t2", "t3"], 2, seed=7)
    assert a != build_schedule(["x", "y", "z"], ["t1", "t2", "t3"], 2, seed=8)
    assert len(a) == 18 and len({i.run_id for i in a}) == 18
    agents = [i.agent for i in a]
    for k in range(0, 18, 3):  # every block of 3 has each agent once
        assert sorted(agents[k : k + 3]) == ["x", "y", "z"]


@needs_sandbox
def test_rate_limit_pause_retry_and_resume(tmp_path, runtime, sandbox_root):  # noqa: F811
    t = [1_000_000.0]
    calls: list[tuple[str, int, float]] = []
    limited = {"done": False}

    def policy_for(name):
        def policy(ctx):
            calls.append((name, ctx.turn, t[0]))
            t[0] += 1
            if name == "c1" and not limited["done"]:
                limited["done"] = True
                # an unapproved write before the limit hits: kept in the discarded attempt
                ctx.sh('compta ops set 1004 --memo "lost attempt" --yes --json')
                raise ScriptedRateLimit()
            return f"{name} ok"

        return policy

    agents = {
        "c1": ScriptedAgent("c1", policy_for("c1"), subscription="claude"),
        "c2": ScriptedAgent("c2", policy_for("c2"), subscription="claude"),
        "x": ScriptedAgent("x", policy_for("x"), subscription="codex"),
    }
    tasks = {"t": TaskSpec(mini_task("t", mode="read"))}
    out = tmp_path / "batch"

    def batch():
        return Batch(out, agents=agents, tasks=tasks, repeats=1, seed=3, runtime=runtime,
                     sandbox_root=sandbox_root, clock=lambda: t[0],
                     sleep=lambda s: t.__setitem__(0, t[0] + s), backoff_initial_s=100, log=lambda s: None)  # fmt: skip

    b = batch()
    progress = b.run()
    assert progress["completed"] == progress["total"] == 3 and progress["failures"] == 0
    # c1 hit the limit: claude paused 100 s; c2 (same subscription) did not run during the pause
    limit_time = next(ts for n, _, ts in calls if n == "c1")
    resume_time = limit_time + 100
    for n, _, ts in calls:
        if n in ("c1", "c2") and ts > limit_time:
            assert ts >= resume_time, calls
    # the limited attempt is kept, the run redone from a fresh state
    run = json.loads((out / "c1__t__r1" / "run.json").read_text())
    assert run["final"] and run["record_dir"] == "attempts/2" and run["exit_status"] == "ok"
    assert run["discarded_attempts"][0]["exit_status"] == "rate_limited"
    assert run["attempt_dirs"] == ["attempts/1", "attempts/2"] and run["cost_usd_all_attempts"] == 0.0
    # every attempt dir is self-contained and says what became of it
    a1 = json.loads((out / "c1__t__r1" / "attempts" / "1" / "run.json").read_text())
    a2 = json.loads((out / "c1__t__r1" / "attempts" / "2" / "run.json").read_text())
    assert (a1["final"], a1["replaced_by"], a1["replacement_reason"]) == (False, 2, "rate_limited")
    assert (a2["final"], a2["replaced_by"]) == (True, None)
    for d in ("1", "2"):
        for f in ("run.json", "state.json", "log.json", "transcript.normalized.jsonl"):
            assert (out / "c1__t__r1" / "attempts" / d / f).exists(), (d, f)
    assert a1["usage"] is not None and a1["exit_status"] == "rate_limited" and "cost_usd" in a1
    lost = json.loads((out / "c1__t__r1" / "attempts" / "1" / "log.json").read_text())
    assert any(r.get("opId") == "1004" and r.get("accepted") for r in lost)
    fresh = json.loads((out / "c1__t__r1" / "attempts" / "2" / "state.json").read_text())
    assert {str(o["id"]): o.get("note") for o in fresh["transactions"]}["1004"] != "lost attempt"
    assert progress["per_agent"]["c1"]["attempts"] == 2
    assert progress["per_agent"]["c1"]["rate_limited_attempts"] == 1
    manifest = json.loads((out / "manifest.json").read_text())
    assert manifest["seed"] == 3 and manifest["cli"]["tree_sha256"] == runtime.tree_sha256
    # resume: nothing left to do, nothing rerun
    n = len(calls)
    batch().run()
    assert len(calls) == n
    assert "resumed" in json.loads((out / "manifest.json").read_text())


@needs_sandbox
def test_inputs_archived_and_used(tmp_path, runtime, sandbox_root):  # noqa: F811
    """The batch freezes its grading inputs, runs from them, and every run.json carries their
    hashes; a resumed batch keeps the archive even if the source scenario changed."""
    import hashlib
    import shutil

    from _harness_env import MINI

    src = tmp_path / "scenario"
    shutil.copytree(MINI, src)
    seen = []

    def policy(ctx):
        seen.append(ctx.sh("compta whoami --json").stdout)
        return "ok"

    agents = {"s": ScriptedAgent("s", policy)}
    out = tmp_path / "batch"

    def batch(repeats):
        tasks = {"t": TaskSpec(mini_task("t", mode="read") | {"scenario": str(src)})}
        return Batch(out, agents=agents, tasks=tasks, repeats=repeats, seed=1, runtime=runtime,
                     sandbox_root=sandbox_root, log=lambda s: None)  # fmt: skip

    batch(1).run()
    inputs = out / "inputs"
    hashes = json.loads((inputs / "hashes.json").read_text())
    assert hashes["scenario.json"] == hashlib.sha256((src / "scenario.json").read_bytes()).hexdigest()
    assert any(k.startswith("files/") for k in hashes) and any(k.startswith("tasks/") for k in hashes)
    assert "t" in json.loads((inputs / "tasks.resolved.json").read_text())
    rec = json.loads((out / "s__t__r1" / "attempts" / "1" / "run.json").read_text())
    assert rec["inputs"]["files"]["scenario.json"] == hashes["scenario.json"]
    assert rec["inputs"]["hashes_sha256"] == hashlib.sha256((inputs / "hashes.json").read_bytes()).hexdigest()
    assert rec["task"]["scenario"] == str(inputs) and rec["scenario"]["sha256"] == hashes["scenario.json"]
    # the source changes; a resumed batch (one more repeat) still runs the archived scenario
    s = json.loads((src / "scenario.json").read_text())
    s["company"]["legalName"] = "Changed After Start SAS"
    (src / "scenario.json").write_text(json.dumps(s))
    batch(2).run()
    rec2 = json.loads((out / "s__t__r2" / "attempts" / "1" / "run.json").read_text())
    assert rec2["scenario"]["sha256"] == hashes["scenario.json"]
    assert "Changed After Start" not in seen[-1]
    # tampering with the archive is refused
    (inputs / "scenario.json").write_text("{}")
    import pytest

    with pytest.raises(RuntimeError, match="modified"):
        batch(3).run()


@needs_sandbox
def test_lost_login_aborts_batch_and_infra_errors_can_be_redone(tmp_path, runtime, sandbox_root):  # noqa: F811
    import pytest

    from bench.harness.agents.scripted import ScriptedInfraError
    from bench.harness.scheduler import AuthFailed

    mode = {"auth": "ok", "broken": "t1"}
    calls: list[str] = []

    def policy(ctx):
        calls.append(ctx.task["id"])
        if mode["auth"] == "revoked":
            raise ScriptedInfraError("Failed to authenticate: OAuth token revoked. authentication_failed 401")
        if ctx.task["id"] == mode["broken"]:
            raise ScriptedInfraError("server crashed")
        return "ok"

    agents = {"c": ScriptedAgent("c", policy, subscription="claude")}
    tasks = {k: TaskSpec(mini_task(k, mode="read")) for k in ("t1", "t2")}
    out = tmp_path / "batch"

    def batch(**kw):
        return Batch(out, agents=agents, tasks=tasks, repeats=1, seed=1, runtime=runtime,
                     sandbox_root=sandbox_root, log=lambda s: None, max_infra_retries=0, **kw)  # fmt: skip

    p = batch().run()  # t1 ends as a (non-auth) infra_error, t2 ok
    assert p["completed"] == 2 and p["failures"] == 1
    # a lost login stops the batch at once instead of failing every remaining run
    mode.update(auth="revoked", broken="")
    n = len(calls)
    with pytest.raises(AuthFailed):
        batch(retry_infra_errors=True).run()
    assert len(calls) == n + 1
    # after a new login, --retry-infra-errors redoes t1; every earlier attempt is kept
    mode["auth"] = "ok"
    p = batch(retry_infra_errors=True).run()
    assert p["completed"] == 2 and p["failures"] == 0
    run = json.loads((out / "c__t1__r1" / "run.json").read_text())
    assert run["exit_status"] == "ok" and run["record_dir"] == "attempts/3"
    assert (out / "c__t1__r1" / "run.infra-error-1.json").exists()
    a1 = json.loads((out / "c__t1__r1" / "attempts" / "1" / "run.json").read_text())
    a2 = json.loads((out / "c__t1__r1" / "attempts" / "2" / "run.json").read_text())
    assert (a1["final"], a1["replaced_by"]) == (False, 2)
    assert a2["final"] is False and a2["replacement_reason"] in ("batch aborted: login lost", "interrupted")
    assert json.loads((out / "c__t2__r1" / "run.json").read_text())["record_dir"] == "attempts/1"
