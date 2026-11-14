#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-scratchpad-host}"
export CARGO_TARGET_DIR
modules/scratchpad/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/scratchpad/host/Cargo.toml --bin scratchpad-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/scratchpad.mosspkg"
export JS286_SCRATCHPAD_PACKAGE="$CARGO_TARGET_DIR/scratchpad.mosspkg"
pnpm exec tsx modules/scratchpad/tools/live-gate.ts
