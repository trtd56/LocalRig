#!/usr/bin/env bash
# Grades ANSWER.md. Lives under test/ so the eval runner hash-protects it.
set -u
fail=0

if [ ! -f ANSWER.md ]; then
  echo "FAIL: ANSWER.md not found"
  exit 1
fi

if grep -Eq '^Q1:.*\b45000\b' ANSWER.md; then
  echo "ok: Q1"
else
  echo "FAIL: Q1 — expected 45000 on the Q1 line"
  fail=1
fi

if grep -Eq '^Q2:.*utils/priority\.ts' ANSWER.md; then
  echo "ok: Q2"
else
  echo "FAIL: Q2 — expected a path containing utils/priority.ts on the Q2 line"
  fail=1
fi

if grep -Eq '^Q3:.*\b2\b' ANSWER.md; then
  echo "ok: Q3"
else
  echo "FAIL: Q3 — expected 2 on the Q3 line"
  fail=1
fi

exit $fail
