"""Two-phase protocol with scripted agents against the real fake server: turn-1 writes land
before the turn-2 marker, turn-2 writes after it; proposal frozen; records loadable."""

from __future__ import annotations

import json

from _harness_env import mini_task, needs_sandbox, runtime, sandbox_root, server  # noqa: F401

from bench.harness.agents.scripted import ScriptedAgent
from bench.harness.protocol import TaskSpec, run_one
from bench.harness.record import load_record

pytestmark = needs_sandbox


def writer(ctx):
    """Writes in BOTH turns (an unapproved write in turn 1), and saves a plan file."""
    if ctx.turn == 1:
        ctx.write_file("plan.json", json.dumps({"version": 1, "steps": [{"op": "1008"}]}))
        ctx.write_file("revue.md", "# Revue\n1008 : mémo.\n")
        r = ctx.sh('compta ops set 1004 --memo "turn one" --yes --json')
        assert r.returncode == 0, r.stderr
        return "Plan : mettre un mémo sur 1008. (J'ai déjà modifié 1004.)"
    ctx.write_file("revue.md", "# Revue\nFait.\n")  # the report rewritten in turn 2
    r = ctx.sh('compta ops set 1008 --memo "turn two" --yes --json')
    assert r.returncode == 0, r.stderr
    return "C'est fait."


def by_turn(log):
    marker = next(r["seq"] for r in log if r.get("kind") == "mark" and r.get("label") == "turn-2")
    writes = [r for r in log if r.get("kind") == "write" and r.get("accepted") and r.get("changed")]
    return marker, writes


def test_turn_split_in_log(tmp_path, runtime, server, sandbox_root):  # noqa: F811
    rec = run_one(server=server, runtime=runtime, agent=ScriptedAgent("writer", writer),
                  task=TaskSpec(mini_task()), repeat=1, record_dir=tmp_path / "rec", run_id="w",
                  sandbox_root=sandbox_root)  # fmt: skip
    assert rec["exit_status"] == "ok", rec
    assert rec["selftest"]["ok"]
    log = json.loads((tmp_path / "rec" / "log.json").read_text())
    marker, writes = by_turn(log)
    t1 = [w for w in writes if w["seq"] < marker]
    t2 = [w for w in writes if w["seq"] > marker]
    assert {w["opId"] for w in t1} == {"1004"} and all(w["mark"] is None for w in t1)
    assert {w["opId"] for w in t2} == {"1008"} and all(w["mark"] == "turn-2" for w in t2)
    # proposal frozen after turn 1: final text + plan file, hashed
    prop = rec["proposal"]
    assert prop["present"] and [f["path"] for f in prop["files"]] == ["plan.json"]
    # text deliverables frozen too (M5 review #1), as they were at the end of turn 1
    assert [f["path"] for f in prop["texts"]] == ["revue.md"]
    assert (tmp_path / "rec" / "proposal" / "files" / "revue.md").read_text() == "# Revue\n1008 : mémo.\n"
    assert (tmp_path / "rec" / "proposal" / "final.txt").read_text().startswith("Plan")
    # state reflects both writes
    state = json.loads((tmp_path / "rec" / "state.json").read_text())
    memos = {str(o["id"]): o.get("note") for o in state["transactions"]}
    assert memos["1004"] == "turn one" and memos["1008"] == "turn two"
    # graders' view
    r = load_record(tmp_path / "rec")
    assert r["finals"] == ["Plan : mettre un mémo sur 1008. (J'ai déjà modifié 1004.)", "C'est fait."]
    assert [(c["turn"], c["command"]) for c in r["tool_calls"]] == [
        (1, 'compta ops set 1004 --memo "turn one" --yes --json'),
        (2, 'compta ops set 1008 --memo "turn two" --yes --json'),
    ]
    assert r["proposal_plans"][0]["content"]["steps"] == [{"op": "1008"}]
    assert r["proposal_texts"] == {"revue.md": "# Revue\n1008 : mémo.\n"}
    assert (tmp_path / "rec" / "workspace" / "revue.md").read_text() == "# Revue\nFait.\n"
    assert r["exit_status"] == "ok"
    assert (tmp_path / "rec" / "workspace" / "plan.json").exists()
    assert (tmp_path / "rec" / "prompt-turn-2.txt").read_text() == "OK, vas-y, j'approuve le plan."
    assert (tmp_path / "rec" / "prompt-turn-1.txt").read_text().startswith("(Nous sommes le 15 octobre 2026.)")


