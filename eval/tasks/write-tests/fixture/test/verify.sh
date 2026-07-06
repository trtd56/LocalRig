#!/usr/bin/env bash
# The task is done when the agent has written test/slug.test.ts, src/slug.ts is
# left untouched (verified via an embedded sha256 — src/ is not protected by the
# eval runner, so it is guarded here), the tests pass against the correct
# implementation, and the test suite is strong enough that swapping in any of the
# four mutants under test/mutants/ makes `bun test` fail (each mutant survives ==
# the tests are too weak, so we FAIL). src/slug.ts is backed up and restored
# around each mutation so the workdir is left as the agent produced it.
set -u
fail=0

EXPECTED_SLUG_SHA="f4af3a4aa9b74c53fda7cd035994f11f486fc6088538d12959f9b1d26389fd22"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# 1. The agent must have created the test file.
if [ ! -f test/slug.test.ts ]; then
  echo "FAIL: test/slug.test.ts not found"
  fail=1
fi

# 2. src/slug.ts must be exactly the fixture's implementation.
if [ ! -f src/slug.ts ]; then
  echo "FAIL: src/slug.ts not found"
  fail=1
elif [ "$(sha256_of src/slug.ts)" != "$EXPECTED_SLUG_SHA" ]; then
  echo "FAIL: src/slug.ts was modified (sha256 mismatch)"
  fail=1
fi

# 3. Tests must pass against the correct implementation.
if ! bun test; then
  echo "FAIL: bun test does not pass against the correct implementation"
  fail=1
fi

# 4. Mutation testing: each mutant must be killed (bun test must fail).
backup="$(mktemp)"
cp src/slug.ts "$backup"
restore() { cp "$backup" src/slug.ts; }
trap 'restore; rm -f "$backup"' EXIT

for m in 1 2 3 4; do
  mutant="test/mutants/slug.m${m}.ts"
  if [ ! -f "$mutant" ]; then
    echo "FAIL: mutant $mutant missing"
    fail=1
    continue
  fi
  cp "$mutant" src/slug.ts
  if bun test >/dev/null 2>&1; then
    echo "FAIL: mutant $m survived (bun test passed with the mutated src/slug.ts)"
    fail=1
  fi
  restore
done

[ $fail -eq 0 ] && echo "ok: test/slug.test.ts kills all 4 mutants, src/slug.ts intact"
exit $fail
