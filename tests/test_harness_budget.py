"""Common step budget and per-turn counters (M2 review finding 10), tool outputs in the
normalized transcript (finding 8)."""

from __future__ import annotations

import base64
import hashlib
import json
import time
from pathlib import Path

from _harness_env import FIXTURES, MINI, mini_scenario, needs_sandbox, runtime, sandbox_root, server  # noqa: F401

from bench.harness.agents.base import OUTPUT_CAP, STEP_BUDGET, Normalized, Session
from bench.harness.agents.claude_code import MAX_TURNS, parse_stream
from bench.harness.agents.codex import CodexAgent, StepMonitor, config_toml, parse_events, rollout_requests
from bench.harness.sandbox import AgentNeeds, build_sandbox


def events(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines()]


# ---- the unit: model requests ----------------------------------------------------------------------


def test_claude_turns_are_model_responses(tmp_path):
    """Genuine Claude Code 2.1.289 stream (Haiku probe): content blocks arrive as separate
    assistant events sharing a message id; Claude's num_turns = distinct message ids (7 tool-using
    responses + the final answer), which is what --max-turns caps."""
    p = parse_stream((FIXTURES / "claude-haiku-money-todo.jsonl").read_text(), Normalized(tmp_path, 1))
    assert p["result"]["num_turns"] == 8
    assert p["model_requests"] == 8
    assert p["tool_calls"] == 7
    assert MAX_TURNS == STEP_BUDGET == 40


def test_claude_non_shell_tool_outputs_recorded(tmp_path):
    parse_stream((FIXTURES / "claude-haiku-money-todo.jsonl").read_text(), Normalized(tmp_path, 1))
    ev = events(tmp_path / "transcript.normalized.jsonl")
    read = next(e for e in ev if e["type"] == "tool" and e["name"] == "Read")
    assert read["output"].startswith("1\t---\n2\tname: compta")  # what the model saw, line numbers included
    cmds = [e for e in ev if e["type"] == "command"]
    assert len(cmds) == 6 and all(isinstance(c["output"], str) and c["output"] for c in cmds)


def test_claude_document_result_marker_and_truncation(tmp_path):
    pdf = b"%PDF-1.4 fake"
    init = {"type": "system", "subtype": "init", "session_id": "s", "tools": [], "model": "m"}
    use = {"type": "assistant", "session_id": "s", "message": {"id": "m1", "content": [
        {"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "factures/a.pdf"}},
        {"type": "tool_use", "id": "t2", "name": "Grep", "input": {"pattern": "x"}}]}}  # fmt: skip
    res = {"type": "user", "session_id": "s", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": [
            {"type": "text", "text": "PDF file read"},
            {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                            "data": base64.b64encode(pdf).decode()}}]},
        {"type": "tool_result", "tool_use_id": "t2", "content": "y" * (OUTPUT_CAP + 10)}]}}  # fmt: skip
    text = "\n".join(json.dumps(e) for e in (init, use, res))
    p = parse_stream(text, Normalized(tmp_path, 1))
    assert p["model_requests"] == 1 and p["tool_calls"] == 2
    ev = events(tmp_path / "transcript.normalized.jsonl")
    assert ev[0]["output"] == f"PDF file read\n[document application/pdf sha256={hashlib.sha256(pdf).hexdigest()}]"
    assert ev[1]["truncated"] is True and ev[1]["output_chars"] == OUTPUT_CAP + 10
    assert len(ev[1]["output"]) == OUTPUT_CAP


def test_codex_counters_on_genuine_stream(tmp_path):
    p = parse_events((FIXTURES / "codex-turn1.jsonl").read_text(), Normalized(tmp_path, 1))
    assert p["tool_calls"] == 5  # 4 shell commands + 1 file_change (apply_patch)
    reqs, total = rollout_requests(FIXTURES / "codex-rollout.jsonl", 0)
    turn1 = [r for r in reqs][:4]
    assert len(turn1) == 4  # 5 tool calls in 4 model responses (parallel calls)
    fc = next(e for e in events(tmp_path / "transcript.normalized.jsonl") if e["type"] == "tool")
    assert fc["name"] == "file_change" and fc["output"] == "completed"


