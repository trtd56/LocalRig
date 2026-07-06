#!/usr/bin/env bash
# Migration is done when tests pass, v1 is gone, nothing in src/ references
# it anymore, and CHANGELOG.md itself hasn't been tampered with.
set -u
fail=0

# CHANGELOG.md is the spec for this migration — reject any tampering with it.
changelog_hash=$(shasum -a 256 CHANGELOG.md | cut -d' ' -f1)
if [ "$changelog_hash" != "8ef1671d09586500e2a46d9762add770277086b71a06cc2fae6bd701ca4e604d" ]; then
  echo "FAIL: CHANGELOG.md was modified"
  exit 1
fi

if ! bun test; then
  echo "FAIL: bun test"
  fail=1
fi

if [ -f src/lib/storage.ts ]; then
  echo "FAIL: src/lib/storage.ts (v1) still exists"
  fail=1
fi

if grep -rE "from ['\"].*lib/storage['\"]" src 2>/dev/null; then
  echo "FAIL: src/ still imports from lib/storage (v1)"
  fail=1
fi

[ $fail -eq 0 ] && echo "ok: migration complete"
exit $fail
