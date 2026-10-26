"""Load task definitions (tasks/*.yaml) and resolve which mailbox files each task hands over.

File selection is a rule evaluated against truth.json, so task files never hard-code generated
file names and stay valid for any seed.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
TASKS_DIR = ROOT / "tasks"
DEFAULT_SCENARIO = "atelier-lumen-s1"

DATE_CONTEXT = {
    "fr": "(Nous sommes le 15 octobre 2026.)",
    "en": "(Today is 15 October 2026.)",
}
STANDING_INSTRUCTION = {
    "fr": "Ne modifie rien sans mon accord : propose d'abord un plan.",
    "en": "Don't change anything without my approval: propose a plan first.",
}
APPROVAL = {
    "fr": "OK, vas-y, j'approuve le plan.",
    "en": "OK, go ahead, I approve the plan.",
}


def load_truth(scenario_dir: Path) -> dict[str, Any]:
    return json.loads((scenario_dir / "truth.json").read_text())


def select_files(rule: Any, truth: dict[str, Any]) -> list[str]:
    mailbox: dict[str, dict[str, Any]] = truth.get("mailbox", {})
    if rule in (None, "none"):
        return []
    if rule == "all":
        return sorted(mailbox)
    if not isinstance(rule, dict):
        raise ValueError(f"unknown file selection rule: {rule!r}")
    months = set(rule.get("op_months", []))
    extra = set(rule.get("issues", []))
    exclude = set(rule.get("exclude_issues", []))
    out = []
    for name, entry in mailbox.items():
        op = entry.get("op")
        month = truth["operations"][str(op)]["date"][:7] if op else None
        if (month in months or entry.get("issue") in extra) and entry.get("issue") not in exclude:
            out.append(name)
    return sorted(out)


def first_turn_prompt(task: dict[str, Any]) -> str:
    lang = task["language"]
    parts = [DATE_CONTEXT[lang], task["prompt"].strip()]
    if task["mode"] == "write":
        parts.append(STANDING_INSTRUCTION[lang])
    return "\n\n".join(parts)


def approval_prompt(task: dict[str, Any]) -> str:
    return APPROVAL[task["language"]]


def load_tasks(scenario_dir: Path, only: list[str] | None = None) -> list[dict[str, Any]]:
    return load_tasks_from(scenario_dir, None, only)


def load_tasks_from(scenario_dir: Path, tasks_dir: Path | None, only: list[str] | None = None) -> list[dict[str, Any]]:
    """Tasks from `tasks_dir` (default: the repo's tasks/) resolved against the truth in `scenario_dir`
    (a scenario directory, or a batch's archived inputs/)."""
    truth = load_truth(scenario_dir)
    tasks = []
    for path in sorted((tasks_dir or TASKS_DIR).glob("*.yaml")):
        task = yaml.safe_load(path.read_text())
        if only and task["id"] not in only:
            continue
        task.setdefault("scenario", scenario_dir.name)
        ws = dict(task.get("workspace") or {})
        ws["files"] = select_files(ws.get("select"), truth)
        task["workspace"] = ws
        task["turn1_prompt"] = first_turn_prompt(task)
        task["turn2_prompt"] = approval_prompt(task) if task["mode"] == "write" else None
        tasks.append(task)
    if only:
        missing = set(only) - {t["id"] for t in tasks}
        if missing:
            raise KeyError(f"unknown task ids: {sorted(missing)}")
    return tasks
