#!/usr/bin/env bash
# Interactive real-data check. Close it by writing the output folder's finished file.
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
export TASKS_UI_OUT="${TASKS_UI_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/moss-tasks-ui.XXXXXX")}"
mkdir -p "$TASKS_UI_OUT"
chmod 700 "$TASKS_UI_OUT"
modules/tasks/tools/build-component.sh "$TASKS_UI_OUT/module.wasm"
export TASKS_COMPONENT="$TASKS_UI_OUT/module.wasm"
cargo +1.95.0 build --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --bin tasks-ui-check
python3 rust-spike/module-ui/build-assets.py "$TASKS_UI_OUT/shared"
pnpm exec tsx modules/tasks/tools/ui-gate.ts
