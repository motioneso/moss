#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-news-host}"
export CARGO_TARGET_DIR
modules/news/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/news/host/Cargo.toml --bin news-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/news.mosspkg"
export JS235_NEWS_PACKAGE="$CARGO_TARGET_DIR/news.mosspkg"
pnpm exec tsx modules/news/tools/live-gate.ts
