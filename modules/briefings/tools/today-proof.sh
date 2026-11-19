#!/usr/bin/env bash
# Holds a real Rust server open with Briefings and Tasks installed and two suggested tasks seeded,
# so a browser can exercise the Today "Needs you" section. Run through verify-gate.
# BRIEFINGS_HOLD_OPEN names the hold file. Create "<hold>.stop" to end the run.
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_HOME:?Set CARGO_HOME}"
: "${RUSTUP_HOME:?Set RUSTUP_HOME}"
: "${BRIEFINGS_HOLD_OPEN:?Set BRIEFINGS_HOLD_OPEN}"
: "${CARGO_TARGET_DIR:=/tmp/moss-briefings-today}"
export CARGO_TARGET_DIR
tasks_out="$CARGO_TARGET_DIR/tasks-pkg"
mkdir -p "$tasks_out"
TASKS_GUEST_TARGET_DIR="$CARGO_TARGET_DIR/tasks-guest" bash modules/tasks/tools/build-component.sh "$tasks_out/module.wasm"
cargo +1.95.0 run --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --bin tasks-pack -- \
  "$tasks_out/module.wasm" "$CARGO_TARGET_DIR/tasks.mosspkg"
export JS220_TASKS_PACKAGE="$CARGO_TARGET_DIR/tasks.mosspkg"
export BRIEFINGS_WITH_TASKS=1 BRIEFINGS_SEED_SUGGESTED=1
web="$CARGO_TARGET_DIR/today-web"
cargo +1.95.0 build --locked --offline --release --manifest-path rust-spike/ui/bindgen/Cargo.toml
cargo +1.95.0 build --locked --offline --release --manifest-path rust-spike/shell/Cargo.toml -p moss-shell-ui --target wasm32-unknown-unknown
mkdir -p "$web"
"$CARGO_TARGET_DIR/release/ui-bindgen" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/moss-shell-ui.wasm" "$web" app
python3 rust-spike/shell/assets/build-assets.py "$web"
python3 rust-spike/module-ui/build-assets.py "$web/module-shared"
cp rust-spike/shell/assets/index.html "$web/index.html"
export BRIEFINGS_WEB="$web"
modules/briefings/tools/live.sh
