#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-weather-host}"
export CARGO_TARGET_DIR
modules/weather/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/weather/host/Cargo.toml --bin weather-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/weather.mosspkg"
export JS235_WEATHER_PACKAGE="$CARGO_TARGET_DIR/weather.mosspkg"
pnpm exec tsx modules/weather/tools/live-gate.ts
