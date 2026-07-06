# Codex integration

Paste the section below into your global `~/.codex/AGENTS.md` (or a project `AGENTS.md`) to let Codex delegate small tasks to LocalRig and report feedback autonomously.

---

## Delegating small tasks to the local LLM (`lh`)

LocalRig is available as the `lh` CLI (Qwen 3.6 27B via Ollama). Its tokens are cheap, but delegation is NOT free to you: it carries a roughly fixed orchestration cost (~$0.11–0.15 of your own tokens for the work order + verification + feedback), and local runs take 1–20 minutes (~3–7x your own wall-clock). So delegate only mechanical, strictly-verifiable work that is big enough to pay for that overhead — multi-file renames/migrations, boilerplate sweeps, a large test file. Measured break-even is ≈ $0.15 of the cost you'd otherwise spend; a task you'd finish in a handful of turns is cheaper to just do yourself.

Rules:

1. Only delegate tasks you can state with exact file paths and a definition of done, and can verify cheaply afterwards. Delegate mechanical multi-file sweeps (renames, API migrations, boilerplate); do NOT delegate design/refactor work requiring taste or project-wide judgement, security-sensitive changes, or small edits below the cost floor (a one-line doc fix, a couple of type errors).
2. Invoke as:
   ```bash
   lh -p "<work order with file paths and the command that must pass>" --json --cwd /abs/path/to/project --max-time 1200
   ```
   The stdout is one JSON object: `session_id`, `status`, `result`, `feedback_command`. Runs take 1–20 minutes, so set the Bash timeout to at least 900000 ms (or run it in the background and collect the result later) — a default ~2-minute tool timeout will kill `lh` mid-run. Non-zero exit = incomplete work.
3. Verify BEFORE recording a verdict: read the diff, then run the EXACT acceptance command the task specifies (tests/typecheck/grep). Do not accept on a semantic "looks right" review — if the task has a strict output-format requirement (an exact first line, a specific filename, an exact string), re-check that literal requirement, or you will record a false `pass`.
4. REQUIRED — record a verdict after verifying:
   ```bash
   lh feedback <session_id> pass|fail --source codex --notes "<what you checked / what went wrong>"
   ```
   `fail` means you had to redo the work; always explain why in `--notes`. Do not retry a failed delegation more than once.
5. `lh stats` shows the historical pass rate — stop delegating task types that keep failing.
