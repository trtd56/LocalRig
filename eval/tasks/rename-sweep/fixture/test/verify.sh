#!/usr/bin/env bash
# The sweep is done when every caller was moved off the deprecated
# src/lib/fmt.ts onto src/lib/format.ts: tests pass, the old module is gone, no
# old imports or call sites linger, all 12 caller files reference lib/format,
# and the new module was left untouched (sha256) so the migration can't be
# faked by rewriting the new API to match sloppy call sites.
set -u
fail=0

EXPECTED_FORMAT_SHA="5b37c433c1ce251e8a3e8e753542a64c3d51815fa54738467cc5e5b287edaeb7"

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

if [ -f src/lib/fmt.ts ]; then
  echo "FAIL: src/lib/fmt.ts still exists (delete it after migrating)"
  fail=1
fi

if grep -rq "lib/fmt" src 2>/dev/null; then
  echo "FAIL: 'lib/fmt' is still imported somewhere in src/"
  fail=1
fi

if grep -rq "fmtDate(" src 2>/dev/null; then
  echo "FAIL: fmtDate( call sites remain in src/"
  fail=1
fi

if grep -rq "fmtNum(" src 2>/dev/null; then
  echo "FAIL: fmtNum( call sites remain in src/"
  fail=1
fi

CALLERS="
src/reports/weekly-summary.ts
src/reports/revenue-report.ts
src/reports/audit-log.ts
src/handlers/invoice.ts
src/handlers/order-confirmation.ts
src/handlers/shipment.ts
src/jobs/daily-digest.ts
src/jobs/cleanup.ts
src/jobs/metrics-export.ts
src/views/dashboard.ts
src/views/profile.ts
src/views/timeline.ts
"
for f in $CALLERS; do
  if [ ! -f "$f" ]; then
    echo "FAIL: caller file missing: $f"
    fail=1
  elif ! grep -q "lib/format" "$f"; then
    echo "FAIL: $f does not reference lib/format"
    fail=1
  fi
done

if [ ! -f src/lib/format.ts ]; then
  echo "FAIL: src/lib/format.ts not found"
  fail=1
elif [ "$(sha256_of src/lib/format.ts)" != "$EXPECTED_FORMAT_SHA" ]; then
  echo "FAIL: src/lib/format.ts was modified (sha256 mismatch)"
  fail=1
fi

[ $fail -eq 0 ] && echo "ok: rename sweep complete"
exit $fail
