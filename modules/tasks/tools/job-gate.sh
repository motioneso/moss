#!/usr/bin/env bash
# Focused Tasks job checks: the compiled component against the real queue and scheduler.
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
dir="$(mktemp -d "${TMPDIR:-/tmp}/moss-tasks-jobs.XXXXXX")"
trap 'rm -rf "$dir"' EXIT
modules/tasks/tools/build-component.sh "$dir/module.wasm"
export TASKS_COMPONENT="$dir/module.wasm"
export TASKS_PRIVACY_FILTER=recurrence_schedule,deferred_status,recurring_completion
pnpm exec tsx modules/tasks/tools/gate.ts
