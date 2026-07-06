#!/usr/bin/env bash
# Migration is done when tests pass, the legacy module is gone, and nothing
# in src/ references it anymore.
set -u
fail=0

if ! bun test; then
  echo "FAIL: bun test"
  fail=1
fi

if [ -f src/lib/legacy-format.ts ]; then
  echo "FAIL: src/lib/legacy-format.ts still exists"
  fail=1
fi

if grep -rq "legacy-format" src 2>/dev/null; then
  echo "FAIL: legacy-format still referenced in src/"
  fail=1
fi

[ $fail -eq 0 ] && echo "ok: migration complete"
exit $fail
