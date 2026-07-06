#!/usr/bin/env bash
# The task is done when `bunx tsc --noEmit` reports no type errors, `bun test`
# still passes (behaviour unchanged), no escape-hatch was used to silence the
# type checker (no any / as-cast / ts-ignore added under src/), and tsconfig.json
# was left untouched (verified by comparing its sha256 against the embedded hash).
set -u
fail=0

EXPECTED_TSCONFIG_SHA="51b5609b2f1a0fbcab19aa52f192f13bcf9f444827b851c81e2c1eeab3be6c2f"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if ! bunx tsc --noEmit; then
  echo "FAIL: bunx tsc --noEmit reported type errors"
  fail=1
fi

if ! bun test; then
  echo "FAIL: bun test"
  fail=1
fi

# Escape hatches that would silence the checker instead of fixing the types.
if grep -REn '@ts-ignore|@ts-expect-error|:[[:space:]]*any\b|as[[:space:]]+any\b|as[[:space:]]+unknown\b|<any>' src; then
  echo "FAIL: forbidden escape hatch (any / as-cast / ts-ignore) found under src/"
  fail=1
fi

if [ ! -f tsconfig.json ]; then
  echo "FAIL: tsconfig.json not found"
  fail=1
elif [ "$(sha256_of tsconfig.json)" != "$EXPECTED_TSCONFIG_SHA" ]; then
  echo "FAIL: tsconfig.json was modified (sha256 mismatch)"
  fail=1
fi

[ $fail -eq 0 ] && echo "ok: types fixed, tests pass, no escape hatches, tsconfig intact"
exit $fail
