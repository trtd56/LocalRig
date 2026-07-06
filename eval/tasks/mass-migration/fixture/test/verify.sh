#!/usr/bin/env bash
# Migration is complete when every one of the 40 caller files has moved off the
# deprecated src/lib/log.ts (`log.write(level, msg)`) onto src/lib/logger.ts
# (`logger.emit({ level, msg, source })`) with the correct per-module source:
#   - bun test passes (behaviour + the exact source string for all 46 sites)
#   - the old module is deleted and no old import / call site lingers
#   - the new module (logger.ts) and tsconfig.json are untouched (sha256), so
#     the migration cannot be faked by rewriting the API to match sloppy calls.
set -u
fail=0

EXPECTED_LOGGER_SHA="6c099a2c906d44bd523af25e53b1474db3ea871aa413da18d7f1e5c7c0e909a6"
EXPECTED_TSCONFIG_SHA="c63e776df8160b92f1bcbd4946b38954e23ca6b40f2cb6f37456e8a374e9957d"

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

if [ -f src/lib/log.ts ]; then
  echo "FAIL: src/lib/log.ts still exists (delete it after migrating)"
  fail=1
fi

# The closing quote distinguishes the old module ("../lib/log") from the new
# one ("../lib/logger"); a bare 'lib/log' would match both.
if grep -rEq 'lib/log"' src 2>/dev/null; then
  echo "FAIL: old module import ('../lib/log\"') still present in src/"
  fail=1
fi

if grep -rEq 'log\.write\(' src 2>/dev/null; then
  echo "FAIL: log.write( call sites remain in src/"
  fail=1
fi

CALLERS="
src/handlers/invoice.ts
src/handlers/refund.ts
src/handlers/dispute.ts
src/handlers/coupon.ts
src/handlers/order-place.ts
src/handlers/order-cancel.ts
src/handlers/order-modify.ts
src/handlers/shipment.ts
src/jobs/nightly-sweep.ts
src/jobs/digest.ts
src/jobs/retention.ts
src/jobs/reindex.ts
src/jobs/backup.ts
src/jobs/healthcheck.ts
src/reports/revenue.ts
src/reports/funnel.ts
src/reports/cohort.ts
src/reports/churn.ts
src/reports/usage.ts
src/reports/audit.ts
src/views/dashboard.ts
src/views/profile.ts
src/views/settings.ts
src/views/timeline.ts
src/views/inbox.ts
src/views/search.ts
src/services/auth.ts
src/services/session.ts
src/services/cache.ts
src/services/ratelimit.ts
src/services/feature-flag.ts
src/services/config.ts
src/integrations/stripe.ts
src/integrations/sendgrid.ts
src/integrations/slack.ts
src/integrations/s3.ts
src/workers/email-queue.ts
src/workers/webhook-queue.ts
src/workers/export-queue.ts
src/workers/import-queue.ts
"
for f in $CALLERS; do
  if [ ! -f "$f" ]; then
    echo "FAIL: caller file missing: $f"
    fail=1
  elif ! grep -q "lib/logger" "$f"; then
    echo "FAIL: $f does not reference lib/logger"
    fail=1
  fi
done

if [ ! -f src/lib/logger.ts ]; then
  echo "FAIL: src/lib/logger.ts not found"
  fail=1
elif [ "$(sha256_of src/lib/logger.ts)" != "$EXPECTED_LOGGER_SHA" ]; then
  echo "FAIL: src/lib/logger.ts was modified (sha256 mismatch)"
  fail=1
fi

if [ ! -f tsconfig.json ]; then
  echo "FAIL: tsconfig.json not found"
  fail=1
elif [ "$(sha256_of tsconfig.json)" != "$EXPECTED_TSCONFIG_SHA" ]; then
  echo "FAIL: tsconfig.json was modified (sha256 mismatch)"
  fail=1
fi

[ $fail -eq 0 ] && echo "ok: mass migration complete (40 files, 46 sites)"
exit $fail
