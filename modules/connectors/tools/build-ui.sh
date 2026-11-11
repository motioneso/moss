#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
ui_target="${CONNECTORS_UI_TARGET:-${CARGO_TARGET_DIR:-/tmp/moss-connectors-host}/connectors-ui}"
ui_out="${CONNECTORS_UI_DIR:-$ui_target/web}"
bindgen_target="${CONNECTORS_BINDGEN_TARGET:-$ui_target/bindgen}"
CARGO_TARGET_DIR="$ui_target" cargo +1.95.0 build --locked --offline --release \
  --manifest-path modules/connectors/ui/Cargo.toml --no-default-features --features csr --target wasm32-unknown-unknown --lib
CARGO_TARGET_DIR="$bindgen_target" cargo +1.95.0 build --locked --offline --release --manifest-path rust-spike/ui/bindgen/Cargo.toml
mkdir -p "$ui_out"
"$bindgen_target/release/ui-bindgen" "$ui_target/wasm32-unknown-unknown/release/moss_connectors_ui.wasm" "$ui_out" connectors
cp modules/connectors/ui/web/{boot.mjs,bridge.mjs} "$ui_out/"
cp modules/connectors/ui/web/index.html "$ui_out/index.html"
cp modules/connectors/ui/web/index.html "$ui_out/settings.html"
cp rust-spike/module-ui/web/guest-bridge.mjs "$ui_out/"
cp modules/connectors/ui/web/layout.css "$ui_out/connectors.css"
echo "Connectors UI built at $ui_out"
