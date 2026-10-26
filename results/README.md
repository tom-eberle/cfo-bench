# Results: pre-release version (v0)

These results were measured on 2026-10-20 and 2026-10-21 with the **pre-release version** of
the benchmark. A rerun on this code is planned. It will replace every file here.

## What is here

| File | What |
|---|---|
| `summary.md`, `summary.csv` | per-agent tables: success, safety, costs |
| `results.jsonl` | one row per attempt: 540 scored runs (36 tasks × 3 repeats × 5 agents) and 86 replaced attempts |
| `*.png`, `*.svg` | the four charts |
| `notes.md` | main failure patterns and the history of grader fixes |

Each row has `version: "pre-release (v0)"` and `run_date`. Local paths were removed
(`record_dir`, `linked_files`). Replaced attempts (`status: "replaced"`) were redone after a
usage limit or an infrastructure error. They count for cost and are kept for audit, not scored.

## How the pre-release version differs

- **Same:** the 36 tasks and their grading rules, the synthetic company and its documents (one
  exception: the planted instruction inside `mailbox/GitHub_receipt_2026-09-06.pdf` now names the
  new tool in its export command), the two-turn protocol, the sandbox rules, the agent versions (Claude Code 2.1.303, Codex CLI
  0.163.0) and their limits.
- **Different raw API.** The fake server spoke an older API with a different data model. Agents
  saw it only through the CLI's raw mode or direct HTTP calls.
- **Different tool name.** The CLI and its skill had another name. Help, skill and error texts
  named the old platform, and the skill's login advice was a browser session, not a token. A
  few output values differed: links, file paths, version strings, one export column name, one
  ledger account keyword.
- **14 prompt lines worded differently.** They named the old platform. Now they say « dans la
  compta » or "in our books". Four of them also changed a few words ("booked in" → "recorded in",
  "Book it" → "Record it", « id … » → « id de l'opération dans la compta », « Mets tout à jour
  dans … » → « Mets-la à jour »). Task ids, answer formats and graders did not change.

## Equivalence checks

- **Grades:** all 734 recorded runs (the 626 attempts here and 108 scripted baseline runs) were
  converted to this version's data shapes and regraded with this code. All 734 grades are
  identical. The rows here come from that regrade and equal the original grades field by
  field (the commands quoted in 10 rows use the new tool name). The tables match the original ones (`summary.csv` byte-identical).
- **CLI data outputs:** the golden command set (every read-only and dry-run command, on the full
  company and a small fixture) gives identical data on both versions once the documented
  differences above (tool name, links, paths, version strings) are normalized: 0 data
  differences, 177/177 exit codes equal.
- **Scripted baselines:** the oracle, null and reckless agents (36 tasks each) give identical
  results on both versions, on every graded field but one: the reckless agent makes fewer
  unapproved writes (2,021 instead of 2,345), because the new API records a VAT exemption in
  one update instead of two.

## Not published

Raw transcripts and run records are not published. They contain the pre-release API.
