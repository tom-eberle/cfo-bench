"""Common adapter interface: `run_turn(sandbox, prompt, session) -> TurnResult`.

Every adapter also appends to `<record>/transcript.normalized.jsonl` one line per event, the
same shape for every agent (what graders read):

    {"turn": 1, "type": "message", "text": "…"}                        assistant text
    {"turn": 1, "type": "command", "command": "compta …", "output": "…", "exit_code": 0}
    {"turn": 1, "type": "tool", "name": "Read", "input": {…}, "output": "…"}   non-shell tools
    {"turn": 1, "type": "final", "text": "…"}                          the turn's final message

`output` is the model-visible tool result text (Claude: the tool_result content; Codex: the
command's aggregated output), cut at OUTPUT_CAP characters (then `truncated: true` and
`output_chars` = the full length). Non-text results (a PDF or image given to the model) are
rendered as `[document application/pdf sha256=…]` so graders can map them to mailbox files.
"""

from __future__ import annotations

import json
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from ..sandbox import AgentNeeds, Sandbox

#: Common step budget, in model requests per conversation turn (DESIGN §5): Claude Code's
#: `--max-turns` counts one turn per assistant message, i.e. per model response (verified on a
#: recorded stream: num_turns = 8 = distinct assistant message ids, 7 with tool_use + the final
#: answer). Codex is stopped by the harness at the same count of model requests (token_count
#: events of its session log); the minimal agent loops at most this many times.
STEP_BUDGET = 40
#: Tool outputs in the normalized transcript are kept whole up to this many characters.
OUTPUT_CAP = 200_000

EXIT_STATUSES = ("ok", "timeout", "max_turns", "agent_error", "rate_limited", "infra_error")
#: Statuses after which a run is discarded and redone from a fresh state.
RETRY_STATUSES = ("rate_limited", "infra_error")


class HermeticityError(RuntimeError):
    """The agent's configuration is not the fixed benchmark configuration: abort the batch."""


@dataclass
class Usage:
    input_tokens: int = 0  # uncached input (incl. cache writes for Claude)
    cached_input_tokens: int = 0  # cache reads
    output_tokens: int = 0  # incl. reasoning
    reasoning_tokens: int | None = None
    cache_write_tokens: int | None = None  # Claude cache creation (subset of input_tokens)

    def add(self, other: Usage) -> Usage:
        def opt(a: int | None, b: int | None) -> int | None:
            return None if a is None and b is None else (a or 0) + (b or 0)

        return Usage(
            self.input_tokens + other.input_tokens,
            self.cached_input_tokens + other.cached_input_tokens,
            self.output_tokens + other.output_tokens,
            opt(self.reasoning_tokens, other.reasoning_tokens),
            opt(self.cache_write_tokens, other.cache_write_tokens),
        )


@dataclass
class TurnResult:
    turn: int
    final_text: str
    session_id: str | None
    transcript: str | None  # raw event stream, relative to the record dir
    usage: Usage
    cost_usd: float | None
    #: = model_requests (one unit everywhere: model responses in this conversation turn)
    num_turns: int | None
    duration_s: float
    exit_status: str
    rate_limit_reset: datetime | None = None
    resolved_config: dict[str, Any] | None = None
    error: str | None = None
    returncode: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    #: model responses in this turn (Claude: assistant messages; Codex: session-log requests)
    model_requests: int | None = None
    #: tool/command executions requested in this turn (any tool, shell or not)
    tool_calls: int | None = None

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d["rate_limit_reset"] = self.rate_limit_reset.isoformat() if self.rate_limit_reset else None
        return d


@dataclass
class Session:
    """Conversation state carried from turn 1 to turn 2."""

    id: str | None = None
    data: dict[str, Any] = field(default_factory=dict)


class AgentAdapter(ABC):

    step_budget: int = STEP_BUDGET

    def set_step_budget(self, n: int) -> None:
        """Model-response budget per conversation turn for the next run (same for every agent)."""
        self.step_budget = n
    id: str
    model: str
    #: Agents sharing a subscription pause together on a usage limit.
    subscription: str
    #: Runnable under `--agents all`.
    default_enabled = True

    def preflight(self) -> None:
        """Raise if the agent can't run (no login, non-hermetic config, …)."""

    @abstractmethod
    def prepare_sandbox(self, sb: Sandbox) -> AgentNeeds:
        """Install the skill/config in the fresh sandbox; return env + allow-listed paths."""

    @abstractmethod
    def run_turn(
        self, sb: Sandbox, prompt: str, session: Session, *, turn: int, record_dir: Path, timeout_s: float
    ) -> TurnResult: ...

    def private_strings(self, sb: Sandbox) -> list[str]:
        """Personal strings (account email…) found in this run's own auth config, to redact."""
        return []

    def finalize(self, sb: Sandbox, record_dir: Path) -> None:
        """After the run: move agent-side transcripts into the record, clean shared state."""

    def version(self) -> str:
        return "n/a"

    def describe(self) -> dict[str, Any]:
        return {"id": self.id, "model": self.model, "subscription": self.subscription, "version": self.version()}


class Normalized:
    """Appends normalized events to `<record>/transcript.normalized.jsonl`."""

    def __init__(self, record_dir: Path, turn: int) -> None:
        self.path = record_dir / "transcript.normalized.jsonl"
        self.turn = turn

    def _write(self, event: dict[str, Any]) -> None:
        with self.path.open("a") as f:
            f.write(json.dumps({"turn": self.turn, **event}, ensure_ascii=False) + "\n")

    def message(self, text: str) -> None:
        if text:
            self._write({"type": "message", "text": text})

    @staticmethod
    def _out(output: Any) -> dict[str, Any]:
        if output is None:
            return {"output": None}
        text = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
        if len(text) <= OUTPUT_CAP:
            return {"output": text}
        return {"output": text[:OUTPUT_CAP], "truncated": True, "output_chars": len(text)}

    def command(self, command: str, output: Any, exit_code: int | None) -> None:
        self._write({"type": "command", "command": command, **self._out(output), "exit_code": exit_code})

    def tool(self, name: str, input: Any, output: Any) -> None:
        self._write({"type": "tool", "name": name, "input": input, **self._out(output)})

    def final(self, text: str) -> None:
        self._write({"type": "final", "text": text})
