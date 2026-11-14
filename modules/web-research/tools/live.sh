#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-web-research-host}"
export CARGO_TARGET_DIR
modules/web-research/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/web-research/host/Cargo.toml --bin web-research-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/web-research.mosspkg"
export JS235_WEB_RESEARCH_PACKAGE="$CARGO_TARGET_DIR/web-research.mosspkg"
pnpm exec tsx modules/web-research/tools/live-gate.ts
