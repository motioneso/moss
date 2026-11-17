#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-commitments-host}"
export CARGO_TARGET_DIR
modules/commitments/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/commitments/host/Cargo.toml --bin commitments-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/commitments.mosspkg"
export JS293_COMMITMENTS_PACKAGE="$CARGO_TARGET_DIR/commitments.mosspkg"
pnpm exec tsx modules/commitments/tools/live-gate.ts
