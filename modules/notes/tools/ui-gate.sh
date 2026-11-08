#!/usr/bin/env bash
# Interactive real-data check. Close it by writing the output folder's finished file.
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
export NOTES_UI_OUT="${NOTES_UI_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/moss-notes-ui.XXXXXX")}"
mkdir -p "$NOTES_UI_OUT"
chmod 700 "$NOTES_UI_OUT"
: "${NOTES_COMPONENT:?Build the Notes guest first}"
cargo +1.95.0 build --locked --offline --manifest-path modules/notes/tools/Cargo.toml --bin notes-ui-check
python3 rust-spike/module-ui/build-assets.py "$NOTES_UI_OUT/shared"
pnpm exec tsx modules/notes/tools/ui-gate.ts
