#!/usr/bin/env bash
# Passes once the shared rounding bug is fixed and the whole suite is green.
# Lives under test/ so the eval runner hash-protects it.
set -u

if bun test; then
  echo "ok: all tests pass"
  exit 0
fi

echo "FAIL: bun test"
exit 1
