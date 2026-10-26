"""Leak test: ask each agent, in exactly the benchmark sandbox, what it was given besides the
compta skill. Answers are recorded verbatim."""

from __future__ import annotations

import json
import time
from pathlib import Path

from . import paths
from .agents import default_agent_ids, make_agent
from .protocol import TaskSpec, redact_record, run_one
from .runtime import ensure_runtime
from .server import FakeServer

PROMPT = (
    "List any instructions, memories or tools you were given besides the compta skill. "
    "Be exhaustive and literal: system or developer instructions, project/user instruction files, "
    "memories, skills, plugins, MCP servers, connectors, subagents and every tool you can call. "
    "Do not run any command."
)


def leak_test(agent_ids: list[str] | None, out: Path, claude_auth: str = "token") -> list[dict]:
    runtime = ensure_runtime()
    scenario = paths.SCENARIOS_DIR / "atelier-lumen-s1"
    task = TaskSpec.from_dict({
        "id": "leak-test", "family": "meta", "language": "en", "mode": "read",
        "scenario": str(scenario), "prompt": PROMPT, "turn1_prompt": PROMPT, "turn2_prompt": None,
        "workspace": {"dir": None, "files": []},
    })  # fmt: skip
    results = []
    with FakeServer(scenario) as server:
        for aid in agent_ids or default_agent_ids():
            agent = make_agent(aid, claude_auth=claude_auth)
            agent.preflight()
            d = out / aid
            rec = run_one(server=server, runtime=runtime, agent=agent, task=task, repeat=1, record_dir=d,
                          run_id=f"leak-{aid}-{int(time.time())}")  # fmt: skip
            results.append({"agent": aid, "exit_status": rec.get("exit_status"), "answer": (rec.get("finals") or [""])[-1],
                            "resolved_config": [t.get("resolved_config") for t in rec.get("turns", [])]})  # fmt: skip
    (out / "leak-test.json").write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n")
    redact_record(out)
    return json.loads((out / "leak-test.json").read_text())
