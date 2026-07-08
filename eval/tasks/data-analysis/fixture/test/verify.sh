#!/usr/bin/env bash
set -u
fail=0

[ -f ANALYSIS.md ] || { echo "FAIL: ANALYSIS.md not found"; exit 1; }

expect_line() {
  local n="$1" expected="$2"
  [ "$(sed -n "${n}p" ANALYSIS.md | tr '[:upper:]' '[:lower:]')" = "$expected" ] || {
    echo "FAIL: line $n expected '$expected'"
    fail=1
  }
}
expect_line 1 'valid_orders: 10'
expect_line 2 'excluded_rows: 3'
expect_line 3 'gross_revenue: 1380.00'
expect_line 4 'refund_total: 250.00'
expect_line 5 'net_revenue: 1130.00'
expect_line 6 'top_region_by_net: east'

grep -Eiq 'atlas.*0\.00%' ANALYSIS.md || { echo "FAIL: atlas refund rate must be 0.00%"; fail=1; }
grep -Eiq 'beacon.*28\.57%' ANALYSIS.md || { echo "FAIL: beacon refund rate must be 28.57%"; fail=1; }
if ! grep -Eiq 'comet.*30\.36%.*(highest|最高)|(highest|最高).*comet.*30\.36%' ANALYSIS.md; then
  echo "FAIL: comet must be identified as highest at 30.36%"
  fail=1
fi
for reason in 'o-108.*(duplicat|重複)|(duplicat|重複).*o-108' 'o-111.*(test|テスト)|(test|テスト).*o-111' 'o-112.*(pending|保留|未完了)|(pending|保留|未完了).*o-112'; do
  grep -Eiq "$reason" ANALYSIS.md || { echo "FAIL: missing data-quality reason matching $reason"; fail=1; }
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else LC_ALL=C shasum -a 256 "$1" | awk '{print $1}'; fi
}
verify_hash() {
  local file="$1" expected="$2"
  [ -f "$file" ] && [ "$(sha256_of "$file")" = "$expected" ] || {
    echo "FAIL: input data was modified: $file"
    fail=1
  }
}
verify_hash data/DEFINITIONS.md 28aad3d53be0e9d09c5355fa11e2c3f3d55a943d100198653c7ce4c79971d0ec
verify_hash data/orders.csv 2f9fbad99ff0a46718bdf1474b3899d0048d419d591edfeebead7be97d27bb1c
verify_hash data/refunds.csv 49f1581e122a31244e9c9fe2fd1a3127b7caac6583b8a83ed5752d53f833b216

exit $fail
