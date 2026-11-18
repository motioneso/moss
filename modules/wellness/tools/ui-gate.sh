#!/usr/bin/env bash
# Interactive real-data check. Close it by writing the output folder's finished file.
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
export WELLNESS_UI_OUT="${WELLNESS_UI_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/moss-wellness-ui.XXXXXX")}"
mkdir -p "$WELLNESS_UI_OUT"
chmod 700 "$WELLNESS_UI_OUT"
modules/wellness/tools/build-component.sh "$WELLNESS_UI_OUT/module.wasm"
export WELLNESS_COMPONENT="$WELLNESS_UI_OUT/module.wasm"
cargo +1.95.0 build --locked --offline --manifest-path modules/wellness/host/Cargo.toml --bin wellness-ui-check
python3 rust-spike/module-ui/build-assets.py "$WELLNESS_UI_OUT/shared"
pnpm exec tsx modules/wellness/tools/ui-gate.ts
