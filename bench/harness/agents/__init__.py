"""Agent adapters and the registry used by the scheduler (`--agents`)."""

from __future__ import annotations

from collections.abc import Callable

from .base import AgentAdapter, HermeticityError, Session, TurnResult, Usage
from .claude_code import ClaudeCodeAgent
from .codex import CodexAgent
from .minimal import MinimalAgent
from .scripted import ScriptContext, ScriptedAgent, null_policy, whoami_policy

__all__ = [
    "AGENTS",
    "AgentAdapter",
    "ClaudeCodeAgent",
    "CodexAgent",
    "HermeticityError",
    "MinimalAgent",
    "ScriptContext",
    "ScriptedAgent",
    "Session",
    "TurnResult",
    "Usage",
    "default_agent_ids",
    "make_agent",
    "register_agent",
]  # fmt: skip

#: id -> factory(**options). `--agents all` = the default-enabled ones (not minimal/scripted).
AGENTS: dict[str, Callable[..., AgentAdapter]] = {
    "claude-opus": lambda claude_auth="token", **_: ClaudeCodeAgent("claude-opus", "claude-opus-5-5", auth=claude_auth),
    "claude-sonnet": lambda claude_auth="token", **_: ClaudeCodeAgent("claude-sonnet", "claude-sonnet-5-5", auth=claude_auth),
    "claude-haiku": lambda claude_auth="token", **_: ClaudeCodeAgent("claude-haiku", "claude-haiku-5-5", auth=claude_auth),
    "codex": lambda **_: CodexAgent("codex", "gpt-6.1-sol", "high"),
    "codex-luna": lambda **_: CodexAgent("codex-luna", "gpt-6-luna", "high"),
    "minimal": lambda allow_paid_api=False, **_: MinimalAgent(allow_paid_api=allow_paid_api),
    # free, deterministic pipeline checks (never part of `all`)
    "scripted-null": lambda **_: ScriptedAgent("scripted-null", null_policy),
    "scripted-whoami": lambda **_: ScriptedAgent("scripted-whoami", whoami_policy),
    # the graders' reference agents (bench/graders/baselines.py)
    "oracle": lambda **_: _baseline("oracle"),
    "null": lambda **_: _baseline("null"),
    "reckless": lambda **_: _baseline("reckless"),
}


def _baseline(name: str) -> AgentAdapter:
    from ...graders.baselines import POLICIES

    return ScriptedAgent(name, POLICIES[name])
DEFAULT_AGENTS = ("claude-opus", "claude-sonnet", "claude-haiku", "codex", "codex-luna")


def register_agent(agent: AgentAdapter | Callable[..., AgentAdapter], id: str | None = None) -> None:
    """Make an agent (e.g. a ScriptedAgent policy) selectable by id."""
    if isinstance(agent, AgentAdapter):
        AGENTS[id or agent.id] = lambda **_: agent
    else:
        assert id, "id required for a factory"
        AGENTS[id] = agent


def make_agent(id: str, **options) -> AgentAdapter:
    if id not in AGENTS:
        raise KeyError(f"unknown agent {id!r}; known: {sorted(AGENTS)}")
    return AGENTS[id](**options)


def default_agent_ids() -> list[str]:
    return list(DEFAULT_AGENTS)
