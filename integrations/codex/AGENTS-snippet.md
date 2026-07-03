# Codex integration

Paste the section below into your global `~/.codex/AGENTS.md` (or a project `AGENTS.md`) to let Codex delegate small tasks to LocalRig and report feedback autonomously.

---

## Delegating small tasks to the local LLM (`lh`)

LocalRig is available as the `lh` CLI (Qwen 3.6 27B via Ollama). Its tokens are free; use it for mechanical, verifiable tasks to conserve your own context: single-file bugfixes with a failing test, boilerplate, renames, tests that mirror an existing pattern, doc updates.

Rules:

1. Only delegate tasks you can state with exact file paths and a definition of done, and can verify cheaply afterwards. Never delegate design work, multi-file refactors, or security-sensitive changes.
2. Invoke as:
   ```bash
   lh -p "<work order with file paths and the command that must pass>" --json --cwd /abs/path/to/project
   ```
   The stdout is one JSON object: `session_id`, `status`, `result`, `feedback_command`. Runs take 1–15 minutes; allow a generous timeout. Non-zero exit = incomplete work.
3. Verify the result yourself: read the diff, run the verification command you specified.
4. REQUIRED — record a verdict after verifying:
   ```bash
   lh feedback <session_id> pass|fail --source codex --notes "<what you checked / what went wrong>"
   ```
   `fail` means you had to redo the work; always explain why in `--notes`. Do not retry a failed delegation more than once.
5. `lh stats` shows the historical pass rate — stop delegating task types that keep failing.
