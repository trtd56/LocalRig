---
name: delegate-local
description: Delegate small, mechanical, verifiable coding tasks to LocalRig via the `lh` CLI to save tokens. Use when a task is well-scoped (single-file fix, boilerplate, rename, small test, doc tweak) and its success is objectively checkable (tests, grep, diff). After every delegation you MUST verify the result yourself and record a verdict with `lh feedback`.
---

# Delegate to a local LLM (`lh`)

`lh` runs LocalRig, a local coding agent (Qwen 3.6 27B via Ollama) that can read/edit/write files and run bash in a target directory. It is slower than you (minutes, not seconds) and weaker on ambiguity, but its tokens are free. Delegating mechanical work to it saves your context budget for the hard parts.

## When to delegate

**First, check the track record.** Before deciding, read `lh stats --by-kind --json` and find the entry for the `--kind` you would tag this task with. If that kind's `gate.status` is `"block"`, do NOT delegate: do the task yourself, or sharpen the work order — concrete file paths, an explicit definition of done, a `--check` command — and only then try again. The current gate blocks when `graded >= 3` and pass `rate < 50`; with fewer than 3 graded runs the signal is too thin to act on, so fall back to the criteria below.

Delegate when ALL of these hold:
- The task is mechanical and well-scoped: single-file bugfix with a failing test, boilerplate generation, rename/move, adding a test that mirrors an existing pattern, doc/comment updates, config tweaks.
- **It clears the cost floor.** Delegation carries a roughly fixed orchestration cost, and most of it is *session startup* (the built-in system-prompt cache), not per-task work: decomposed as **a session-startup cost S (independent of task count) + a per-task cost T** (measured S ≈ $0.10, T ≈ $0.03 under Claude Code 2.1.77 accounting — absolute dollars shift with CLI versions, the structure doesn't). A single delegation costs S+T and only pays when doing the task yourself would cost more — many turns of mechanical editing (multi-file renames/migrations, boilerplate sweeps, a large test file). A task you'd finish in a handful of turns is cheaper to just do yourself. **If you have several independent delegation-worthy tasks, do NOT issue one `lh -p` per task — bundle them into a single `lh batch` call** (see "Batch multiple tasks" below): S is shared and the orchestration turns collapse into one call. Measured same-day (2.1.202, warm cache): hand-rolling N sequential `lh -p` calls cost ≈ $0.60 and *lost* to the do-it-yourself baseline ($0.446), while one `lh batch` call cost ≈ $0.39–0.42 and stayed profitable (−6 to −13% vs baseline, ≈ −30% vs hand-rolled). A task that loses money delegated alone can turn a profit inside a batch.
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

## Batch multiple tasks — `lh batch`

When you have two or more INDEPENDENT delegation-worthy tasks, bundle them into ONE call instead of issuing `lh -p` per task:

```bash
lh batch --tasks - --json --cwd /abs/path/to/project --max-time 1800 <<'EOF'
{"tasks":[
  {"id":"docs-sync","kind":"docs","check":"cd docs && bun test","prompt":"Sync docs/README.md with docs/src/cli.ts. Do not touch src/ or test/."},
  {"id":"typefix","kind":"types","check":"cd typefix && bunx tsc --noEmit","prompt":"Fix the type errors in typefix/ without any/as/ts-ignore."}
]}
EOF
```

- Every task MUST carry a unique `id`, a `kind`, and a machine-verifiable `check` scoped to that task alone. Keep each `prompt` a short ticket (target file paths, expected behavior, the command that must pass) — do not paste file contents or spell out the fix; the local agent explores and the `check` is the gate.
- Each task runs with a fresh context and its own check+repair loop; a failing task does not stop the remaining independent tasks. After all tasks finish, every passed check is re-run once (re-verification sweep) to catch a later task's bash side effects rolling back an earlier task's work.
- `--max-time` is the TOTAL wall-clock budget for the whole batch (tasks that don't start in time report `not_run`). Use a Bash timeout that covers the whole batch (≥ 2100000 ms for ~3 tasks; the local model takes 1–20 min per task, run serially).
- The JSON reply has a per-task `tasks[]` array (each with `status`, `check.exit_code`, `report.changed_files`). Verify and record feedback per task: `lh feedback <session_id> --task <id> pass|fail --notes "..."` (omitting `--task` fans the verdict out to every task).
- Progress persists incrementally: if your session dies mid-batch or right after it, completed tasks' work and check results survive — read the session JSON (`lh sessions`, `lh poll <id> --json`) and record feedback afterwards instead of redoing the work.
- Do not hand-assemble one mega-prompt telling a single local agent to do everything, and do not call `lh -p` once per subtask — measured same-day, the hand-rolled sequential pattern cost ≈ 1.4× the batch call and lost to just doing the tasks yourself.

## Preprocess large inputs — `lh distill`

Use `lh distill` when you are about to read or paste at least 1000 lines or 64KB of logs/files and the job is semantic selection, not editing. It asks the local model to read the large input and return a small citation-checked digest:

```bash
bun test 2>&1 | lh distill -q "What is the root cause of the failing tests?" --json
lh distill -q "Where is retry behavior implemented?" src/**/*.ts --json
```

- `-q/--query` is required. Do not ask for generic summaries; state the extraction question.
- Use it for large test/build logs, trace triage, or finding relevant passages across many files. If `grep`, `jq`, `head`, or a small script can select the information mechanically, use that instead.
- Before using it, read `lh stats --by-kind --json`; if the `distill` entry has `gate.status:"block"`, do not use distill for this task.
- The digest is a map, not ground truth. Before editing or relying on a claim, read the cited file range yourself.
- Citations are mechanically checked: a hallucinated quote is dropped and counted in `citations_dropped`. Treat a high drop count as a warning that recall may be poor.
- Respect `not_found: true`; do not turn it into a fabricated answer.
- Record usefulness with `lh feedback <session_id> pass|fail --source claude-code --notes "..."`. `kind` defaults to `distill`, so `lh stats --by-kind` can gate future use.

## Scout a repository — `lh scout`

Use `lh scout` when you need read-only codebase exploration and you do not yet know which files to read. It gives the local model only `read`, `grep`, and `glob`, then returns the same citation-checked digest shape as `distill`:

```bash
lh scout -q "Where is retry behavior defined, registered, and called?" --paths src --json
```

Use the three-way rule: `grep`/scripts for mechanical filtering, `distill` when the input files are already known, `scout` when finding the relevant files is the task. The P2 trigger for scout is a repository question where you expect to inspect five or more files yourself. Before using it, read `lh stats --by-kind --json`; if the `scout` entry has `gate.status:"block"`, do not use scout for this task. Treat scout output as a map: read cited ranges before relying on them, respect `not_found: true`, and record usefulness with `lh feedback <session_id> pass|fail --source claude-code --notes "..."`. `kind` defaults to `scout`.

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

`lh stats --by-kind` shows pass rate, average duration, and gate status by task kind (add `--json` for machine-readable `rate` and `gate.status` per kind — the same track record you consult before delegating or preprocessing, see "When to delegate"). Check it after runs too, to catch a kind whose reliability is slipping and stop delegating it. `lh sessions` lists recent runs when you lost a session id.
