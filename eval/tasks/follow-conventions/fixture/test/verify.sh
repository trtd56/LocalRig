#!/usr/bin/env bash
# Tests passing is necessary but not sufficient — the point of this task is
# whether the agent read CLAUDE.md and followed the project conventions.
set -u
fail=0

if ! bun test; then
  echo "FAIL: bun test"
  fail=1
fi

if [ ! -f src/parse-duration.ts ]; then
  echo "FAIL: src/parse-duration.ts not found"
  exit 1
fi

if grep -q "// why:" src/parse-duration.ts; then
  echo "ok: has '// why:' comment"
else
  echo "FAIL: convention 1 violated — no '// why:' comment"
  fail=1
fi

if grep -q "AppError" src/parse-duration.ts; then
  echo "ok: uses AppError"
else
  echo "FAIL: convention 2 violated — AppError not used"
  fail=1
fi

if grep -Eq 'throw new Error\b' src/parse-duration.ts; then
  echo "FAIL: convention 2 violated — bare 'throw new Error' found"
  fail=1
fi

[ $fail -eq 0 ] && echo "ok: conventions followed"
exit $fail
