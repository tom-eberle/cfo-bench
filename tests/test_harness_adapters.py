"""Adapters parse recorded event streams (genuine Codex/Claude captures, sanitized, plus small
synthetic streams in the same formats) and classify outcomes from structured events only."""

from __future__ import annotations

import json
from datetime import datetime

from _harness_env import FIXTURES

from bench.harness import pricing
from bench.harness.agents.base import Normalized, Usage
from bench.harness.agents.claude_code import SETTINGS, TOOLS, check_config_dir, check_init, parse_stream
from bench.harness.agents.claude_code import classify as claude_classify
from bench.harness.agents.codex import (
    DISABLED_FEATURES,
    config_toml,
    parse_events,
    rollout_requests,
    strip_frontmatter,
    subtract_usage,
    summarize_rollout,
)
from bench.harness.agents.codex import classify as codex_classify
from bench.harness.ratelimit import PARIS, parse_reset


def text(name: str) -> str:
    return (FIXTURES / name).read_text()


def events(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


# ---- Codex ---------------------------------------------------------------------------------------


def test_codex_genuine_turn(tmp_path):
    p = parse_events(text("codex-turn1.jsonl"), Normalized(tmp_path, 1))
    assert p["thread_id"].startswith("01a154")
    assert p["completed"] and not p["failed"]
    assert p["usage"] == Usage(8441, 49152, 396, 0, 0)
    assert codex_classify(p, 0, False) == ("ok", None, None)
    ev = events(tmp_path / "transcript.normalized.jsonl")
    cmds = [e["command"] for e in ev if e["type"] == "command"]
    assert "/bin/zsh -lc 'compta ops get 1004 --json'" in cmds
    assert any(e["type"] == "tool" and e["name"] == "file_change" for e in ev)
    assert ev[-1]["type"] == "message" and "Apply this 1 change?" in ev[-1]["text"]


def test_codex_resumed_usage_is_cumulative():
    p1 = parse_events(text("codex-turn1.jsonl"))
    p2 = parse_events(text("codex-turn2-resumed.jsonl"))
    # the resumed turn reports thread totals; the adapter keeps the difference
    assert p2["usage"].input_tokens + p2["usage"].cached_input_tokens == 91099
    assert subtract_usage(p2["usage"], p1["usage"]) == Usage(866, 32640, 84, 0, 0)


def test_codex_whoami_probe_reached_fake_server():
    p = parse_events(text("codex-whoami.jsonl"))
    assert "Fictional Test Widgets" in p["last_message"]
    assert p["counts"]["command_execution"] == 1


def test_codex_rollout_requests_and_cost():
    path = FIXTURES / "codex-rollout.jsonl"
    reqs, total = rollout_requests(path, 0)
    assert len(reqs) == 6 and total == 91579
    later, _ = rollout_requests(path, 57989)  # what turn 2 sees after turn 1
    assert len(later) == 2
    whole = pricing.cost_usd_requests("openai", "gpt-6.1-sol", reqs)
    by_turn = pricing.cost_usd("openai", "gpt-6.1-sol", Usage(8441, 49152, 396)) + pricing.cost_usd(
        "openai", "gpt-6.1-sol", Usage(866, 32640, 84)
    )
    assert abs(whole - by_turn) < 1e-9
    s = summarize_rollout(path)
    assert s["turn_contexts"][0]["model"] == "gpt-6.1-sol" and s["turn_contexts"][0]["effort"] == "high"
    assert "skills_instructions" not in s["developer_blocks"]


def test_codex_long_context_pricing():
    p = pricing.price_entry("openai", "gpt-6.1-sol")
    big = Usage(input_tokens=300_000, cached_input_tokens=0, output_tokens=1000)
    assert pricing.cost_usd_requests("openai", "gpt-6.1-sol", [big]) == (300_000 * p["long_input"] + 1000 * p["long_output"]) / 1e6


def test_codex_usage_limit():
    p = parse_events(text("codex-usage-limit.synthetic.jsonl"))
    status, err, reset = codex_classify(p, 1, False)
    assert status == "rate_limited" and "usage limit" in err
    assert reset == datetime(2026, 10, 20, 17, 34, tzinfo=PARIS)


def test_codex_auth_failure_is_infra():
    p = parse_events('{"type":"thread.started","thread_id":"t"}\n{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized)"}\n'
                     '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer"}}\n')  # fmt: skip
    assert codex_classify(p, 1, False)[0] == "infra_error"
    assert codex_classify(parse_events(""), None, True)[0] == "timeout"


def test_codex_config_is_minimal_and_hermetic():
    toml = config_toml("gpt-6.1-sol", "high")
    import tomllib

    c = tomllib.loads(toml)
    assert c["model"] == "gpt-6.1-sol" and c["model_reasoning_effort"] == "high"
    assert c["approval_policy"] == "never" and c["skills"]["bundled"]["enabled"] is False
    assert all(c["features"][f] is False for f in DISABLED_FEATURES)
    assert strip_frontmatter("---\nname: x\n---\n\n# Body\n") == "# Body\n"


# ---- Claude Code ---------------------------------------------------------------------------------


def test_claude_success_stream(tmp_path):
    p = parse_stream(text("claude-success.synthetic.jsonl"), Normalized(tmp_path, 1))
    assert p["session_id"] and p["init"]["tools"] == ["Bash", "Edit", "Glob", "Grep", "Read", "Skill", "Write"]
    assert p["final_text"].startswith("Plan : 1 opération")
    assert p["usage"] == Usage(3020, 12000, 400, None, 3000)
    assert p["result"]["total_cost_usd"] == 0.1234
    assert claude_classify(p, 0, False) == ("ok", None, None)
    ev = events(tmp_path / "transcript.normalized.jsonl")
    assert [e["type"] for e in ev] == ["message", "command", "tool", "message"]
    assert ev[1] == {"turn": 1, "type": "command", "command": "compta ops list --json",
                     "output": '[{"id": "1004"}]', "exit_code": 0}  # fmt: skip
    assert ev[2]["name"] == "Read" and ev[2]["output"] == "FACTURE 42"
    problems, always_on = check_init(p["init"], "claude-opus-5-5")
    assert problems == [] and always_on == []


def test_claude_rate_limited():
    p = parse_stream(text("claude-rate-limited.synthetic.jsonl"))
    status, err, reset = claude_classify(p, 1, False)
    assert status == "rate_limited"
    assert reset == datetime.fromtimestamp(1792440000, tz=PARIS)


def test_claude_max_turns_and_not_logged_in():
    p = parse_stream(text("claude-max-turns.synthetic.jsonl"))
    assert claude_classify(p, 1, False)[0] == "max_turns"
    p = parse_stream(text("claude-not-logged-in.jsonl"))  # genuine capture, no login
    status, err, _ = claude_classify(p, 1, False)
    assert status == "infra_error" and "Not logged in" in err
    assert claude_classify(parse_stream(""), 1, False)[0] == "infra_error"
    assert claude_classify(parse_stream(""), None, True)[0] == "timeout"


def test_claude_init_hermeticity():
    genuine = json.loads(text("claude-not-logged-in.jsonl").splitlines()[0])  # with the bench settings
    problems, _ = check_init(genuine, "claude-haiku-5-5")
    assert problems == []
    leaky = json.loads(text("claude-init-leaky.synthetic.jsonl"))
    problems, _ = check_init(leaky, "claude-opus-5-5")
    joined = " ".join(problems)
    assert "MCP tools" in joined and "MCP servers" in joined and "claude-mem" in joined
    problems, _ = check_init(genuine, "claude-opus-5-5")
    assert any("model" in p for p in problems)


def test_claude_unexpected_tool_is_a_configuration_error():
    """Phase B review: a tool beyond the fixed seven (web search, web fetch, subagents) fails the
    run as a configuration problem; the real init (genuine captures) passes."""
    genuine = json.loads(text("claude-not-logged-in.jsonl").splitlines()[0])
    haiku = parse_stream(text("claude-haiku-money-todo.jsonl"))["init"]
    for init, model in ((genuine, "claude-haiku-5-5"), (haiku, "claude-haiku-5-5")):
        assert sorted(init["tools"]) == sorted(TOOLS)
        assert check_init(init, model) == ([], [])
    for extra in ("WebSearch", "WebFetch", "Agent", "Task", "NotebookEdit"):
        bad = {**genuine, "tools": [*genuine["tools"], extra]}
        problems, unexpected = check_init(bad, "claude-haiku-5-5")
        assert unexpected == [extra] and any(f"unexpected tools ['{extra}']" in p for p in problems), problems


def test_claude_config_dir_check(tmp_path):
    assert check_config_dir(tmp_path) == []
    (tmp_path / "CLAUDE.md").write_text("be nice")
    (tmp_path / "skills" / "x").mkdir(parents=True)
    (tmp_path / "settings.json").write_text(json.dumps({"hooks": {"Stop": []}, "model": "x"}))
    (tmp_path / ".claude.json").write_text(json.dumps({"mcpServers": {"m": {}}, "oauthAccount": {}}))
    problems = " | ".join(check_config_dir(tmp_path))
    for needle in ("CLAUDE.md", "skills/", "hooks", "mcpServers"):
        assert needle in problems
    assert SETTINGS["disableBundledSkills"] is True


# ---- rate-limit reset parsing --------------------------------------------------------------------


def test_parse_reset_forms():
    now = datetime(2026, 10, 19, 18, 0, tzinfo=PARIS)
    assert parse_reset("Claude AI usage limit reached|1792440000", now) == datetime.fromtimestamp(1792440000, tz=PARIS)
    assert parse_reset("try again at 5:34 PM", now) == datetime(2026, 10, 20, 17, 34, tzinfo=PARIS)
    assert parse_reset("try again at 7:05 PM", now) == datetime(2026, 10, 19, 19, 5, tzinfo=PARIS)
    assert parse_reset("resets 7pm (Europe/Paris)", now) == datetime(2026, 10, 19, 19, 0, tzinfo=PARIS)
    assert parse_reset("try again in 1 hour 30 minutes", now) == datetime(2026, 10, 19, 19, 30, tzinfo=PARIS)
    assert parse_reset('{"resets_in_seconds": 120}', now) == datetime(2026, 10, 19, 18, 2, tzinfo=PARIS)
    assert parse_reset("rate limited, no time given", now) is None


def test_codex_builtin_empty_mcp_listing_is_not_a_leak():
    from bench.harness.agents.codex import check_resolved, parse_events

    def ev(server, tool, text):
        item = {"id": "i1", "type": "mcp_tool_call", "server": server, "tool": tool, "arguments": {},
                "result": {"content": [{"type": "text", "text": text}]}, "error": None, "status": "completed"}
        return json.dumps({"type": "item.completed", "item": item})

    ok = parse_events(ev("codex", "list_mcp_resources", '{"resources":[]}'))
    assert check_resolved({}, ok) == []
    for bad in (ev("codex", "list_mcp_resources", '{"resources":[{"uri":"x"}]}'),
                ev("codex", "read_mcp_resource", '{}'),
                ev("claude-mem", "search", '{"resources":[]}')):
        assert any("MCP tool calls present" in p for p in check_resolved({}, parse_events(bad)))
    started = json.dumps({"type": "item.started", "item": {"id": "i9", "type": "mcp_tool_call", "server": "x", "tool": "y"}})
    assert check_resolved({}, parse_events(started))


def test_codex_configuration_and_forbidden_tools(tmp_path):
    """Phase B review: Codex's resolved configuration must be the bench config, and web search or
    image generation in a turn is a configuration error; its own collaboration tools are allowed."""
    from bench.harness.agents.codex import check_resolved

    resolved = {"config_toml": config_toml("gpt-6.1-sol", "high"), "features_enabled": ["shell_tool", "unified_exec"],
                "expected_model": "gpt-6.1-sol", "expected_effort": "high", "forbidden_calls": []}  # fmt: skip

    def item(kind, **kw):
        return json.dumps({"type": "item.completed", "item": {"id": "i1", "type": kind, **kw}})

    ok = parse_events("\n".join([item("command_execution", command="compta whoami", aggregated_output="", exit_code=0),
                                 item("file_change", changes=[]), item("collab_tool_call", tool="spawn_agent"),
                                 item("todo_list", items=[]), item("agent_message", text="ok")]))  # fmt: skip
    assert check_resolved(resolved, ok) == []
    web = parse_events(item("web_search", query="taux TVA"))
    assert any("forbidden tools used: ['web_search']" in p for p in check_resolved(resolved, web))
    assert any("config.toml differs" in p for p in check_resolved({**resolved, "config_toml": resolved["config_toml"] + 'web_search = "live"\n'}, ok))
    assert any("disabled features enabled" in p for p in check_resolved({**resolved, "features_enabled": [DISABLED_FEATURES[0]]}, ok))
    # a web search the --json stream did not show is still in the rollout
    rollout = tmp_path / "rollout.jsonl"
    rollout.write_text(json.dumps({"type": "response_item", "payload": {"type": "web_search_call", "status": "completed"}}) + "\n")
    assert summarize_rollout(rollout)["forbidden_calls"] == ["web_search_call"]
    assert any("web_search_call" in p for p in check_resolved({**resolved, **summarize_rollout(rollout)}, ok))
    # the recorded rollout of a real turn has none
    assert summarize_rollout(FIXTURES / "codex-rollout.jsonl")["forbidden_calls"] == []
