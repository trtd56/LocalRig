#!/usr/bin/env bash
# Install the `delegate-local` Claude Code skill into a project (or the user
# scope), then check that the prerequisites for delegating are actually there.
#
#   ./install-skill.sh /path/to/project   # -> <project>/.claude/skills/delegate-local/
#   ./install-skill.sh --user             # -> ~/.claude/skills/delegate-local/
#   ./install-skill.sh                    # -> $PWD/.claude/skills/delegate-local/
#
# SKILL.md is always refreshed from this repository; PROJECT.md is created from
# the template only when it does not exist yet, so a filled-in profile is never
# clobbered by a reinstall.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/delegate-local"
SKILL_NAME="delegate-local"

target=""
case "${1-}" in
  --user) target="$HOME/.claude/skills/$SKILL_NAME" ;;
  -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") target="$PWD/.claude/skills/$SKILL_NAME" ;;
  *)
    if [ ! -d "$1" ]; then echo "not a directory: $1" >&2; exit 1; fi
    target="$(cd "$1" && pwd)/.claude/skills/$SKILL_NAME"
    ;;
esac

mkdir -p "$target"
cp "$SRC_DIR/SKILL.md" "$target/SKILL.md"
echo "installed  $target/SKILL.md"

if [ -e "$target/PROJECT.md" ]; then
  echo "kept       $target/PROJECT.md (already exists — not overwritten)"
else
  cp "$SRC_DIR/PROJECT.template.md" "$target/PROJECT.md"
  echo "created    $target/PROJECT.md (from template — fill in the TODOs)"
fi

echo
echo "--- prerequisites ---"
status=0

if command -v lh >/dev/null 2>&1; then
  echo "ok    lh          $(command -v lh)"
else
  echo "MISS  lh          not on PATH — run 'bun link' in the LocalRig repo"
  status=1
fi

ollama_url="${OLLAMA_HOST:-http://localhost:11434}"
case "$ollama_url" in http*) ;; *) ollama_url="http://$ollama_url" ;; esac
if curl -sf -m 3 "$ollama_url/api/version" >/dev/null 2>&1; then
  echo "ok    ollama      $ollama_url"
else
  echo "MISS  ollama      not reachable at $ollama_url"
  status=1
fi

model="${LH_MODEL:-hf.co/ornith-ai/Ornith-1.5-35B-A3B-GGUF:Q4_K_M}"
if curl -sf -m 5 "$ollama_url/api/tags" 2>/dev/null | grep -qF "$model"; then
  echo "ok    model       $model"
else
  echo "MISS  model       $model not pulled — run: ollama pull $model"
  status=1
fi

echo
if [ "$status" -eq 0 ]; then
  echo "Next: fill in the TODOs in $target/PROJECT.md, then ask Claude Code to"
  echo "delegate something mechanical. The skill will read PROJECT.md first."
else
  echo "Fix the MISS lines above before delegating (see integrations/SETUP.md)."
fi
exit "$status"
