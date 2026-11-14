#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ "${JARVIS_GATE_RUN:-}" != 1 ]]; then
  echo 'Refusing database work outside scripts/run-gate.sh' >&2
  exit 4
fi
# Pure shape tests natively, then the database proof with TypeScript in the loop.
cargo +1.95.0 test --locked --offline --manifest-path rust-spike/module-host/Cargo.toml --lib shape_tests
pnpm exec tsx rust-spike/module-host/tools/weather-preferences-gate.ts
