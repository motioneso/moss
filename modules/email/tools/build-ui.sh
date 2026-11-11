#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
ui_target="${EMAIL_UI_TARGET:-${CARGO_TARGET_DIR:-/tmp/moss-email-host}/email-ui}"
ui_out="${EMAIL_UI_DIR:-$ui_target/web}"
bindgen_target="${EMAIL_BINDGEN_TARGET:-$ui_target/bindgen}"
CARGO_TARGET_DIR="$ui_target" cargo +1.95.0 build --locked --offline --release \
  --manifest-path modules/email/ui/Cargo.toml --no-default-features --features csr --target wasm32-unknown-unknown --lib
CARGO_TARGET_DIR="$bindgen_target" cargo +1.95.0 build --locked --offline --release --manifest-path rust-spike/ui/bindgen/Cargo.toml
mkdir -p "$ui_out"
"$bindgen_target/release/ui-bindgen" "$ui_target/wasm32-unknown-unknown/release/moss_email_ui.wasm" "$ui_out" email
cp modules/email/ui/web/{boot.mjs,bridge.mjs} "$ui_out/"
cp modules/email/ui/web/index.html "$ui_out/index.html"
cp modules/email/ui/web/index.html "$ui_out/settings.html"
cp rust-spike/module-ui/web/guest-bridge.mjs "$ui_out/"
cp modules/email/ui/web/layout.css "$ui_out/email.css"
echo "Email UI built at $ui_out"
