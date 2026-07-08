#!/usr/bin/env bash
set -u
fail=0

[ -f DECISION.md ] || { echo "FAIL: DECISION.md not found"; exit 1; }

expected_lines=(
  'token_ttl_minutes: 15'
  'single_use: true'
  'invalidate_existing_sessions: true'
  'unknown_email_response: generic'
  'delivery_channel: email'
)
for i in "${!expected_lines[@]}"; do
  line=$((i + 1))
  [ "$(sed -n "${line}p" DECISION.md | tr '[:upper:]' '[:lower:]')" = "${expected_lines[$i]}" ] || {
    echo "FAIL: line $line expected '${expected_lines[$i]}'"
    fail=1
  }
done
if ! sed -n '6p' DECISION.md | grep -Eiq '^open_question:.*(locali[sz]ation|translation|ローカライズ|翻訳).*(owner|ownership|担当|責任者|承認者)|^open_question:.*(owner|ownership|担当|責任者|承認者).*(locali[sz]ation|translation|ローカライズ|翻訳)'; then
  echo "FAIL: localization ownership must remain an open question"
  fail=1
fi

grep -q '^## Conflicts$' DECISION.md || { echo "FAIL: missing Conflicts section"; fail=1; }
grep -q '^## Acceptance criteria$' DECISION.md || { echo "FAIL: missing Acceptance criteria section"; fail=1; }
grep -Eiq '(24 hour|24-hour|24時間)' DECISION.md && grep -Eiq '(security|セキュリティ|15.minute|15分)' DECISION.md || { echo "FAIL: TTL conflict not explained"; fail=1; }
grep -Eiq '(reus|再利用|double-click)' DECISION.md && grep -Eiq '(single.use|single-use|一度|1回)' DECISION.md || { echo "FAIL: reuse conflict not explained"; fail=1; }
grep -Eiq '(sign.?out|session|セッション)' DECISION.md && grep -Eiq '(invalidate|無効)' DECISION.md || { echo "FAIL: session conflict not explained"; fail=1; }

criteria_count=$(awk '/^## Acceptance criteria/{in_section=1;next}/^## /{in_section=0} in_section && /^[-*] /{n++} END{print n+0}' DECISION.md)
[ "$criteria_count" -ge 4 ] || { echo "FAIL: expected >=4 acceptance criteria"; fail=1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else LC_ALL=C shasum -a 256 "$1" | awk '{print $1}'; fi
}
verify_hash() {
  local file="$1" expected="$2"
  [ -f "$file" ] && [ "$(sha256_of "$file")" = "$expected" ] || {
    echo "FAIL: source brief was modified: $file"
    fail=1
  }
}
verify_hash briefs/DECISION_RULES.md 71b26524762d95ceb53809c8d62ced017ad78bac9cc601d7c996f30eb4b6c1ae
verify_hash briefs/PRODUCT.md 2f05f78444eae2b643abb204d9d3ff631b5e2012ae56c536f013b4b96f141846
verify_hash briefs/SECURITY.md f315c40d756dabe4d49b660d0306ac922fd536448cb274f360e3143b1301f56f
verify_hash briefs/SUPPORT.md 0d91f68de4892968009f3ee6d203402ee40904db8254fba182d6e919724eec53

exit $fail
