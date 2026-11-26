#!/usr/bin/env bash
# Live proof for the Today hero briefing note: real server, real shell UI, two accounts.
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_HOME:?Use task-owned Rust directories}"
: "${RUSTUP_HOME:?Use task-owned Rust directories}"
: "${CARGO_TARGET_DIR:?Use task-owned Rust directories}"
export HERO_OUT="${HERO_OUT:-$CARGO_TARGET_DIR/hero-proof}"
export HERO_WEB="$CARGO_TARGET_DIR/hero-dist/web"
rm -rf "$CARGO_TARGET_DIR/hero-dist"
# Rust 1.95 is the toolchain the module gates use, and it has the wasm target.
CARGO_TARGET_DIR="$CARGO_TARGET_DIR/shell-ui" rust-spike/shell/build.sh "$CARGO_TARGET_DIR/hero-dist"
cargo +1.95.0 build --offline --locked --manifest-path rust-spike/shell/Cargo.toml -p moss-server
cargo +1.95.0 build --offline --locked --manifest-path rust-spike/network/Cargo.toml --bin moss-network
modules/briefings/tools/build-component.sh "$CARGO_TARGET_DIR/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/briefings/host/Cargo.toml --bin briefings-package -- \
  "$CARGO_TARGET_DIR/module.wasm" "$CARGO_TARGET_DIR/briefings.mosspkg"
export JS235_BRIEFINGS_PACKAGE="$CARGO_TARGET_DIR/briefings.mosspkg"
pnpm exec tsx rust-spike/shell/tools/hero-live.ts
