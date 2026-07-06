#!/usr/bin/env bash
# The task is done when the tests pass, the query language was implemented as
# two new modules (parse + apply), search() is wired to them, and SPEC.md was
# left untouched (verified by comparing its sha256 against the embedded hash).
set -u
fail=0

EXPECTED_SPEC_SHA="f89565105bdce01664c878865deda4f8f831a361814a66f1b625723770d628db"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if ! bun test; then
  echo "FAIL: bun test"
  fail=1
fi

if [ ! -f SPEC.md ]; then
  echo "FAIL: SPEC.md not found"
  fail=1
elif [ "$(sha256_of SPEC.md)" != "$EXPECTED_SPEC_SHA" ]; then
  echo "FAIL: SPEC.md was modified (sha256 mismatch)"
  fail=1
fi

if [ ! -f src/query/parse.ts ]; then
  echo "FAIL: src/query/parse.ts not found"
  fail=1
fi

if [ ! -f src/query/apply.ts ]; then
  echo "FAIL: src/query/apply.ts not found"
  fail=1
fi

if ! grep -q "query/parse" src/search.ts; then
  echo "FAIL: search() does not import src/query/parse.ts"
  fail=1
fi

if ! grep -q "query/apply" src/search.ts; then
  echo "FAIL: search() does not import src/query/apply.ts"
  fail=1
fi

[ $fail -eq 0 ] && echo "ok: spec implemented, SPEC.md intact"
exit $fail
