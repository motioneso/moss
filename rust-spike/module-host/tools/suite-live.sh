#!/usr/bin/env bash
# Builds the four packages, then runs the News, Sports, Weather and Briefings live suite.
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-suite-host}"
export CARGO_TARGET_DIR
for m in weather news sports briefings; do
  modules/$m/tools/build-component.sh "$CARGO_TARGET_DIR/$m.wasm"
  cargo +1.95.0 run --locked --offline --manifest-path modules/$m/host/Cargo.toml --bin $m-package -- \
    "$CARGO_TARGET_DIR/$m.wasm" "$CARGO_TARGET_DIR/$m.mosspkg"
done
export JS235_WEATHER_PACKAGE="$CARGO_TARGET_DIR/weather.mosspkg"
export JS235_NEWS_PACKAGE="$CARGO_TARGET_DIR/news.mosspkg"
export JS235_SPORTS_PACKAGE="$CARGO_TARGET_DIR/sports.mosspkg"
export JS235_BRIEFINGS_PACKAGE="$CARGO_TARGET_DIR/briefings.mosspkg"
pnpm exec tsx rust-spike/module-host/tools/suite-live-gate.ts
