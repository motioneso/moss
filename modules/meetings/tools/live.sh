#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-meetings-host}"
export CARGO_TARGET_DIR
modules/meetings/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/meetings/host/Cargo.toml --bin meetings-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/meetings.mosspkg"
export JS235_MEETINGS_PACKAGE="$CARGO_TARGET_DIR/meetings.mosspkg"
pnpm exec tsx modules/meetings/tools/live-gate.ts
