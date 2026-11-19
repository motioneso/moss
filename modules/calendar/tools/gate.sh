#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/js48-host-target}"
export CALENDAR_UI_DIR="${CALENDAR_UI_DIR:-$CARGO_TARGET_DIR/calendar-ui/web}"
modules/calendar/tools/check.sh
# The installed suites use Calendar's real required Tasks package.
TASKS_GUEST_TARGET_DIR="$CARGO_TARGET_DIR/calendar-tasks-guest" \
  modules/tasks/tools/build-component.sh "$CARGO_TARGET_DIR/calendar-tasks.wasm"
export CALENDAR_TASKS_PACKAGE="$CARGO_TARGET_DIR/calendar-tasks.mosspkg"
cargo +1.95.0 run --locked --offline --manifest-path modules/tasks/tools/Cargo.toml \
  --bin tasks-pack -- "$CARGO_TARGET_DIR/calendar-tasks.wasm" "$CALENDAR_TASKS_PACKAGE"
pnpm exec tsx modules/calendar/tools/gate.ts
