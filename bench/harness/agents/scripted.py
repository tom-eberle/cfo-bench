"""Deterministic scripted agents (tests, and the graders' oracle / null / reckless policies).

A policy is a Python callable `policy(ctx) -> str` (the turn's final message). It acts only
through `ctx.sh(command)`, which runs `/bin/sh -c command` inside the same seatbelt sandbox and
environment allow-list as a real agent, so its writes reach the fake server through the real
`compta` wrapper. Every command and message lands in the normalized transcript.

    def oracle(ctx):
        if ctx.turn == 1:
            out = ctx.sh("compta ops list --json").stdout
            return "Plan: …"
        ctx.sh("compta ops set 1004 --category 77 --yes --json")
        return "Done."

    register_agent(ScriptedAgent("oracle", oracle))
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from ..sandbox import AgentNeeds, ProcResult, Sandbox
from .base import AgentAdapter, Normalized, Session, TurnResult, Usage
from .codex import strip_frontmatter


class TurnTimeout(Exception):
    pass


class ScriptedRateLimit(Exception):
    """Raise from a policy to simulate a usage limit (scheduler tests)."""

    def __init__(self, reset: datetime | None = None) -> None:
        super().__init__("usage limit (scripted)")
        self.reset = reset


class ScriptedInfraError(Exception):
    """Raise from a policy to simulate a harness/infra failure, e.g. a lost login (scheduler tests)."""


@dataclass
class ScriptContext:
    sandbox: Sandbox
    task: dict[str, Any]
    turn: int
    prompt: str
    session: Session
    norm: Normalized
    deadline: float
    commands: list[dict[str, Any]] = field(default_factory=list)

    @property
    def state(self) -> dict[str, Any]:
        """Free-form memory carried from turn 1 to turn 2."""
        return self.session.data

    def sh(self, command: str, timeout: float = 120.0) -> ProcResult:
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise TurnTimeout(command)
        res = self.sandbox.sh(command, timeout=min(timeout, left))
        output = res.stdout + (("\n" + res.stderr) if res.stderr else "")
        self.norm.command(command, output, res.returncode)
        self.commands.append({"command": command, "returncode": res.returncode})
        if res.timed_out and time.monotonic() >= self.deadline:
            raise TurnTimeout(command)
        return res

    def say(self, text: str) -> None:
        """An intermediate assistant message."""
        self.norm.message(text)

    def write_file(self, relpath: str, content: str) -> Path:
        """Write a local file in work/ (e.g. a plan) as an agent's file tool would."""
        p = self.sandbox.work / relpath
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        self.norm.tool("Write", {"file_path": relpath}, "ok")
        return p


Policy = Callable[[ScriptContext], str]


class ScriptedAgent(AgentAdapter):
    subscription = "scripted"
    default_enabled = False

    def __init__(self, id: str, policy: Policy, *, skill: str = "claude", subscription: str = "scripted") -> None:
        self.id = id
        self.subscription = subscription
        self.model = f"scripted:{id}"
        self.policy = policy
        self.skill = skill
        self.task: dict[str, Any] = {}

    def version(self) -> str:
        return "scripted"

    def prepare_sandbox(self, sb: Sandbox) -> AgentNeeds:
        if self.skill == "claude":
            d = sb.work / ".claude" / "skills" / "compta"
            d.mkdir(parents=True)
            (d / "SKILL.md").write_text(sb.runtime.skill_text)
        elif self.skill == "agents_md":
            (sb.work / "AGENTS.md").write_text(strip_frontmatter(sb.runtime.skill_text))
        return AgentNeeds()

    def run_turn(
        self, sb: Sandbox, prompt: str, session: Session, *, turn: int, record_dir: Path, timeout_s: float
    ) -> TurnResult:
        record_dir.mkdir(parents=True, exist_ok=True)
        (record_dir / f"prompt-turn-{turn}.txt").write_text(prompt)
        norm = Normalized(record_dir, turn)
        start = time.monotonic()
        ctx = ScriptContext(sb, self.task, turn, prompt, session, norm, start + timeout_s)
        session.id = session.id or f"scripted-{sb.run_id}"
        status, error, final, reset = "ok", None, "", None
        try:
            final = self.policy(ctx) or ""
        except TurnTimeout:
            status, error = "timeout", "turn timed out"
        except ScriptedRateLimit as e:
            status, error, reset = "rate_limited", str(e), e.reset
        except ScriptedInfraError as e:
            status, error = "infra_error", str(e)
        except Exception as e:  # noqa: BLE001 - a crashing policy is an agent error, recorded
            status, error = "agent_error", f"{type(e).__name__}: {e}"
        norm.final(final)
        return TurnResult(
            turn=turn,
            final_text=final,
            session_id=session.id,
            transcript=None,
            usage=Usage(),
            cost_usd=0.0,
            num_turns=None,  # no model
            model_requests=None,
            tool_calls=len(ctx.commands),
            duration_s=time.monotonic() - start,
            exit_status=status,
            rate_limit_reset=reset,
            error=error,
            resolved_config={"policy": getattr(self.policy, "__name__", repr(self.policy))},
        )


# ---- trivial examples ------------------------------------------------------------------------


def null_policy(ctx: ScriptContext) -> str:
    """Does nothing."""
    return "Je n'ai rien fait." if ctx.turn == 1 else "OK."


def whoami_policy(ctx: ScriptContext) -> str:
    """Reads the company through the CLI and reports it; never writes."""
    out = ctx.sh("compta whoami --json").stdout
    return f"whoami: {out.strip()[:200]}"
