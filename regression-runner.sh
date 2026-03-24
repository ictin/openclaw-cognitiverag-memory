#!/usr/bin/env bash
set -euo pipefail

node --check index.ts
node --check smoke-assemble.mjs
node --check harness-assemble.mjs
node --check harness-registration.mjs
node isolated-plugin-failure-harness.mjs

echo "regression runner ok"
