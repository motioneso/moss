#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-goals-host}"
export CARGO_TARGET_DIR
modules/goals/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/goals/host/Cargo.toml --bin goals-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/goals.mosspkg"
export JS287_GOALS_PACKAGE="$CARGO_TARGET_DIR/goals.mosspkg"
pnpm exec tsx modules/goals/tools/live-gate.ts
