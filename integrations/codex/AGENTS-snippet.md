# Codex integration

Paste the section below into your global `~/.codex/AGENTS.md` (or a project `AGENTS.md`) to let Codex delegate small tasks to LocalRig and report feedback autonomously.

---

## Delegating small tasks to the local LLM (`lh`)

LocalRig is available as the `lh` CLI (Qwen 3.6 27B via Ollama). Its tokens are cheap, but delegation is NOT free to you: it carries a roughly fixed orchestration cost in your own tokens (work order + verification + feedback; absolute dollars depend on your CLI version's accounting), and local runs take 1–20 minutes (~3–7x your own wall-clock, up to ~7x on a heavy sweep). So delegate only mechanical, strictly-verifiable work that is big enough to pay for that overhead — multi-file renames/migrations, boilerplate sweeps, a large test file; a task you'd finish in a handful of turns is cheaper to just do yourself. Most of the fixed cost is session startup, not per-task, so if you have several independent delegation-worthy tasks, bundle them into ONE `lh batch` call (Rule 3b): the startup cost amortizes and the orchestration turns collapse. Measured same-day: hand-rolling one `lh -p` per task cost ≈ 1.4× the single `lh batch` call and lost to just doing the tasks yourself. Note also that a codifiable sweep is often cheapest to fold with a script you write yourself (realistic delegation savings top out around −30 to −50%, not −80%), so compare against that first.

Rules:

1. Only delegate tasks you can state with exact file paths and a definition of done, and can verify cheaply afterwards. Delegate mechanical multi-file sweeps (renames, API migrations, boilerplate); do NOT delegate design/refactor work requiring taste or project-wide judgement, security-sensitive changes, or small edits below the cost floor (a one-line doc fix, a couple of type errors).
2. Before delegating a kind of task, check `lh stats --by-kind --json` when available: find the entry for the `--kind` you would use, and if it has `graded >= 3` and its pass `rate` is below 50 (fail is the majority), do NOT delegate that kind — do it yourself or sharpen the work order first. Below 3 graded runs the signal is too thin to act on.
3. Invoke with stdin for the work order, a kind tag, and an acceptance check:
   ```bash
   lh -p - --json --cwd /abs/path/to/project --kind rename --check "bash test/verify.sh" --max-time 1200 <<'EOF'
   <work order with exact file paths and the command that must pass>
   EOF
   ```
   The stdout is one JSON object: `session_id`, `status`, `result`, `check`, `report`, `feedback_command`. If `check.exit_code === 0`, you normally only need to inspect `report.changed_files` plus the diff for unexpected changes. `report.changed_files` covers write/edit tool changes, not files changed through bash. Runs take 1–20 minutes, so set the Bash timeout to at least 900000 ms. Call `lh -p` synchronously; do NOT use `submit`/`wait` in a headless delegation flow — it was measured not to shorten wall-clock (a single task just costs ~+33% more in turns, and even when delegating a big task A while you do a small task B yourself, B finishes long before A and you block on `lh wait` for A's remainder anyway). `submit`/`wait`/`poll` is worth it only in an interactive session where a human advances unrelated work meanwhile.

   3b. Two or more independent delegation-worthy tasks → ONE `lh batch` call instead of one `lh -p` each:
   ```bash
   lh batch --tasks - --json --cwd /abs/path/to/project --max-time 1800 <<'EOF'
   {"tasks":[{"id":"<slug>","kind":"<kind>","check":"<per-task acceptance command>","prompt":"<short ticket>"}, ...]}
   EOF
   ```
   Every task needs a unique `id`, a `kind`, and a `check` scoped to that task alone; keep each `prompt` a short ticket (paths + expected behavior + the command that must pass). Each task gets a fresh context and its own check+repair loop; failures don't stop the remaining tasks, and passed checks are re-run once at the end to catch cross-task rollbacks. `--max-time` is the budget for the WHOLE batch; set the Bash timeout to cover it (≥ 2100000 ms for ~3 tasks). The reply's `tasks[]` carries per-task `status`/`check`/`report`; verify and record feedback per task with `lh feedback <session_id> --task <id> pass|fail`. Progress persists per task, so if your session dies mid-batch, read the session JSON (`lh sessions`, `lh poll <id> --json`) and grade afterwards instead of redoing the work.
4. Verify BEFORE recording a verdict: require `status === "ok"` and `check.exit_code === 0`, read `report.changed_files`, and inspect the diff. Re-run the acceptance command yourself only when the check is absent, failed, flaky, or security-sensitive. Do not accept on a semantic "looks right" review — if the task has a strict output-format requirement (an exact first line, a specific filename, an exact string), re-check that literal requirement, or you will record a false `pass`.
5. REQUIRED — record a verdict after verifying:
   ```bash
   lh feedback <session_id> pass|fail --source codex --notes "<what you checked / what went wrong>"
   ```
   `fail` means you had to redo the work; always explain why in `--notes`. Do not retry a failed delegation more than once.
6. If verification finds a narrow, fixable gap, send the correction into the same session with `lh -p "<fix>" --resume <session_id> --json` (one-shot only; issues a new session id, records `resumed_from`, inherits the original `--cwd`) instead of rewriting the work order. Verify and record a fresh feedback verdict on the new session; do not send back more than once.
