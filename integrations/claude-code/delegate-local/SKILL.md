---
name: delegate-local
description: Delegate small, mechanical, verifiable coding tasks to LocalRig via the `lh` CLI to save tokens. Use when a task is well-scoped (single-file fix, boilerplate, rename, small test, doc tweak) and its success is objectively checkable (tests, grep, diff). After every delegation you MUST verify the result yourself and record a verdict with `lh feedback`.
---

# Delegate to a local LLM (`lh`)

`lh` runs LocalRig, a local coding agent (Qwen 3.6 27B via Ollama) that can read/edit/write files and run bash in a target directory. It is slower than you (minutes, not seconds) and weaker on ambiguity, but its tokens are free. Delegating mechanical work to it saves your context budget for the hard parts.

## When to delegate

**First, check the track record.** Before deciding, read `lh stats --by-kind --json` and find the entry for the `--kind` you would tag this task with. If that kind has `graded >= 3` and its pass `rate` is below 50 (fail is the majority), do NOT delegate: do the task yourself, or sharpen the work order — concrete file paths, an explicit definition of done, a `--check` command — and only then try again. With fewer than 3 graded runs the signal is too thin to act on; fall back to the criteria below.

Delegate when ALL of these hold:
- The task is mechanical and well-scoped: single-file bugfix with a failing test, boilerplate generation, rename/move, adding a test that mirrors an existing pattern, doc/comment updates, config tweaks.
- **It clears the cost floor.** Delegation carries a roughly fixed orchestration cost, and most of it is *session startup* (the built-in system-prompt cache), not per-task work: measured as **≈ $0.10 to start a session (S) + ≈ $0.03 per task (T)**. So a single delegation costs ≈ $0.11–0.18 (S+T) and only pays when doing the task yourself would cost more — many turns of mechanical editing (multi-file renames/migrations, boilerplate sweeps, a large test file). Single-shot break-even is ≈ $0.15 of baseline cost; a task you'd finish in a handful of turns is cheaper to just do yourself. **But if you have several independent delegation-worthy tasks, batch them into one session** — delegate them back-to-back before you move on — so the startup cost S is shared: per-task cost then drops to ≈ $0.06–0.08 (measured $0.064 for three tasks in one session, −52% vs a single-shot delegation). A task that loses money delegated alone can turn a profit inside a batch.
- You can state the task with concrete file paths and an explicit definition of done.
- Success is objectively verifiable afterwards (a test command, a grep, a small diff you can read).

Do NOT delegate: multi-file design work, anything requiring project-wide context or taste, security-sensitive changes, tasks you cannot verify cheaply, small quick edits below the cost floor (a one-line doc fix, a couple of type errors — you'll spend more orchestrating than doing it), or anything urgent (local runs take 1–15 minutes, roughly 3–7x your own wall-clock — a heavy sweep has been measured at ~7x).

**Before delegating a mechanical sweep, ask whether a script beats it.** If the rule is codifiable and the correct values are machine-extractable (from comments, a manifest, config), you can usually fold the whole sweep with one script you write yourself, far below the cost floor — a 40-file / 46-site change stayed at $0.23 baseline that way. "More files" does not mean "more expensive" or "bigger delegation win": realistic delegation savings top out around −30 to −50%, not −80%. Delegate the sweep only when the per-file edits need judgement a script can't capture.

**These numbers are model-specific.** The cost-floor figures above and the task-selection criteria were calibrated against LocalRig running Qwen 3.6 27B's measured quality and speed. After swapping the local model, rerun the eval delegate arm (see `eval/README.md`) and re-derive the break-even and criteria before trusting them.

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
- Use a Bash timeout of at least 900000 ms (a heavy run plus `--check` retries has been measured near 10 minutes). **Call `lh -p` synchronously — do not use `submit`/`wait` in a headless (`-p`) delegation flow.** It was measured not to shorten wall-clock: for a single task it just adds turns (+33% cost, same effective block), and even in the intended "delegate a big task A, do a small task B meanwhile" case, A dwarfs B, so you finish B and then block on `lh wait` for A's remainder anyway — no net saving (round 5, async-pair). `submit`/`wait`/`poll` earns its keep only in an interactive session where a human advances genuinely unrelated work while the local run proceeds; 27B inference is effectively serial on one Ollama host regardless.
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

## Send it back — targeted follow-up with `--resume`

When your verification finds a narrow, fixable gap (a broken output-format rule, one missed file — not a fundamental miss), correct it inside the *same* session instead of rewriting the whole work order:

```bash
lh -p "The first line must be exactly `FIXED:`. Fix only that." --resume <session_id> --json
```

`--resume` replays the original transcript, appends your instruction as the next turn, and issues a **new** `session_id` (the JSON and session record carry `resumed_from`). It inherits the original `--cwd` unless you override it. One-shot only — not available in the REPL or `lh submit`; an unknown id returns `error_kind: "config"`. This is the standard way to act on a `feedback fail` when the fix is narrow: it saves rebuilding the full prompt for a re-delegation. Still verify and record a fresh `feedback` verdict on the new session, and don't send back more than once for the same task.

## Calibrate

`lh stats --by-kind` shows pass rate and average duration by task kind (add `--json` for a machine-readable `rate` per kind — the same track record you consult before delegating, see "When to delegate"). Check it after runs too, to catch a kind whose reliability is slipping and stop delegating it. `lh sessions` lists recent runs when you lost a session id.