# ---- the Codex step monitor --------------------------------------------------------------------------


class Fake:
    """Writes a Codex session log and --json events the way Codex does, step by step."""

    def __init__(self, tmp: Path) -> None:
        self.home = tmp / "codex-home"
        (self.home / "sessions" / "2026" / "10" / "19").mkdir(parents=True)
        self.rollout = self.home / "sessions" / "2026" / "10" / "19" / "rollout-x-T1.jsonl"
        self.rollout.write_text(json.dumps({"type": "session_meta", "payload": {"id": "T1"}}) + "\n")
        self.events = tmp / "events.jsonl"
        self.events.write_text('{"type":"thread.started","thread_id":"T1"}\n')
        self.total = 0

    def request(self, n: int = 1000, repeat: bool = False) -> None:
        if not repeat:
            self.total += n
        info = {"total_token_usage": {"total_tokens": self.total, "input_tokens": self.total},
                "last_token_usage": {"total_tokens": n, "input_tokens": n}}  # fmt: skip
        with self.rollout.open("a") as f:
            f.write(json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": info}}) + "\n")

    def event(self, **e) -> None:
        with self.events.open("a") as f:
            f.write(json.dumps(e) + "\n")

    def command(self, i: str, done: bool = True) -> None:
        item = {"id": i, "type": "command_execution", "command": "compta todo --json"}
        self.event(type="item.started", item=item)
        if done:
            self.event(type="item.completed", item={**item, "aggregated_output": "[]", "exit_code": 0})


def test_monitor_stops_after_the_budget_th_response_tools(tmp_path):
    f = Fake(tmp_path)
    m = StepMonitor(f.home, f.events, budget=2, after_total=0, idle_s=60)
    f.request()
    f.command("a")
    assert m() is None
    f.request()
    f.request(repeat=True)  # duplicate token_count (same cumulative total): not a new request
    assert m() is None and m.requests == 2
    f.command("b", done=False)  # the 2nd response's tool call is running: let it finish
    assert m() is None
    f.event(type="item.completed", item={"id": "b", "type": "command_execution"})
    assert m() == "step budget: 2 model requests"


def test_monitor_lets_a_final_answer_complete(tmp_path):
    f = Fake(tmp_path)
    m = StepMonitor(f.home, f.events, budget=1, after_total=0, idle_s=60)
    f.request()
    f.event(type="item.completed", item={"id": "m", "type": "agent_message", "text": "done"})
    f.event(type="turn.completed", usage={})
    assert m() is None


def test_monitor_idle_and_overflow(tmp_path):
    f = Fake(tmp_path)
    m = StepMonitor(f.home, f.events, budget=1, after_total=0, idle_s=0.1)
    f.request()
    assert m() is None  # just reached: maybe the final answer is on its way
    time.sleep(0.15)
    assert m() == "step budget: 1 model requests"  # nothing happened since: stop before request 2
    m2 = StepMonitor(f.home, f.events, budget=1, after_total=0, idle_s=60)
    f.request()
    assert m2() is not None  # 2 responses > budget 1: immediate


def test_monitor_counts_only_this_turn(tmp_path):
    f = Fake(tmp_path)
    for _ in range(3):
        f.request()
    m = StepMonitor(f.home, f.events, budget=2, after_total=f.total, thread_id="T1", idle_s=60)
    assert m() is None and m.requests == 0  # turn 1's requests don't count against turn 2


FAKE_CODEX = r"""
// Stand-in for `codex exec --json`: one model request + one command per step, forever.
const fs = require('fs'), path = require('path');
const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '19');
fs.mkdirSync(dir, {recursive: true});
const rollout = path.join(dir, 'rollout-2026-10-19T00-00-00-FAKE.jsonl');
fs.appendFileSync(rollout, JSON.stringify({type: 'session_meta', payload: {id: 'FAKE', cli_version: 'fake'}}) + '\n');
console.log(JSON.stringify({type: 'thread.started', thread_id: 'FAKE'}));
let total = 0, i = 0;
function step() {
  total += 100; i += 1;
  const last = {input_tokens: 100, cached_input_tokens: 0, output_tokens: 0, total_tokens: 100};
  fs.appendFileSync(rollout, JSON.stringify({type: 'event_msg', payload: {type: 'token_count',
    info: {total_token_usage: {...last, input_tokens: total, total_tokens: total}, last_token_usage: last}}}) + '\n');
  const item = {id: 'item_' + i, type: 'command_execution', command: 'compta todo --json'};
  console.log(JSON.stringify({type: 'item.started', item}));
  console.log(JSON.stringify({type: 'item.completed', item: {...item, aggregated_output: 'ok', exit_code: 0}}));
  setTimeout(step, 50);
}
setTimeout(step, 50);
"""


@needs_sandbox
def test_codex_turn_stopped_at_budget_end_to_end(tmp_path, runtime, server, sandbox_root):  # noqa: F811
    """The real CodexAgent.run_turn with a stand-in Codex that never stops on its own."""

    class FakeCodex(CodexAgent):
        def prepare_sandbox(self, sb):
            (sb.root / "fake-codex.js").write_text(FAKE_CODEX)
            (sb.agent_config / "config.toml").write_text(config_toml(self.model, self.effort))
            return AgentNeeds(env={"CODEX_HOME": str(sb.agent_config)})

        def command(self, sb, session, turn, last_message):
            return [str(sb.node), str(sb.root / "fake-codex.js")]

        def version(self):
            return "fake"

        def features(self):
            return {}

    agent = FakeCodex(step_budget=3)
    sb = build_sandbox("budget", runtime=runtime, api_port=server.api_port, scenario=mini_scenario(),
                       scenario_dir=MINI, workspace=None, agent=agent, root=sandbox_root)  # fmt: skip
    t0 = time.monotonic()
    r = agent.run_turn(sb, "go", Session(), turn=1, record_dir=tmp_path / "rec", timeout_s=60)
    assert time.monotonic() - t0 < 30
    assert r.exit_status == "max_turns" and r.error == "step budget: 3 model requests"
    assert r.model_requests == r.num_turns and 3 <= r.model_requests <= 4
    assert r.tool_calls >= 3
    assert r.usage.input_tokens == 100 * r.model_requests


def test_codex_session_log_usage_matches_turn_completed():
    """Per-request usage from the session log adds up to turn 1's turn.completed usage."""
    from bench.harness.agents.base import Usage

    reqs, _ = rollout_requests(FIXTURES / "codex-rollout.jsonl", 0)
    total = Usage(reasoning_tokens=0, cache_write_tokens=0)
    for r in reqs[:4]:
        total = total.add(r)
    assert total == parse_events((FIXTURES / "codex-turn1.jsonl").read_text())["usage"]


# ---- small budgets, both adapters (M3 review) ---------------------------------------------------

PLAN_CODEX = r"""
// Scripted stand-in for `codex exec --json`, driven by plan.json (sandbox root).
const fs = require('fs'), path = require('path');
const plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json'), 'utf8'));
const dir = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '19');
fs.mkdirSync(dir, {recursive: true});
const rollout = path.join(dir, 'rollout-2026-10-19T00-00-00-PLAN.jsonl');
const out = (e) => fs.writeSync(1, JSON.stringify(e) + '\n');
if (!plan.no_rollout) fs.appendFileSync(rollout, JSON.stringify({type: 'session_meta', payload: {id: 'PLAN'}}) + '\n');
out({type: 'thread.started', thread_id: 'PLAN'});
let total = 0, n = 0;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (const step of plan.steps) {
  n += 1;
  if (step === 'request') {
    total += 100;
    const last = {input_tokens: 100, cached_input_tokens: 0, output_tokens: 0, total_tokens: 100};
    if (!plan.no_rollout) fs.appendFileSync(rollout, JSON.stringify({type: 'event_msg', payload: {type: 'token_count',
      info: {total_token_usage: {...last, input_tokens: total, total_tokens: total}, last_token_usage: last}}}) + '\n');
  } else if (step === 'command') {
    const item = {id: 'item_' + n, type: 'command_execution', command: 'compta todo --json'};
    out({type: 'item.started', item});
    out({type: 'item.completed', item: {...item, aggregated_output: 'ok', exit_code: 0}});
  } else if (step === 'message') {
    out({type: 'item.completed', item: {id: 'item_' + n, type: 'agent_message', text: 'msg ' + n}});
  } else if (step === 'delete_rollout') {
    fs.rmSync(rollout, {force: true});
  } else if (step === 'truncate_rollout') {
    fs.truncateSync(rollout, 10);
  } else if (step === 'garbage_rollout') {
    fs.appendFileSync(rollout, 'not json\n');
  } else if (step === 'complete') {
    out({type: 'turn.completed', usage: {input_tokens: plan.reported_total ?? total, cached_input_tokens: 0, output_tokens: 0}});
  } else if (typeof step === 'number') {
    sleep(step);
  }
}
if (plan.hang) { setInterval(() => {}, 1000); }
"""


class PlanCodex(CodexAgent):
    def __init__(self, plan: dict, **kw) -> None:
        super().__init__(**kw)
        self.plan = plan

    def prepare_sandbox(self, sb):
        (sb.root / "fake-codex.js").write_text(PLAN_CODEX)
        (sb.root / "plan.json").write_text(json.dumps(self.plan))
        (sb.agent_config / "config.toml").write_text(config_toml(self.model, self.effort))
        return AgentNeeds(env={"CODEX_HOME": str(sb.agent_config)})

    def command(self, sb, session, turn, last_message):
        return [str(sb.node), str(sb.root / "fake-codex.js")]

    def version(self):
        return "fake"

    def features(self):
        return {}


def _codex_turn(tmp_path, runtime, server, sandbox_root, plan, budget=2, name="plan"):  # noqa: F811
    agent = PlanCodex(plan, step_budget=budget)
    sb = build_sandbox(name, runtime=runtime, api_port=server.api_port, scenario=mini_scenario(),
                       scenario_dir=MINI, workspace=None, agent=agent, root=sandbox_root)  # fmt: skip
    try:
        return agent.run_turn(sb, "go", Session(), turn=1, record_dir=tmp_path / name, timeout_s=60)
    finally:
        sb.cleanup()


FOUR = ["message", "request", "command", "request", "command", "request", "command", "message", "request", "complete"]


@needs_sandbox
def test_codex_completed_over_budget_is_max_turns(tmp_path, runtime, server, sandbox_root):  # noqa: F811
    """Four responses delivered and the turn completed before any poll: still over budget 2."""
    r = _codex_turn(tmp_path, runtime, server, sandbox_root, {"steps": FOUR})
    assert r.exit_status == "max_turns" and r.model_requests == 4
    assert "exceeded" in r.error or "step budget" in r.error
    ok = _codex_turn(tmp_path, runtime, server, sandbox_root, {"steps": FOUR}, budget=4, name="plan4")
    assert ok.exit_status == "ok" and ok.model_requests == 4


@needs_sandbox
def test_codex_budget_fails_closed(tmp_path, runtime, server, sandbox_root):  # noqa: F811
    cases = {
        "deleted": {"steps": ["request", "command", 400, "delete_rollout", 400, "request", "command", 600], "hang": True},
        "truncated": {"steps": ["request", "command", "request", 400, "truncate_rollout", 600], "hang": True},
        "garbage": {"steps": ["request", 300, "garbage_rollout", 600], "hang": True},
        # completed, but the session log shows fewer responses than the event stream proves
        "fewer": {"steps": ["message", "request", "command", "message", "command", "message", "complete"], "reported_total": 100},
        # completed, session log accounts for fewer tokens than turn.completed reports
        "tokens": {"steps": ["request", "message", "complete"], "reported_total": 500},
        # events but never a session log
        "none": {"steps": ["message", "command", "message", "complete"], "no_rollout": True},
    }
    for name, plan in cases.items():
        r = _codex_turn(tmp_path, runtime, server, sandbox_root, plan, budget=40, name=name)
        assert r.exit_status == "infra_error", (name, r.exit_status, r.error)
        assert "budget accounting lost" in r.error and r.extra.get("budget_unknown"), (name, r.error)


def test_requests_lower_bound():
    from bench.harness.agents.codex import requests_lower_bound

    ev = lambda **e: json.dumps(e)  # noqa: E731
    msg = lambda i: ev(type="item.completed", item={"id": i, "type": "agent_message"})  # noqa: E731
    cmd = lambda i: "\n".join([ev(type="item.started", item={"id": i, "type": "command_execution"}),  # noqa: E731
                               ev(type="item.completed", item={"id": i, "type": "command_execution"})])  # fmt: skip
    done = ev(type="turn.completed", usage={})
    assert requests_lower_bound("\n".join([msg("a"), cmd("b"), cmd("c"), msg("d"), done])) == 2
    assert requests_lower_bound("\n".join([cmd("b"), cmd("c"), done])) == 2  # tools, then a final response
    assert requests_lower_bound((FIXTURES / "codex-turn1.jsonl").read_text()) == 2  # genuine: 4 in the log


FAKE_CLAUDE = r"""
// Stand-in for `claude -p --output-format stream-json`: N tool-using responses, then success,
// ignoring --max-turns (so the harness's own check is what is tested).
const n = 4, out = (e) => process.stdout.write(JSON.stringify(e) + '\n');
out({type: 'system', subtype: 'init', session_id: 'S', tools: ['Bash','Edit','Glob','Grep','Read','Skill','Write'],
     mcp_servers: [], model: 'claude-haiku-5-5', skills: ['compta'], plugins: [], agents: []});
for (let i = 1; i <= n; i++) {
  out({type: 'assistant', session_id: 'S', message: {id: 'm' + i, model: 'claude-haiku-5-5',
       content: [{type: 'tool_use', id: 't' + i, name: 'Bash', input: {command: 'compta todo --json'}}]}});
  out({type: 'user', session_id: 'S', message: {content: [{type: 'tool_result', tool_use_id: 't' + i, content: 'ok'}]}});
}
out({type: 'assistant', session_id: 'S', message: {id: 'm9', model: 'claude-haiku-5-5', content: [{type: 'text', text: 'done'}]}});
out({type: 'result', subtype: 'success', is_error: false, num_turns: n + 1, result: 'done', session_id: 'S',
     total_cost_usd: 0.01, usage: {input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1}});
"""


@needs_sandbox
def test_claude_small_budget(tmp_path, runtime, server, sandbox_root):  # noqa: F811
    from bench.harness.agents.claude_code import ClaudeCodeAgent

    class FakeClaude(ClaudeCodeAgent):
        def prepare_sandbox(self, sb):
            (sb.root / "fake-claude.js").write_text(FAKE_CLAUDE)
            return AgentNeeds()

        def command(self, session, turn):
            argv = super().command(session, turn)
            self.seen_argv = argv
            return [str(self._node), str(self._root / "fake-claude.js")]

        def version(self):
            return "fake"

    agent = FakeClaude("c", "claude-haiku-5-5", max_turns=2)
    sb = build_sandbox("fc", runtime=runtime, api_port=server.api_port, scenario=mini_scenario(),
                       scenario_dir=MINI, workspace=None, agent=agent, root=sandbox_root)  # fmt: skip
    agent._node, agent._root = sb.node, sb.root
    try:
        r = agent.run_turn(sb, "go", Session(), turn=1, record_dir=tmp_path / "fc", timeout_s=60)
    finally:
        sb.cleanup()
    assert agent.seen_argv[agent.seen_argv.index("--max-turns") + 1] == "2"
    assert r.model_requests == 5 and r.tool_calls == 4
    assert r.exit_status == "max_turns" and "exceeded" in r.error
