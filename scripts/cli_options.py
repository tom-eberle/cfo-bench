"""Write bench/graders/cli_options.json: which `compta` options take a value, per command.

The graders read it to tell an option's value from a flag (`compta ops set 1 --memo --dry-run`:
`--dry-run` is the memo, the command runs). Derived from the CLI's own command table
(`compta commands --json`), so it follows the CLI. Rerun after changing CLI options:

    (cd cli && npm run build) && uv run python scripts/cli_options.py

`--check` compares instead of writing (exit 1 when the saved table is out of date).
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "bench" / "graders" / "cli_options.json"


def commands_json() -> dict:
    out = subprocess.run(
        ["node", str(ROOT / "cli" / "dist" / "cli.js"), "commands", "--json"],
        check=True, capture_output=True, text=True, env={"PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", "HOME": "/nonexistent"},
    ).stdout  # fmt: skip
    return json.loads(out)


def table(tree: dict) -> dict:
    """{"commands": {"ops set": {"--memo": "value", "--force": "flag", …}, "": {root options}},
    "aliases": {"-y": "--yes", …}}. A command's own options only; ancestors' apply too (commander
    recognises program options before and after subcommands)."""
    commands: dict[str, dict[str, str]] = {}
    aliases: dict[str, str] = {}

    def walk(c: dict) -> None:
        path = c["path"].split(" ", 1)[1] if " " in c["path"] else ""
        opts: dict[str, str] = {}
        for f in c["flags"]:
            spec = f["flags"]
            kind = "value" if re.search(r"[<\[]", spec) else "flag"
            if "[" in spec:
                kind = "optional"  # takes the next word only if it doesn't start with "-"
            names = re.findall(r"(?<![\w<\[-])(--?[A-Za-z][\w-]*)", re.split(r"[<\[]", spec)[0])
            long = next((n for n in names if n.startswith("--")), names[0])
            for n in names:
                opts[n] = kind
                if n != long:
                    aliases[n] = long
        commands[path] = dict(sorted(opts.items()))
        for s in c.get("subcommands", []):
            walk(s)

    walk(tree)
    return {"source": "compta commands --json", "commands": dict(sorted(commands.items())), "aliases": dict(sorted(aliases.items()))}


def main(argv: list[str]) -> int:
    new = json.dumps(table(commands_json()), indent=1, ensure_ascii=False) + "\n"
    if "--check" in argv:
        if OUT.read_text() != new:
            print(f"{OUT.relative_to(ROOT)} is out of date: rerun scripts/cli_options.py", file=sys.stderr)
            return 1
        return 0
    OUT.write_text(new)
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
