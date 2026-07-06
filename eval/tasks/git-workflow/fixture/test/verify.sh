#!/usr/bin/env bash
# The task is done when tests pass AND the git history shows the requested
# workflow: >= 2 commits, one mentioning "fix", and a clean working tree.
set -u
fail=0

if ! bun test; then
  echo "FAIL: bun test"
  fail=1
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "FAIL: not a git repository"
  exit 1
fi

count=$(git rev-list --count HEAD 2>/dev/null || echo 0)
if [ "$count" -lt 2 ]; then
  echo "FAIL: expected >= 2 commits, found $count"
  fail=1
fi

if ! git log --format=%s | grep -qi "fix"; then
  echo "FAIL: no commit message containing 'fix'"
  fail=1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "FAIL: working tree not clean:"
  git status --porcelain
  fail=1
fi

[ $fail -eq 0 ] && echo "ok: git workflow complete"
exit $fail
