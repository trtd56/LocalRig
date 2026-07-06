# Codex integration

Paste the section below into your global `~/.codex/AGENTS.md` (or a project `AGENTS.md`) to let Codex delegate small tasks to LocalRig and report feedback autonomously.

---

## Delegating small tasks to the local LLM (`lh`)

LocalRig is available as the `lh` CLI (Qwen 3.6 27B via Ollama). Its tokens are cheap, but delegation is NOT free to you: it carries a roughly fixed orchestration cost (~$0.11–0.18 of your own tokens for the work order + verification + feedback), and local runs take 1–20 minutes (~3–7x your own wall-clock, up to ~7x on a heavy sweep). So delegate only mechanical, strictly-verifiable work that is big enough to pay for that overhead — multi-file renames/migrations, boilerplate sweeps, a large test file. Single-shot break-even is ≈ $0.15 of the cost you'd otherwise spend; a task you'd finish in a handful of turns is cheaper to just do yourself. Most of the fixed cost is session startup (≈ $0.10), not per-task (≈ $0.03), so if you have several independent delegation-worthy tasks, delegate them back-to-back in one session: the startup cost amortizes and per-task cost drops to ≈ $0.06–0.08 (measured), turning small tasks that lose money alone into a net win. Note also that a codifiable sweep is often cheapest to fold with a script you write yourself (realistic delegation savings top out around −30 to −50%, not −80%), so compare against that first.

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
4. Verify BEFORE recording a verdict: require `status === "ok"` and `check.exit_code === 0`, read `report.changed_files`, and inspect the diff. Re-run the acceptance command yourself only when the check is absent, failed, flaky, or security-sensitive. Do not accept on a semantic "looks right" review — if the task has a strict output-format requirement (an exact first line, a specific filename, an exact string), re-check that literal requirement, or you will record a false `pass`.
5. REQUIRED — record a verdict after verifying:
   ```bash
   lh feedback <session_id> pass|fail --source codex --notes "<what you checked / what went wrong>"
   ```
   `fail` means you had to redo the work; always explain why in `--notes`. Do not retry a failed delegation more than once.
6. If verification finds a narrow, fixable gap, send the correction into the same session with `lh -p "<fix>" --resume <session_id> --json` (one-shot only; issues a new session id, records `resumed_from`, inherits the original `--cwd`) instead of rewriting the work order. Verify and record a fresh feedback verdict on the new session; do not send back more than once.