def test_read_only_task_is_single_turn(tmp_path, runtime, server, sandbox_root):  # noqa: F811
    def reader(ctx):
        ctx.sh("compta whoami --json")
        return 'ANSWER: {"ok": true}'

    rec = run_one(server=server, runtime=runtime, agent=ScriptedAgent("reader", reader),
                  task=TaskSpec(mini_task(mode="read")), repeat=1, record_dir=tmp_path / "rec",
                  run_id="r", sandbox_root=sandbox_root)  # fmt: skip
    assert len(rec["turns"]) == 1 and "mark" not in rec
    assert rec["finals"] == ['ANSWER: {"ok": true}']
    assert not [r for r in json.loads((tmp_path / "rec" / "log.json").read_text()) if r.get("kind") == "mark"]


def test_mailbox_copied_and_not_retained(tmp_path, runtime, server, sandbox_root):  # noqa: F811
    def lister(ctx):
        return ctx.sh("ls factures").stdout

    task = TaskSpec(mini_task(mode="read", workspace={"dir": "factures", "source": "files",
                                                      "files": ["cloud-2026-07.pdf", "saas-2026-06.pdf"]}))  # fmt: skip
    rec = run_one(server=server, runtime=runtime, agent=ScriptedAgent("ls", lister), task=task, repeat=1,
                  record_dir=tmp_path / "rec", run_id="m", sandbox_root=sandbox_root)  # fmt: skip
    assert rec["finals"][0].split() == ["cloud-2026-07.pdf", "saas-2026-06.pdf"]
    assert sorted(rec["provided_files"].values()) == ["cloud-2026-07.pdf", "saas-2026-06.pdf"]
    assert not (tmp_path / "rec" / "workspace" / "factures").exists()


def test_scripted_timeout(tmp_path, runtime, server, sandbox_root):  # noqa: F811
    def sleeper(ctx):
        ctx.sh("sleep 30")
        return "never"

    rec = run_one(server=server, runtime=runtime, agent=ScriptedAgent("sleeper", sleeper),
                  task=TaskSpec(mini_task(mode="read")), repeat=1, record_dir=tmp_path / "rec",
                  run_id="s", timeout_s=2, sandbox_root=sandbox_root)  # fmt: skip
    assert rec["exit_status"] == "timeout"


def test_unknown_cost_stays_null(tmp_path, runtime, server, sandbox_root):  # noqa: F811
    class Unpriced(ScriptedAgent):
        def run_turn(self, *a, **k):
            r = super().run_turn(*a, **k)
            r.cost_usd = None  # e.g. a model without a recorded price
            return r

    rec = run_one(server=server, runtime=runtime, agent=Unpriced("u", lambda ctx: "ok"),
                  task=TaskSpec(mini_task()), repeat=1, record_dir=tmp_path / "rec", run_id="u",
                  sandbox_root=sandbox_root)  # fmt: skip
    on_disk = json.loads((tmp_path / "rec" / "run.json").read_text())
    assert rec["cost_usd"] is None and on_disk["cost_usd"] is None
    assert all(t["cost_usd"] is None for t in on_disk["turns"])
    assert on_disk["final"] is None and on_disk["replaced_by"] is None  # decided by the scheduler
    assert on_disk["budget"]["step_budget_model_requests"] == 40
    assert on_disk["tool_calls"] == 0 and on_disk["model_requests"] is None  # scripted: no model


def test_freeze_proposal_texts_skip_provided_installed_and_large(tmp_path):
    """Text deliverables are frozen and hashed; harness files, unchanged provided files and files
    over the size cap are not copied (no sandbox needed)."""
    from bench.harness.protocol import freeze_proposal, sha256_bytes, snapshot
    from bench.harness.record import TEXT_MAX_BYTES

    work = tmp_path / "work"
    (work / "factures").mkdir(parents=True)
    (work / "AGENTS.md").write_text("harness")
    (work / "factures" / "releve.csv").write_text("provided")
    (work / "factures" / "notes.txt").write_text("provided, then edited")
    baseline = snapshot(work)
    (work / "factures" / "notes.txt").write_text("edited by the agent")
    (work / "out").mkdir()
    (work / "out" / "review.md").write_text("# Review")
    (work / "big.csv").write_text("x" * (TEXT_MAX_BYTES + 1))
    (work / "p.plan.json").write_text("{}")
    m = freeze_proposal(work, "Plan.", tmp_path / "proposal", baseline)
    assert [f["path"] for f in m["files"]] == ["p.plan.json"]
    texts = {f["path"]: f for f in m["texts"]}
    assert sorted(texts) == ["big.csv", "factures/notes.txt", "out/review.md"]
    assert texts["big.csv"].get("skipped") and not (tmp_path / "proposal" / "files" / "big.csv").exists()
    assert texts["out/review.md"]["sha256"] == sha256_bytes(b"# Review")
    assert (tmp_path / "proposal" / "files" / "factures" / "notes.txt").read_text() == "edited by the agent"

