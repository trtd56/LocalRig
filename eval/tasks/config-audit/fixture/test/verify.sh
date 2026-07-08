#!/usr/bin/env bash
set -u
fail=0

[ -f AUDIT.md ] || { echo "FAIL: AUDIT.md not found"; exit 1; }
[ "$(sed -n '1p' AUDIT.md | tr '[:upper:]' '[:lower:]')" = 'finding_count: 4' ] || { echo "FAIL: expected exactly 4 findings"; fail=1; }

finding_lines=$(grep -Ec '^F[0-9]+:' AUDIT.md || true)
[ "$finding_lines" -eq 4 ] || { echo "FAIL: expected four F-lines"; fail=1; }
sed -n '2p' AUDIT.md | grep -Eiq '^F1: critical .*deploy/compose\.yml.*(5432|port|public|0\.0\.0\.0)' || { echo "FAIL: F1 must be critical public database port"; fail=1; }
grep -Eiq '^F[2-4]: high .*deploy/app\.env.*(debug|APP_DEBUG)' AUDIT.md || { echo "FAIL: missing high debug finding"; fail=1; }
grep -Eiq '^F[2-4]: high .*deploy/app\.env.*(TLS|verify|certificate)' AUDIT.md || { echo "FAIL: missing high TLS verification finding"; fail=1; }
grep -Eiq '^F[2-4]: high .*deploy/app\.env.*(password|ADMIN_PASSWORD|literal)' AUDIT.md || { echo "FAIL: missing high literal-password finding"; fail=1; }
if grep -Eiq '^F[0-9]+:.*server_tokens|^F[0-9]+:.*version header' AUDIT.md; then
  echo "FAIL: explicitly allowed server_tokens was reported"
  fail=1
fi

grep -q '^## Recommendations$' AUDIT.md || { echo "FAIL: missing Recommendations section"; fail=1; }
recommendation_count=$(awk '/^## Recommendations/{in_section=1;next}/^## /{in_section=0} in_section && /^[-*] /{n++} END{print n+0}' AUDIT.md)
[ "$recommendation_count" -ge 4 ] || { echo "FAIL: expected >=4 recommendation bullets"; fail=1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else LC_ALL=C shasum -a 256 "$1" | awk '{print $1}'; fi
}
verify_hash() {
  local file="$1" expected="$2"
  [ -f "$file" ] && [ "$(sha256_of "$file")" = "$expected" ] || {
    echo "FAIL: audited input was modified: $file"
    fail=1
  }
}
verify_hash policy/PRODUCTION.md 6a71a612b8352769c145a41485e85d7e708da3cbee33a89de1ca152cba80ee9d
verify_hash deploy/app.env ad81a014c8e3d935884938a2980659decca014a4ee482323e4d44d4d4ef23beb
verify_hash deploy/compose.yml 123daa724ed5ea06b4ea8756d84511025337efeb5aa5f43d9cfb551fc7565efb
verify_hash deploy/nginx.conf 8c182eda3a8da6437f6bbc18414ca1d4f5ac8836c32f4d65a639979d6892b1a2

exit $fail
