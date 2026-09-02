# PROJECT.md — delegation profile for `<PROJECT NAME>`

<!--
  Per-repository overlay for the `delegate-local` skill. SKILL.md reads this
  FIRST and treats it as authoritative for anything it specifies.

  Fill in every section marked TODO. An unfilled template is worse than no
  file: the skill is told to ignore a template that still has TODOs, so it
  falls back to guessing this project's commands.

  Keep it short. This is a lookup table for the orchestrator, not documentation
  for humans.
-->

## Acceptance commands

The `--check` passed to `lh` must be one of these, narrowed to the touched
scope where possible. Prefer an existing project command over inventing one.

| scope | command | typical runtime |
|---|---|---|
| full test suite | `TODO e.g. bun test` | TODO |
| single test file | `TODO e.g. bun test test/<file>.test.ts` | TODO |
| typecheck | `TODO e.g. bunx tsc --noEmit` | TODO |
| lint | `TODO e.g. biome check .` | TODO |
| build | `TODO` | TODO |

If a task has no command in this table that can prove it, it does not clear the
bar for delegation — do it yourself.

## Safe to delegate

TODO — the paths and task kinds that are mechanical and cheaply verifiable here.

| kind | paths | acceptance command |
|---|---|---|
| `rename` | TODO | TODO |
| `tests` | TODO | TODO |
| `docs` | TODO | TODO |
| `types` | TODO | TODO |

## Never delegate here

TODO — list the concrete exclusions for this repo. Typical entries:

- Generated files (TODO paths) — they are rebuilt, edits are lost
- Migrations / schema (TODO paths) — irreversible, needs review
- Anything touching auth, secrets, billing, or PII (TODO paths)
- TODO project-specific traps (vendored code, submodules, codegen inputs)

## Guard rails

Pass these on every `lh` call in this repo so a wrong-scope run cannot damage
anything outside the intended area:

```bash
--allow-path   TODO   # narrow path tools + bash writes to this subtree
--protect-path TODO   # readable but never modifiable
```

## Dimensions

Stable labels so `lh stats` / `lh advise` do not mix this project's track
record with other repos:

```bash
export LH_CALLER=claude-code
export LH_HARDWARE=TODO              # e.g. mac-m3max-64gb
export LH_INTEGRATION_VERSION=delegate-local-TODO
```

## Local track record

Re-read before trusting delegation here, and refresh this block when it drifts:

```bash
lh stats --by-kind --caller claude-code --json
```

- Last reviewed: TODO (date)
- Blocked kinds (`gate.status: "block"`): TODO — do not delegate these
- Notes: TODO

## Project-specific work-order conventions

TODO — anything the local agent gets wrong here unless told. Common entries:

- Write deliverable files to the repository root unless the task names a path
- Follow `CLAUDE.md` / `CONTRIBUTING.md` conventions for TODO
- Do not run TODO (slow, networked, or destructive commands)
