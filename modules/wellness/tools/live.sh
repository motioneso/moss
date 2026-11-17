#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-wellness-host}"
export CARGO_TARGET_DIR
modules/wellness/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/wellness/host/Cargo.toml --bin wellness-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/wellness.mosspkg"
export JS287_WELLNESS_PACKAGE="$CARGO_TARGET_DIR/wellness.mosspkg"
pnpm exec tsx modules/wellness/tools/live-gate.ts
