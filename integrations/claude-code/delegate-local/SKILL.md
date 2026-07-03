---
name: delegate-local
description: Delegate small, mechanical, verifiable coding tasks to a local LLM via the `lh` CLI to save tokens. Use when a task is well-scoped (single-file fix, boilerplate, rename, small test, doc tweak) and its success is objectively checkable (tests, grep, diff). After every delegation you MUST verify the result yourself and record a verdict with `lh feedback`.
---

# Delegate to a local LLM (`lh`)

`lh` runs a local coding agent (Qwen 3.6 27B via Ollama) that can read/edit/write files and run bash in a target directory. It is slower than you (minutes, not seconds) and weaker on ambiguity, but its tokens are free. Delegating mechanical work to it saves your context budget for the hard parts.

## When to delegate

Delegate when ALL of these hold:
- The task is mechanical and well-scoped: single-file bugfix with a failing test, boilerplate generation, rename/move, adding a test that mirrors an existing pattern, doc/comment updates, config tweaks.
- You can state the task with concrete file paths and an explicit definition of done.
- Success is objectively verifiable afterwards (a test command, a grep, a small diff you can read).

Do NOT delegate: multi-file design work, anything requiring project-wide context or taste, security-sensitive changes, tasks you cannot verify cheaply, or anything urgent (local runs take 1–15 minutes).

## How to call

```bash
lh -p "<task>" --json --cwd /abs/path/to/project
```

- Write the prompt like a work order for a junior engineer: exact file paths, expected behavior, and the command that must pass when done. One task per call.
- `--json` prints a single JSON object on stdout: `session_id`, `status` (`ok` | `max_iterations` | `loop_abort` | ...), `result`, `duration_ms`, `tokens`, and a ready-made `feedback_command`.
- Use a Bash timeout of at least 600000 ms; for bigger tasks use `run_in_background` and collect the output later.
- Add `--auto` to make the local agent refuse dangerous bash commands instead of running them (recommended when delegating into repos with scripts you haven't read).
- Exit code 0 means the agent believes it finished; non-zero means it stopped early — treat the work as incomplete.

## Verify — never trust the result blindly

Before using or committing anything the local agent produced:
1. `git diff` (or read the touched files) in the target repo.
2. Run the verification command you stated in the prompt (tests, typecheck, grep).

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

`lh stats` shows the historical pass rate and recent failure notes. If the pass rate for a kind of task is poor, stop delegating that kind. `lh sessions` lists recent runs when you lost a session id.
