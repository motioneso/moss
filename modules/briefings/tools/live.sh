#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-briefings-host}"
export CARGO_TARGET_DIR
modules/briefings/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/briefings/host/Cargo.toml --bin briefings-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/briefings.mosspkg"
export JS235_BRIEFINGS_PACKAGE="$CARGO_TARGET_DIR/briefings.mosspkg"
pnpm exec tsx modules/briefings/tools/live-gate.ts
