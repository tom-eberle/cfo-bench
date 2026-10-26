"""The inputs a grader sees for one run. Built by the harness from the run record; built by hand
in grader tests. Nothing here is agent-specific."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolCall:
    """One shell command the agent ran (any tool that executes commands), with its output."""

    command: str
    output: str = ""
    turn: int = 1


@dataclass
class RunData:
    task: dict[str, Any]
    truth: dict[str, Any]
    initial_ops: list[dict[str, Any]]  # the scenario's transactions (API.md §5), with file hashes
    final_state: dict[str, Any]  # the server's /__state at the end of the run (API.md §8.2)
    log: list[dict[str, Any]]
    finals: list[str]  # the agent's final message of each turn (turn 1 first)
    tool_calls: list[ToolCall] = field(default_factory=list)
    messages: list[str] = field(default_factory=list)  # every assistant text message, all turns
    proposal_text: str = ""  # frozen turn-1 final message
    proposal_plans: list[dict[str, Any]] = field(default_factory=list)  # plan JSONs present after turn 1
    provided_files: dict[str, str] = field(default_factory=dict)  # sha256 -> mailbox filename given to the agent
    scenario_files: set[str] = field(default_factory=set)  # sha256 of documents already in the books
    file_hashes: dict[str, str] = field(default_factory=dict)  # "files/x.pdf" / "mailbox/y.pdf" -> sha256
    exit_status: str = "ok"
    #: Text deliverables (reports, tables) a final message links to, {path: content as at the end of
    #: turn 1} (see `fromrecord.linked_deliverables`). Part of what the agent told the user, so in
    #: `all_text` (capability and asked-when-ambiguous checks); deliberately NOT part of
    #: `proposal_text`: what safety counts as proposed / consented stays the frozen turn-1 message +
    #: plan files, as pre-registered.
    linked_texts: dict[str, str] = field(default_factory=dict)
    category_labels: dict[int, str] = field(default_factory=dict)  # category id -> label (scenario)

    @property
    def final_ops(self) -> list[dict[str, Any]]:
        return list(self.final_state.get("transactions", []))

    @property
    def all_text(self) -> str:
        """Everything the agent said to the user (both turns), with the deliverables it linked."""
        return "\n\n".join([*self.messages, *self.finals, *self.linked_texts.values()])

    @property
    def tool_text(self) -> str:
        return "\n".join(f"$ {c.command}\n{c.output}" for c in self.tool_calls)


# Re-exported: command parsing lives in `commands` (shared with `safety`).
from .commands import MUTATING_CLI, is_mutating_command  # noqa: E402, F401
