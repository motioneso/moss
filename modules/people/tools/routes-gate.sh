#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ "${JARVIS_GATE_RUN:-}" != 1 ]]; then
  echo 'Refusing database work outside scripts/run-gate.sh' >&2
  exit 4
fi
node --test modules/people/ui/tests/bridge.test.mjs
pnpm exec tsx modules/people/tools/routes-gate.ts
