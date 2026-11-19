#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ "${JARVIS_GATE_RUN:-}" != 1 ]]; then
  echo 'Refusing database work outside scripts/run-gate.sh' >&2
  exit 4
fi
: "${CARGO_TARGET_DIR:=/tmp/moss-notes-host}"
export CARGO_TARGET_DIR
if [[ -z "${NOTES_COMPONENT:-}" ]]; then
  export NOTES_COMPONENT="$CARGO_TARGET_DIR/notes.wasm"
  MOSS_HOST_TARGET_DIR="${MOSS_HOST_TARGET_DIR:-$CARGO_TARGET_DIR}" \
    CARGO_TARGET_DIR="$CARGO_TARGET_DIR/notes-guest" \
    NOTES_TOOL_CHECKPOINT=0 modules/notes/tools/build-component.sh "$NOTES_COMPONENT"
fi
if [[ -z "${NOTES_TOOL_COMPONENT:-}" ]]; then
  export NOTES_TOOL_COMPONENT="$CARGO_TARGET_DIR/notes-tools.wasm"
  MOSS_HOST_TARGET_DIR="${MOSS_HOST_TARGET_DIR:-$CARGO_TARGET_DIR}" \
    CARGO_TARGET_DIR="$CARGO_TARGET_DIR/notes-tools-guest" \
    NOTES_TOOL_CHECKPOINT=1 modules/notes/tools/build-component.sh "$NOTES_TOOL_COMPONENT"
fi
pnpm exec tsx modules/notes/tools/manual-sync-parity.ts --check
pnpm exec tsx modules/notes/tools/settings-input-parity.ts --check
pnpm exec tsx modules/notes/tools/database-gate.ts
pnpm exec tsx modules/notes/tools/guest-gate.ts
pnpm exec tsx modules/notes/tools/cleanup-gate.ts
pnpm exec tsx modules/notes/tools/ingest-gate.ts

cargo +1.95.0 test --locked --offline --manifest-path modules/notes/tools/Cargo.toml --test component --test write_tools --test screen --test sync
