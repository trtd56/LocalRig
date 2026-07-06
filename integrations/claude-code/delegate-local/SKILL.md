---
name: delegate-local
description: Delegate small, mechanical, verifiable coding tasks to LocalRig via the `lh` CLI to save tokens. Use when a task is well-scoped (single-file fix, boilerplate, rename, small test, doc tweak) and its success is objectively checkable (tests, grep, diff). After every delegation you MUST verify the result yourself and record a verdict with `lh feedback`.
---

# Delegate to a local LLM (`lh`)

`lh` runs LocalRig, a local coding agent (Qwen 3.6 27B via Ollama) that can read/edit/write files and run bash in a target directory. It is slower than you (minutes, not seconds) and weaker on ambiguity, but its tokens are free. Delegating mechanical work to it saves your context budget for the hard parts.

## When to delegate

Delegate when ALL of these hold:
- The task is mechanical and well-scoped: single-file bugfix with a failing test, boilerplate generation, rename/move, adding a test that mirrors an existing pattern, doc/comment updates, config tweaks.
- **It clears the cost floor.** Delegation carries a roughly fixed orchestration cost — about $0.11–0.15 of *your own* tokens for writing the work order, verifying, and recording feedback — regardless of how big the task is. So it only pays when doing the task yourself would cost more than that: many turns of mechanical editing (multi-file renames/migrations, boilerplate sweeps, a large test file). Measured break-even is ≈ $0.15 of baseline cost; a task you'd finish in a handful of turns is cheaper to just do yourself.
- You can state the task with concrete file paths and an explicit definition of done.
- Success is objectively verifiable afterwards (a test command, a grep, a small diff you can read).

Do NOT delegate: multi-file design work, anything requiring project-wide context or taste, security-sensitive changes, tasks you cannot verify cheaply, small quick edits below the cost floor (a one-line doc fix, a couple of type errors — you'll spend more orchestrating than doing it), or anything urgent (local runs take 1–15 minutes, roughly 3–7x your own wall-clock).

## How to call

```bash
lh -p - --json --cwd /abs/path/to/project --kind bugfix --check "bun test test/foo.test.ts" <<'EOF'
<task>
EOF
```

- Write the prompt like a work order for a junior engineer: exact file paths, expected behavior, and the command that must pass when done. One task per call.
- Use `-p -` with a heredoc for non-trivial prompts; it avoids shell-quoting accidents in work orders.
- Always add `--kind <kind>` so `lh stats --by-kind` can show which work types are reliable. Recommended kinds: `rename`, `tests`, `docs`, `types`, `perf`, `bugfix`, `other`.
- Add `--check "<acceptance command>"` whenever the task has a commandable definition of done. LocalRig runs it after the agent finishes and feeds failures back to the model for up to `--check-retries` attempts (default 2).
- `--json` prints a single JSON object on stdout: `session_id`, `status` (`ok` | `check_failed` | `max_iterations` | `loop_abort` | ...), `result`, `check`, `report`, `duration_ms`, `tokens`, and a ready-made `feedback_command`.
- `report.changed_files` lists files changed through the write/edit tools, and `report.commands_run` lists bash commands the local agent ran. Bash-side file changes (`rm`, `mv`, generated files) are not tracked there, so still inspect the diff.
- Use a Bash timeout of at least 600000 ms. For bigger tasks prefer `lh submit -p - ... --json`, do other work, then `lh wait <session_id> --json` (or `lh poll <session_id> --json` to check without blocking); local 27B inference is still effectively serial on one Ollama host.
- Add `--auto` to make the local agent refuse dangerous bash commands instead of running them (recommended when delegating into repos with scripts you haven't read).
- Exit code 0 means the agent believes it finished; non-zero means it stopped early — treat the work as incomplete.

## Verify — never trust the result blindly

Before using or committing anything the local agent produced, and **before you record a `pass`**:
1. Require `status === "ok"` and, when `--check` was supplied, `check.exit_code === 0`.
2. Read `report.changed_files` and inspect `git diff` (or read the touched files) in the target repo. Confirm there are no unexpected files.
3. Re-run the exact acceptance command yourself only when `--check` is absent, failed, flaky, or security-sensitive. If the task states a strict output-format requirement (an exact first line, a specific filename, an exact string), re-check that literal requirement, not just the meaning. A shallow semantic review has been observed to accept work that satisfied the intent but violated a format gate, and then record a false `pass`.

## Feedback — REQUIRED after every delegation

Once you have verified (or rejected) the work, record the verdict. This is not optional; the feedback log is what makes delegation quality measurable:

```bash
lh feedback <session_id> pass --source claude-code --notes "tests pass, diff minimal"
lh feedback <session_id> fail --source claude-code --notes "edited wrong file; hallucinated helper API"
```

- `pass` = you accepted the work as-is (or with trivial touch-ups).
- `fail` = you had to redo or substantially fix it. Always include `--notes` explaining the failure mode — notes drive future prompt/harness improvements.
- If the run failed, fix the task yourself afterwards; do not retry delegation more than once for the same task.

## Calibrate

`lh stats --by-kind` shows pass rate and average duration by task kind. If the pass rate for a kind of task is poor, stop delegating that kind. `lh sessions` lists recent runs when you lost a session id.
