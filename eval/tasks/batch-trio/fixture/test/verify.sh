#!/usr/bin/env bash
# batch-trio: three independent sub-projects (docs/, typefix/, perf/) must all
# be solved. This is an AND gate — it exits non-zero if ANY one of them is
# incomplete and names the failing task(s) on stderr as FAIL[<task>]. Each
# sub-project's acceptance mirrors the standalone doc-sync / type-repair /
# perf-fix fixtures, rescoped to its sub-directory (bun test is run per-dir so
# the three suites never interfere).
set -u
fail=0

# Two assets must stay byte-identical: docs/src/cli.ts is the source of truth
# for the README sync, and typefix/tsconfig.json is the type-checker config.
# The runner already sha256-protects every path containing "test"; neither of
# these does, so they are pinned here (recompute if the fixtures ever change).
EXPECTED_CLI_SHA="14351b8e52da35027f7722fc6bf8d0f1bec088ff60c4d4117842969484d70b6b"
EXPECTED_TSCONFIG_SHA="51b5609b2f1a0fbcab19aa52f192f13bcf9f444827b851c81e2c1eeab3be6c2f"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# ----- (1) docs/: README.md synced to docs/src/cli.ts -----------------------
docs_fail=0
# Tests still pass (insurance that docs/src behaviour was not broken).
if ! ( cd docs && bun test ); then
  echo "FAIL[docs]: cd docs && bun test" >&2
  docs_fail=1
fi
# docs/src/cli.ts is the source of truth for the docs; it must be untouched.
if [ ! -f docs/src/cli.ts ]; then
  echo "FAIL[docs]: docs/src/cli.ts not found" >&2
  docs_fail=1
elif [ "$(sha256_of docs/src/cli.ts)" != "$EXPECTED_CLI_SHA" ]; then
  echo "FAIL[docs]: docs/src/cli.ts was modified (sha256 mismatch)" >&2
  docs_fail=1
fi
if [ ! -f docs/README.md ]; then
  echo "FAIL[docs]: docs/README.md not found" >&2
  docs_fail=1
else
  # The flag is --limit; the misspelling --max must be gone.
  if ! grep -q -- '--limit' docs/README.md; then
    echo "FAIL[docs]: README does not document --limit" >&2; docs_fail=1
  fi
  if grep -q -- '--max' docs/README.md; then
    echo "FAIL[docs]: README still mentions the non-existent --max flag" >&2; docs_fail=1
  fi
  # The --sort option (missing from the pristine README) must be documented.
  if ! grep -q -- '--sort' docs/README.md; then
    echo "FAIL[docs]: README does not document the --sort option" >&2; docs_fail=1
  fi
  # The limit default is 25, and the wrong default (10) is no longer stated.
  if ! grep -q -- '25' docs/README.md; then
    echo "FAIL[docs]: README does not state the real --limit default (25)" >&2; docs_fail=1
  fi
  if grep -Eiq 'default.*10|デフォルト.*10' docs/README.md; then
    echo "FAIL[docs]: README still states the wrong --limit default (10)" >&2; docs_fail=1
  fi
  # The format default reads as table, and json is no longer called the default.
  if ! grep -Eiq 'default.*table|デフォルト.*table' docs/README.md; then
    echo "FAIL[docs]: README does not state that the default format is table" >&2; docs_fail=1
  fi
  if grep -Eiq 'default.*json|デフォルト.*json' docs/README.md; then
    echo "FAIL[docs]: README still states that the default format is json" >&2; docs_fail=1
  fi
fi
[ $docs_fail -ne 0 ] && fail=1

# ----- (2) typefix/: tsc clean, tests green, no escape hatches --------------
typefix_fail=0
if ! ( cd typefix && bunx tsc --noEmit ); then
  echo "FAIL[typefix]: cd typefix && bunx tsc --noEmit reported type errors" >&2
  typefix_fail=1
fi
if ! ( cd typefix && bun test ); then
  echo "FAIL[typefix]: cd typefix && bun test" >&2
  typefix_fail=1
fi
# Escape hatches that would silence the checker instead of fixing the types.
if grep -REn '@ts-ignore|@ts-expect-error|:[[:space:]]*any\b|as[[:space:]]+any\b|as[[:space:]]+unknown\b|<any>' typefix/src; then
  echo "FAIL[typefix]: forbidden escape hatch (any / as-cast / ts-ignore) found under typefix/src" >&2
  typefix_fail=1
fi
if [ ! -f typefix/tsconfig.json ]; then
  echo "FAIL[typefix]: typefix/tsconfig.json not found" >&2
  typefix_fail=1
elif [ "$(sha256_of typefix/tsconfig.json)" != "$EXPECTED_TSCONFIG_SHA" ]; then
  echo "FAIL[typefix]: typefix/tsconfig.json was modified (sha256 mismatch)" >&2
  typefix_fail=1
fi
[ $typefix_fail -ne 0 ] && fail=1

# ----- (3) perf/: large-input findDuplicates within the time budget ---------
perf_fail=0
if ! ( cd perf && bun test ); then
  echo "FAIL[perf]: cd perf && bun test (large-input time budget or correctness)" >&2
  perf_fail=1
fi
[ $perf_fail -ne 0 ] && fail=1

if [ $fail -eq 0 ]; then
  echo "ok: docs synced, types fixed, perf within budget — all three tasks pass"
fi
exit $fail
