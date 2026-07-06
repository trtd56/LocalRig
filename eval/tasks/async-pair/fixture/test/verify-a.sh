#!/usr/bin/env bash
# Part A only: the price-utility migration is done when every caller was moved
# off the deprecated src/lib/money.ts onto src/lib/pricing.ts — tests pass, the
# old module is gone, no old imports or call sites linger, all 10 caller files
# reference lib/pricing, and the new module was left untouched (sha256) so the
# migration can't be faked by rewriting the new API to match sloppy call sites.
# This is the exact acceptance command a delegated Part A worker should pass; the
# full-task verifier (verify.sh) runs this AND the Part B checks.
set -u
fail=0

EXPECTED_PRICING_SHA="321fbb384f2c31da816d9dd0d9665cd594a5a58c2ca35635eb6ea935b9d87886"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if ! bun test; then
  echo "FAIL[A]: bun test"
  fail=1
fi

if [ -f src/lib/money.ts ]; then
  echo "FAIL[A]: src/lib/money.ts still exists (delete it after migrating)"
  fail=1
fi

if grep -rq "lib/money" src 2>/dev/null; then
  echo "FAIL[A]: 'lib/money' is still imported somewhere in src/"
  fail=1
fi

if grep -rq "fmtMoney(" src 2>/dev/null; then
  echo "FAIL[A]: fmtMoney( call sites remain in src/"
  fail=1
fi

if grep -rq "discountCents(" src 2>/dev/null; then
  echo "FAIL[A]: discountCents( call sites remain in src/"
  fail=1
fi

CALLERS="
src/checkout/cart.ts
src/checkout/receipt.ts
src/checkout/summary.ts
src/catalog/product-card.ts
src/catalog/price-tag.ts
src/catalog/sale-badge.ts
src/reports/daily-sales.ts
src/reports/refund-log.ts
src/notifications/order-email.ts
src/notifications/price-alert.ts
"
for f in $CALLERS; do
  if [ ! -f "$f" ]; then
    echo "FAIL[A]: caller file missing: $f"
    fail=1
  elif ! grep -q "lib/pricing" "$f"; then
    echo "FAIL[A]: $f does not reference lib/pricing"
    fail=1
  fi
done

if [ ! -f src/lib/pricing.ts ]; then
  echo "FAIL[A]: src/lib/pricing.ts not found"
  fail=1
elif [ "$(sha256_of src/lib/pricing.ts)" != "$EXPECTED_PRICING_SHA" ]; then
  echo "FAIL[A]: src/lib/pricing.ts was modified (sha256 mismatch)"
  fail=1
fi

[ $fail -eq 0 ] && echo "ok[A]: price-utility migration complete"
exit $fail
