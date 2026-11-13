#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-backtrack-host}"
export CARGO_TARGET_DIR
modules/backtrack/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/backtrack/host/Cargo.toml --bin backtrack-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/backtrack.mosspkg"
export JS261_BACKTRACK_PACKAGE="$CARGO_TARGET_DIR/backtrack.mosspkg"
pnpm exec tsx modules/backtrack/tools/live-gate.ts
