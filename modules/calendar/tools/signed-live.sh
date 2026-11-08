#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/js72-host-target}"
export CALENDAR_UI_DIR="${CALENDAR_UI_DIR:-$CARGO_TARGET_DIR/calendar-ui/web}"
export CALENDAR_CORE_WASM="$CARGO_TARGET_DIR/calendar-guest/wasm32-unknown-unknown/release/moss_calendar.wasm"
pnpm exec tsx modules/calendar/tools/signed-live.ts
