#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
export LANG=C

test -f ANSWER.md
head -n 1 ANSWER.md | grep -Fx "not_found: true"

grep -F "createInvoice" src/billing.ts
grep -F "capturePayment" src/payments.ts
grep -F "dailyRevenue" src/reports.ts
! grep -R "offline reconciliation" src

while read -r expected file; do
  actual=$(shasum -a 256 "$file" | awk '{print $1}')
  test "$actual" = "$expected"
done <<'EOF'
e0291693bd1a9b55bc1e331f5dbe2607bd091ba4d5cf032be95603bef842ea89 src/billing.ts
359f71b288dc420173af076a4a493a0a55ef4cbb4d08a1121f0f9be991caa326 src/payments.ts
6c1a47b84165776d3f018f6ad181af6f7078fc4e44b4d95057386f92a612151c src/reports.ts
EOF
