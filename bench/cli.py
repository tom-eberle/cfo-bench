"""`cfo-bench` command line. Subcommands register themselves in COMMANDS."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def add_harness(sub) -> None:
    """run, selftest, prepare-runtime (bench/harness/cli.py)."""
    from bench.harness.cli import add_subcommands

    add_subcommands(sub)


def cmd_grade(args: argparse.Namespace) -> int:
    import json

    from bench.graders import fromrecord
    from bench.graders.fromrecord import grade_batch

    if args.current_tasks:
        fromrecord.USE_CURRENT_TASKS = True
        print("WARNING: grading with the repo's current task definitions (development only)", file=sys.stderr)
    batch = Path(args.batch)
    rows = grade_batch(batch)
    out = Path(args.out) if args.out else batch / "results.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    ok = sum(r["task_success"] for r in rows)
    print(f"graded {len(rows)} runs → {out} ({ok} successes)")
    return 0


def add_grade(sub) -> None:
    p = sub.add_parser("grade", help="Grade every run of a batch directory → results.jsonl")
    p.add_argument("batch", help="runs/<timestamp>")
    p.add_argument("--out", help="default: <batch>/results.jsonl")
    p.add_argument("--current-tasks", action="store_true", help="development only: use tasks/*.yaml instead of the batch's archived tasks")
    p.set_defaults(func=cmd_grade)


def cmd_report(args: argparse.Namespace) -> int:
    from bench import report

    rows = []
    for path in args.results:
        rows += report.load_results(Path(path))
    out = Path(args.out)
    report.write_report(rows, out, charts=not args.no_charts)
    print((out / "summary.md").read_text())
    return 0


def add_report(sub) -> None:
    p = sub.add_parser("report", help="Aggregate results.jsonl files → results/ (summary, charts)")
    p.add_argument("results", nargs="+")
    p.add_argument("--out", default="results")
    p.add_argument("--no-charts", action="store_true")
    p.set_defaults(func=cmd_report)


# Each entry adds one subcommand parser; other modules append theirs here.
COMMANDS = [add_harness, add_grade, add_report]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cfo-bench", description="cfo-bench: AI agents doing French small-business bookkeeping with the compta CLI")
    sub = parser.add_subparsers(dest="command", required=True)
    for add in COMMANDS:
        add(sub)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
