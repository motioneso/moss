#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ "${JARVIS_GATE_RUN:-}" != 1 ]]; then
  echo 'Refusing database work outside scripts/run-gate.sh' >&2
  exit 4
fi
# Build as a normal downstream consumer, so the host's People dev-dependency
# cannot silently enable the JSON parser feature this regression qualifies.
cargo +1.95.0 run --locked --offline --manifest-path modules/people/tools/host-json/Cargo.toml
node --test modules/people/ui/tests/bridge.test.mjs
pnpm exec tsx modules/people/tools/routes-gate.ts
