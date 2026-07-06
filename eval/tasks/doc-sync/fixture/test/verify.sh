#!/usr/bin/env bash
# The task is done when README.md's Usage/Options match src/cli.ts: the flag is
# --limit (not --max), --sort is documented, and the stated defaults are the
# real ones (limit 25, format table). src/cli.ts must be left untouched
# (verified against the embedded sha256) and the pristine tests must still pass.
set -u
fail=0

EXPECTED_CLI_SHA="14351b8e52da35027f7722fc6bf8d0f1bec088ff60c4d4117842969484d70b6b"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# 0. Tests still pass (extra insurance that src/ behavior was not broken).
if ! bun test; then
  echo "FAIL: bun test"
  fail=1
fi

# 1. src/cli.ts is unchanged (it is the source of truth for the docs).
if [ ! -f src/cli.ts ]; then
  echo "FAIL: src/cli.ts not found"
  fail=1
elif [ "$(sha256_of src/cli.ts)" != "$EXPECTED_CLI_SHA" ]; then
  echo "FAIL: src/cli.ts was modified (sha256 mismatch)"
  fail=1
fi

if [ ! -f README.md ]; then
  echo "FAIL: README.md not found"
  exit 1
fi

# 2. The flag is --limit; the misspelling --max must be gone (Options + example).
if ! grep -q -- '--limit' README.md; then
  echo "FAIL: README.md does not document --limit"
  fail=1
fi
if grep -q -- '--max' README.md; then
  echo "FAIL: README.md still mentions the non-existent --max flag"
  fail=1
fi

# 3. The --sort option (missing from the pristine README) is documented.
if ! grep -q -- '--sort' README.md; then
  echo "FAIL: README.md does not document the --sort option"
  fail=1
fi

# 4. The limit default is 25, and the wrong default (10) is no longer stated.
if ! grep -q -- '25' README.md; then
  echo "FAIL: README.md does not state the real --limit default (25)"
  fail=1
fi
if grep -Eiq 'default.*10|デフォルト.*10' README.md; then
  echo "FAIL: README.md still states the wrong --limit default (10)"
  fail=1
fi

# 5. The format default reads as table, and json is no longer called the default.
if ! grep -Eiq 'default.*table|デフォルト.*table' README.md; then
  echo "FAIL: README.md does not state that the default format is table"
  fail=1
fi
if grep -Eiq 'default.*json|デフォルト.*json' README.md; then
  echo "FAIL: README.md still states that the default format is json"
  fail=1
fi

[ $fail -eq 0 ] && echo "ok: README.md matches src/cli.ts, source intact"
exit $fail
