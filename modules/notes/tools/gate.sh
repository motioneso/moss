#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ "${JARVIS_GATE_RUN:-}" != 1 ]]; then
  echo 'Refusing database work outside scripts/run-gate.sh' >&2
  exit 4
fi
: "${NOTES_COMPONENT:?Build Notes with tools/build-component.sh and set NOTES_COMPONENT}"
pnpm exec tsx modules/notes/tools/database-gate.ts
pnpm exec tsx modules/notes/tools/guest-gate.ts
