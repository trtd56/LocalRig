#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C
export LANG=C

test -f ANSWER.md
grep -Fx "definition: src/core/retry-policy.ts" ANSWER.md
grep -Fx "registration: src/runtime/pipeline.ts" ANSWER.md
grep -Fx "caller_count: 3" ANSWER.md

grep -F "export function withRetryPolicy" src/core/retry-policy.ts
grep -F "retry: withRetryPolicy" src/runtime/pipeline.ts

while read -r expected file; do
  actual=$(shasum -a 256 "$file" | awk '{print $1}')
  test "$actual" = "$expected"
done <<'EOF'
74198c53902798fab1b7a66e6ff145985310d398cdb385293a03bcd6e8147a6f src/core/retry-policy.ts
465946d29110a3041b9a98830cc63daffcdda9a8a66a2f0f224d59edf7d97a3b src/runtime/pipeline.ts
b343426a858a044a24deba33edc742b07f57a9db278133084ac6e0fe13d8e0f3 src/noise/catalog.ts
b3f126dedc00bffadaadec8a19cea5efea35f3126de2d2a623688aeb8a54dbb4 src/noise/config.ts
e3afdfcf8903b87d367a8991ca3687bf197bf346a9f911b55a33d70db47a03f4 src/noise/events.ts
93ad4b9c44d680ebaeb24e938f1217df60a81ec2014739b802e70268abb97590 src/noise/logger.ts
11a2cda6be4e2f03bb7df41a78ea1803493305fac805b17394c3d9ff2dd64f11 src/noise/metrics.ts
9162326f3b9a04577a2dd0b145eac12c98c35678e5673c69b7e39e4cdebab4c5 src/noise/readme.ts
76ff3f9aa902ec2431ed213880c0c257d7f7eb227b06bce20eeeb9c138456785 src/workers/email.ts
80d1d46a83036074628fdbbdce28e14ef3ae4353f6e78294a1b15e5077753728 src/workers/export.ts
1fb96403eef60892026ec4f30cc136904a26a734968be24442b8aad3321a5489 src/workers/webhook.ts
EOF
