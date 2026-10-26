"""Harness subcommands for `french-cfo-bench`: run, selftest, prepare-runtime, leak-test."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from . import paths


def _ids(value: str) -> list[str] | None:
    return None if value == "all" else [v.strip() for v in value.split(",") if v.strip()]


def cmd_run(args: argparse.Namespace) -> int:
    from .agents import default_agent_ids, make_agent
    from .protocol import load_task_specs
    from .runtime import ensure_runtime
    from .scheduler import Batch

    agent_ids = _ids(args.agents) or default_agent_ids()
    tasks = load_task_specs(args.scenario, _ids(args.tasks))
    out = Path(args.out or f"runs/{time.strftime('%Y%m%d-%H%M%S')}")
    if not out.is_absolute():
        out = paths.REPO_ROOT / out
    runtime = ensure_runtime()
    agents = {a: make_agent(a, allow_paid_api=args.allow_paid_api, claude_auth=args.claude_auth) for a in agent_ids}
    batch = Batch(
        out,
        agents=agents,
        tasks={t.id: t for t in tasks},
        repeats=args.repeats,
        seed=args.seed,
        runtime=runtime,
        timeout_s=args.timeout,
        keep_sandboxes=args.keep_sandboxes,
        retry_infra_errors=args.retry_infra_errors,
    )
    print(f"{len(batch.schedule)} runs → {out}", file=sys.stderr)
    progress = batch.run()
    print(json.dumps({k: progress[k] for k in ("total", "completed", "failures", "spend_usd")}))
    if not args.no_grade:  # grade the batch and write its report next to it
        from bench import report
        from bench.graders.fromrecord import grade_batch

        rows = grade_batch(out)
        (out / "results.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        report.write_report(rows, out / "report")
        print((out / "report" / "summary.md").read_text())
    return 0 if progress["completed"] == progress["total"] else 1


def cmd_selftest(args: argparse.Namespace) -> int:
    from .runtime import ensure_runtime
    from .sandbox import build_sandbox, selftest
    from .server import FakeServer

    sd = Path(args.scenario).resolve()
    scenario = json.loads((sd / "scenario.json").read_text())
    runtime = ensure_runtime()
    with FakeServer(sd) as server:
        sb = build_sandbox(f"selftest-{int(time.time())}", runtime=runtime, api_port=server.api_port,
                           scenario=scenario, scenario_dir=sd, workspace=None)  # fmt: skip
        try:
            res = selftest(sb, admin_port=server.admin_port, scenario_dir=sd)
        finally:
            sb.cleanup()
    for c in res.checks:
        print(f"{'ok  ' if c['ok'] else 'FAIL'} {c['name']}")
    return 0 if res.ok else 1


def cmd_prepare_runtime(args: argparse.Namespace) -> int:
    from .runtime import ensure_runtime

    rt = ensure_runtime(force=args.force)
    print(f"runtime {rt.dir} (compta-cli {rt.version}, source tree {rt.tree_sha256[:12]})")
    from .agents.claude_code import CLAUDE_CODE_VERSION, pin_claude
    from .agents.codex import CODEX_VERSION, pin_codex

    print(f"claude code {CLAUDE_CODE_VERSION} pinned at {pin_claude()}")
    print(f"codex cli {CODEX_VERSION} pinned at {pin_codex()}")
    return 0


def cmd_leak_test(args: argparse.Namespace) -> int:
    from .leaktest import leak_test

    out = Path(args.out)
    if not out.is_absolute():
        out = paths.REPO_ROOT / out
    for r in leak_test(_ids(args.agents), out, claude_auth=args.claude_auth):
        print(f"== {r['agent']} ({r['exit_status']})\n{r['answer']}\n")
    return 0


def add_subcommands(sub) -> None:
    p = sub.add_parser("leak-test", help="Ask each agent, in the benchmark sandbox, what it was given besides the skill")
    p.add_argument("--agents", default="all")
    p.add_argument("--out", default=f"runs/leak-test-{time.strftime('%Y%m%d-%H%M%S')}")
    p.add_argument("--claude-auth", choices=("token", "keychain"), default="token")
    p.set_defaults(func=cmd_leak_test)

    p = sub.add_parser("run", help="Run agents on tasks (two-phase protocol, sandboxed)")
    p.add_argument("--agents", default="all", help="all (= claude-opus,claude-sonnet,claude-haiku,codex,codex-luna) or ids")
    p.add_argument("--tasks", default="all", help="all or comma-separated task ids")
    p.add_argument("--repeats", type=int, default=3)
    p.add_argument("--seed", type=int, default=1, help="schedule shuffle seed")
    p.add_argument("--out", help="output dir (default runs/<timestamp>); rerun with the same --out to resume")
    p.add_argument("--scenario", default=None, help="scenario dir (default scenarios/atelier-lumen-s1)")
    p.add_argument("--timeout", type=float, default=None, help="per-turn wall clock, seconds (default 900)")
    p.add_argument("--keep-sandboxes", action="store_true", help="don't delete $TMPDIR/french-cfo-bench/<run>")
    p.add_argument("--no-grade", action="store_true", help="don't grade the batch and write <out>/report/ at the end")
    p.add_argument("--retry-infra-errors", action="store_true",
                   help="resume: also redo runs that ended as infra_error (old attempts kept, marked replaced)")
    p.add_argument("--allow-paid-api", action="store_true", help="allow the minimal agent (ANTHROPIC_API_KEY)")
    p.add_argument("--claude-auth", choices=("token", "keychain"), default="token",
                   help="token: ~/.config/french-cfo-bench/claude-oauth-token (default); keychain: the "
                        "benchmark config dir's keychain login (opt-in, see bench/harness/README.md)")  # fmt: skip
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("selftest", help="Check the agent sandbox against a scenario")
    p.add_argument("--scenario", default=str(paths.REPO_ROOT / "server/test/fixtures/mini"))
    p.set_defaults(func=cmd_selftest)

    p = sub.add_parser("prepare-runtime", help="Build the compta CLI (cli/) and copy it to ~/.cache/french-cfo-bench/runtime")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_prepare_runtime)
