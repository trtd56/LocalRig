#!/usr/bin/env bash
set -u
fail=0

if [ ! -f INCIDENT.md ]; then
  echo "FAIL: INCIDENT.md not found"
  exit 1
fi

check_line() {
  local n="$1" pattern="$2" label="$3"
  if sed -n "${n}p" INCIDENT.md | grep -Eiq "$pattern"; then
    echo "ok: $label"
  else
    echo "FAIL: $label"
    fail=1
  fi
}

check_line 1 '^verdict: confirmed$' verdict
check_line 2 '^service: payments-api$' service
check_line 3 '^start: 2026-06-18T09:14:00Z$' start
check_line 4 '^recovered: 2026-06-18T09:28:00Z$' recovery
check_line 5 '^failed_requests: 37$' failed_requests
check_line 6 '^root_cause:.*(pool|connection|接続).*(40.*8|8.*40)' root_cause

evidence_count=$(awk '/^## Evidence/{in_section=1;next}/^## /{in_section=0} in_section && /^[-*] /{n++} END{print n+0}' INCIDENT.md)
action_count=$(awk '/^## Actions/{in_section=1;next}/^## /{in_section=0} in_section && /^[-*] /{n++} END{print n+0}' INCIDENT.md)
[ "$evidence_count" -ge 3 ] || { echo "FAIL: expected >=3 evidence bullets"; fail=1; }
[ "$action_count" -ge 2 ] || { echo "FAIL: expected >=2 action bullets"; fail=1; }
grep -Eiq '09:12.*(deploy|DB_POOL|40.*8|デプロイ)' INCIDENT.md || { echo "FAIL: missing deployment evidence"; fail=1; }
grep -Eiq '09:14.*(wait|fail|24|3|待機|失敗)' INCIDENT.md || { echo "FAIL: missing incident-start evidence"; fail=1; }
grep -Eiq '09:2(6|8).*(rollback|zero|0|40|復旧|ロールバック)' INCIDENT.md || { echo "FAIL: missing mitigation/recovery evidence"; fail=1; }
grep -Eiq '(pool|DB_POOL|接続)' INCIDENT.md && grep -Eiq '(valid|lock|restore|40|検証|固定|復元)' INCIDENT.md || { echo "FAIL: missing pool configuration action"; fail=1; }
grep -Eiq '(guard|alert|rollback|監視|アラート|ロールバック)' INCIDENT.md || { echo "FAIL: missing detection/rollback action"; fail=1; }

if grep -Eiq 'root_cause:.*auth cache' INCIDENT.md; then
  echo "FAIL: benign auth warning was selected as root cause"
  fail=1
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else LC_ALL=C shasum -a 256 "$1" | awk '{print $1}'; fi
}
verify_hash() {
  local file="$1" expected="$2"
  [ -f "$file" ] && [ "$(sha256_of "$file")" = "$expected" ] || {
    echo "FAIL: supplied evidence was modified: $file"
    fail=1
  }
}
verify_hash RUNBOOK.md 7716dd66254374d5c24fe37741f0e0e1e851c4bc78f0b7ccab11b133128b255d
verify_hash evidence/deployments.txt 367285c1031790bf2f91cbd513a4e562cd76f526a053c875fcfc37ba002307a9
verify_hash evidence/gateway.txt deac46bae4bbdc73dab664c2b26cdb1ca5834bcf5e4aa372c2df100b42d2ffb6
verify_hash evidence/payments.txt 7e23f4fb04059fbc0d6f6ba7538b61b36ca494039ec25c69cead197c9253c5fd

exit $fail
