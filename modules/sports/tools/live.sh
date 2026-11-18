#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-sports-host}"
export CARGO_TARGET_DIR
modules/sports/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/sports/host/Cargo.toml --bin sports-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/sports.mosspkg"
export JS235_SPORTS_PACKAGE="$CARGO_TARGET_DIR/sports.mosspkg"
pnpm exec tsx modules/sports/tools/live-gate.ts
