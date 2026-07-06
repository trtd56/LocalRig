#!/usr/bin/env bash
# Full task = Part A AND Part B.
#   Part A (delegable, mechanical): src/lib/money.ts → src/lib/pricing.ts sweep,
#           checked by test/verify-a.sh (the same command a worker should pass).
#   Part B (Claude's own work): the NOTES-ARCH.md design memo — one "## <path>"
#           section per module that names that module's exported functions, plus
#           a "## リスクと改善案" section with >= 3 bullet points. All checks are
#           mechanical (heading present + required function names inside each
#           section's body + bullet count) so a partial solution (A only or B
#           only) still FAILs and only A+B passes.
set -u
fail=0

# --- Part A ---
if ! bash test/verify-a.sh; then
  fail=1
fi

# --- Part B: NOTES-ARCH.md design memo ---
DOC=NOTES-ARCH.md
if [ ! -f "$DOC" ]; then
  echo "FAIL[B]: $DOC not found"
  fail=1
else
  # Prints the body of the "## <want>" section: every line after that heading up
  # to (not including) the next "## " heading or EOF. Trailing whitespace on the
  # heading is ignored; the heading text must otherwise match exactly.
  section_body() {
    awk -v want="$1" '
      /^## / {
        if (inb) exit
        line=$0
        sub(/^## +/, "", line)
        sub(/[[:space:]]+$/, "", line)
        if (line == want) { inb=1; next }
      }
      inb { print }
    ' "$DOC"
  }

  # check_section <heading> <fn> [<fn> ...]: the named section must exist and its
  # body must mention every listed exported function name.
  check_section() {
    heading="$1"; shift
    body="$(section_body "$heading")"
    if [ -z "$body" ]; then
      echo "FAIL[B]: missing or empty section: ## $heading"
      fail=1
      return
    fi
    for fn in "$@"; do
      if ! printf '%s\n' "$body" | grep -q "$fn"; then
        echo "FAIL[B]: section '## $heading' does not mention $fn"
        fail=1
      fi
    done
  }

  check_section "src/checkout" cartLine receiptTotals orderSummary
  check_section "src/catalog" productCard priceTag saleBadge
  check_section "src/reports" dailySales refundLine
  check_section "src/notifications" orderEmail priceAlert
  check_section "src/lib" formatMoney discount

  risk_body="$(section_body 'リスクと改善案')"
  if [ -z "$risk_body" ]; then
    echo "FAIL[B]: missing section: ## リスクと改善案"
    fail=1
  else
    bullets="$(printf '%s\n' "$risk_body" | grep -c '^[[:space:]]*[-*] ')"
    if [ "$bullets" -lt 3 ]; then
      echo "FAIL[B]: ## リスクと改善案 needs >= 3 bullet points (found $bullets)"
      fail=1
    fi
  fi
fi

[ $fail -eq 0 ] && echo "ok: async-pair complete (Part A migration + Part B NOTES-ARCH.md)"
exit $fail
