#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ "${JARVIS_GATE_RUN:-}" != 1 ]]; then
  echo 'Refusing removal controls outside scripts/run-gate.sh' >&2
  exit 4
fi
pnpm exec tsx modules/calendar/tools/apply-security-gate.ts
