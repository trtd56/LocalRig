#!/usr/bin/env bash
# Runs the fixed program and checks the aggregate output exactly.
set -u

# The input data is part of the spec — reject any tampering with it.
data_hash=$(shasum -a 256 data/events.json | cut -d' ' -f1)
if [ "$data_hash" != "6dce44fa035c585f8fddb0b10eaa5a5e8d9df34d889e339fa2846731592daa92" ]; then
  echo "FAIL: data/events.json was modified"
  exit 1
fi

out=$(bun src/main.ts data/events.json 2>&1)
code=$?
if [ $code -ne 0 ]; then
  echo "FAIL: program exited with $code"
  echo "$out"
  exit 1
fi

expected="ci: 1
deploy: 2
review: 3
events: 7"

if [ "$out" = "$expected" ]; then
  echo "ok: output matches"
  exit 0
fi

echo "FAIL: output mismatch"
echo "--- expected ---"
echo "$expected"
echo "--- actual ---"
echo "$out"
exit 1
