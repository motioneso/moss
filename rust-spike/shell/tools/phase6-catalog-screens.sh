#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:?Use a task-owned target}"
: "${RUSTUP_HOME:?Set RUSTUP_HOME}"
export CARGO_BUILD_JOBS=1 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 RUST_TEST_THREADS=1
cargo +1.95.0 build --offline --locked --manifest-path rust-spike/shell/Cargo.toml -p moss-shell-ui --target wasm32-unknown-unknown
cargo +1.95.0 build --offline --locked --manifest-path rust-spike/ui/bindgen/Cargo.toml
"$CARGO_TARGET_DIR/debug/ui-bindgen" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/debug/moss-shell-ui.wasm" "$CARGO_TARGET_DIR/web" app
python3 rust-spike/shell/assets/build-assets.py "$CARGO_TARGET_DIR/web"
python3 rust-spike/module-ui/build-assets.py "$CARGO_TARGET_DIR/web/module-shared"
cp rust-spike/shell/assets/index.html "$CARGO_TARGET_DIR/web/index.html"
cargo +1.95.0 build --offline --locked --manifest-path rust-spike/shell/Cargo.toml -p moss-shell
cargo +1.95.0 build --offline --locked --manifest-path rust-spike/network/Cargo.toml --bin moss-network
cargo +1.95.0 test --offline --locked --manifest-path rust-spike/module-host/Cargo.toml --test catalog_presentation -- --test-threads=1
pnpm exec tsx rust-spike/shell/tools/phase6-catalog-screens.ts
