#!/usr/bin/env bash
# Optional real packages for the part 4d chat proof. Uses the caller's isolated gate/target.
set -euo pipefail
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:?Set a task-owned target}"
export CALENDAR_UI_DIR="$CARGO_TARGET_DIR/calendar-ui/web"
export CONNECTORS_UI_DIR="$CARGO_TARGET_DIR/connectors-ui/web"
export EMAIL_UI_DIR="$CARGO_TARGET_DIR/email-ui/web"
TASKS_GUEST_TARGET_DIR="$CARGO_TARGET_DIR/calendar-tasks-guest" bash modules/tasks/tools/build-component.sh "$CARGO_TARGET_DIR/tasks.wasm"
cargo +1.95.0 run --offline --locked --manifest-path modules/tasks/tools/Cargo.toml --bin tasks-pack -- "$CARGO_TARGET_DIR/tasks.wasm" "$CARGO_TARGET_DIR/tasks.mosspkg"
for module in calendar email connectors; do
  "modules/$module/tools/build-ui.sh"
  CARGO_TARGET_DIR="$CARGO_TARGET_DIR/$module-guest" RUSTFLAGS='-C link-arg=--import-memory -C link-arg=--initial-memory=2097152 -C link-arg=--max-memory=67108864' \
    cargo +1.95.0 build --offline --locked --release --lib --target wasm32-unknown-unknown --manifest-path "modules/$module/src/Cargo.toml"
  cargo +1.95.0 run --offline --locked --manifest-path "modules/$module/host/Cargo.toml" --bin "$module-package" -- \
    "$CARGO_TARGET_DIR/$module-guest/wasm32-unknown-unknown/release/moss_${module}.wasm" "$CARGO_TARGET_DIR/$module.mosspkg"
done
for module in meals web-research; do
  "modules/$module/tools/build-component.sh" "$CARGO_TARGET_DIR/$module.wasm"
  cargo +1.95.0 run --offline --locked --manifest-path "modules/$module/host/Cargo.toml" --bin "$module-package" -- \
    "$CARGO_TARGET_DIR/$module.wasm" "$CARGO_TARGET_DIR/$module.mosspkg"
done
