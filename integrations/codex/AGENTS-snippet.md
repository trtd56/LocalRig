# Codex integration

Paste the section below into your global `~/.codex/AGENTS.md` (or a project `AGENTS.md`) to let Codex delegate small tasks to LocalRig and report feedback autonomously.

---

## Delegating small tasks to the local LLM (`lh`)

LocalRig is available as the `lh` CLI (Qwen 3.6 27B via Ollama). Its tokens are cheap, but delegation is NOT free to you: it carries a roughly fixed orchestration cost (~$0.11–0.18 of your own tokens for the work order + verification + feedback), and local runs take 1–20 minutes (~3–7x your own wall-clock, up to ~7x on a heavy sweep). So delegate only mechanical, strictly-verifiable work that is big enough to pay for that overhead — multi-file renames/migrations, boilerplate sweeps, a large test file. Measured break-even is ≈ $0.15 of the cost you'd otherwise spend; a task you'd finish in a handful of turns is cheaper to just do yourself. Note that a codifiable sweep is often cheapest to fold with a script you write yourself (realistic delegation savings top out around −30 to −50%, not −80%), so compare against that first.

Rules:

1. Only delegate tasks you can state with exact file paths and a definition of done, and can verify cheaply afterwards. Delegate mechanical multi-file sweeps (renames, API migrations, boilerplate); do NOT delegate design/refactor work requiring taste or project-wide judgement, security-sensitive changes, or small edits below the cost floor (a one-line doc fix, a couple of type errors).
2. Before delegating a kind of task, skim `lh stats --by-kind` when available. Stop delegating kinds with poor pass rates.
3. Invoke with stdin for the work order, a kind tag, and an acceptance check:
   ```bash
   lh -p - --json --cwd /abs/path/to/project --kind rename --check "bash test/verify.sh" --max-time 1200 <<'EOF'
   <work order with exact file paths and the command that must pass>
   EOF
   ```
   The stdout is one JSON object: `session_id`, `status`, `result`, `check`, `report`, `feedback_command`. If `check.exit_code === 0`, you normally only need to inspect `report.changed_files` plus the diff for unexpected changes. `report.changed_files` covers write/edit tool changes, not files changed through bash. Runs take 1–20 minutes, so set the Bash timeout to at least 900000 ms. For a single task call `lh -p` synchronously — submitting then immediately waiting only adds cost (~+33%) without shortening the block. Use `lh submit ... --json`, do other work, then `lh wait <session_id> --json` (or `lh poll <session_id> --json` for a non-blocking status check) only when you have unrelated work to advance meanwhile.
4. Verify BEFORE recording a verdict: require `status === "ok"` and `check.exit_code === 0`, read `report.changed_files`, and inspect the diff. Re-run the acceptance command yourself only when the check is absent, failed, flaky, or security-sensitive. Do not accept on a semantic "looks right" review — if the task has a strict output-format requirement (an exact first line, a specific filename, an exact string), re-check that literal requirement, or you will record a false `pass`.
5. REQUIRED — record a verdict after verifying:
   ```bash
   lh feedback <session_id> pass|fail --source codex --notes "<what you checked / what went wrong>"
   ```
   `fail` means you had to redo the work; always explain why in `--notes`. Do not retry a failed delegation more than once.
6. If verification finds a narrow, fixable gap, send the correction into the same session with `lh -p "<fix>" --resume <session_id> --json` (one-shot only; issues a new session id, records `resumed_from`, inherits the original `--cwd`) instead of rewriting the work order. Verify and record a fresh feedback verdict on the new session; do not send back more than once.
