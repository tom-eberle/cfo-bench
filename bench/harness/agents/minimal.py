"""Optional minimal agent: Anthropic SDK + one bash tool, Opus 5.5.

OFF by default and excluded from `--agents all`. It bills the paid API, so it refuses to run
unless ANTHROPIC_API_KEY is set in the harness environment AND `--allow-paid-api` is passed.
The key stays in the harness process: the bash tool runs inside the same seatbelt sandbox with
the same environment allow-list as every other agent (no key there). Turn 2 continues the
message history. The skill text is the system prompt (as AGENTS.md is for Codex).
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

from .. import pricing
from ..sandbox import AgentNeeds, Sandbox
from .base import STEP_BUDGET, AgentAdapter, Normalized, Session, TurnResult, Usage
from .codex import strip_frontmatter

MODEL = "claude-opus-5-5"
MAX_TURNS = STEP_BUDGET  # model requests per conversation turn, as --max-turns for Claude
MAX_OUTPUT = 16000  # characters of command output returned to the model
BASH_TOOL = {
    "name": "bash",
    "description": "Run a shell command in the working directory and return stdout, stderr and the exit code.",
    "input_schema": {
        "type": "object",
        "properties": {"command": {"type": "string", "description": "The command to run with /bin/sh -c"}},
        "required": ["command"],
    },
}
SYSTEM = (
    "You are a coding agent working in a terminal on the user's machine. You have one tool, bash. "
    "The working directory contains the user's files. Follow these instructions:\n\n{skill}"
)


class MinimalAgent(AgentAdapter):
    subscription = "anthropic-api"
    default_enabled = False

    def __init__(self, id: str = "minimal", model: str = MODEL, *, allow_paid_api: bool = False) -> None:
        self.id = id
        self.model = model
        self.allow_paid_api = allow_paid_api
        self._client: Any = None

    def version(self) -> str:
        try:
            import anthropic

            return f"minimal (anthropic {anthropic.__version__})"
        except ImportError:
            return "minimal (anthropic not installed)"

    def preflight(self) -> None:
        if not self.allow_paid_api:
            raise RuntimeError("the minimal agent uses the paid API: pass --allow-paid-api to enable it")
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("the minimal agent needs ANTHROPIC_API_KEY in the harness environment")
        import anthropic  # optional dependency: `uv sync --extra minimal`

        self._client = anthropic.Anthropic()

    def prepare_sandbox(self, sb: Sandbox) -> AgentNeeds:
        return AgentNeeds()

    def run_turn(
        self, sb: Sandbox, prompt: str, session: Session, *, turn: int, record_dir: Path, timeout_s: float
    ) -> TurnResult:
        if self._client is None:
            self.preflight()
        record_dir.mkdir(parents=True, exist_ok=True)
        (record_dir / f"prompt-turn-{turn}.txt").write_text(prompt)
        norm = Normalized(record_dir, turn)
        messages: list[dict[str, Any]] = session.data.setdefault("messages", [])
        messages.append({"role": "user", "content": prompt})
        system = SYSTEM.format(skill=strip_frontmatter(sb.runtime.skill_text))
        usage = Usage(cache_write_tokens=0)
        start = time.monotonic()
        status, error, final, steps, tools = "max_turns", None, "", 0, 0
        import anthropic

        try:
            while steps < self.step_budget:
                if time.monotonic() - start > timeout_s:
                    status, error = "timeout", "turn timed out"
                    break
                steps += 1
                resp = self._client.messages.create(
                    model=self.model, max_tokens=16000, system=system, tools=[BASH_TOOL], messages=messages
                )
                u = resp.usage
                cw = getattr(u, "cache_creation_input_tokens", 0) or 0
                usage = usage.add(Usage(u.input_tokens + cw, getattr(u, "cache_read_input_tokens", 0) or 0,
                                        u.output_tokens, cache_write_tokens=cw))  # fmt: skip
                content = [b.model_dump() for b in resp.content]
                messages.append({"role": "assistant", "content": content})
                results = []
                for b in resp.content:
                    if b.type == "text":
                        final = b.text
                        norm.message(b.text)
                    elif b.type == "tool_use":
                        tools += 1
                        cmd = str(b.input.get("command", ""))
                        left = max(1.0, timeout_s - (time.monotonic() - start))
                        r = sb.sh(cmd, timeout=min(600.0, left))
                        out = f"{r.stdout}{r.stderr}"[-MAX_OUTPUT:] + f"\n[exit {r.returncode}]"
                        norm.command(cmd, r.stdout + r.stderr, r.returncode)
                        results.append({"type": "tool_result", "tool_use_id": b.id, "content": out})
                if not results:
                    status = "ok"
                    break
                messages.append({"role": "user", "content": results})
        except anthropic.RateLimitError as e:
            status, error = "rate_limited", str(e)
        except anthropic.APIError as e:
            status, error = "infra_error", str(e)
        norm.final(final)
        (record_dir / "minimal-messages.json").write_text(json.dumps(messages, ensure_ascii=False, indent=1, default=str))
        session.id = session.id or f"minimal-{sb.run_id}"
        return TurnResult(
            turn=turn,
            final_text=final,
            session_id=session.id,
            transcript=None,
            usage=usage,
            cost_usd=pricing.cost_usd("anthropic", self.model, usage),
            num_turns=steps,
            model_requests=steps,
            tool_calls=tools,
            duration_s=time.monotonic() - start,
            exit_status=status,
            error=error,
            resolved_config={"model": self.model, "tools": ["bash"], "max_turns": self.step_budget},
        )
