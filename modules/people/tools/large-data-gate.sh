#!/usr/bin/env bash
# Probe large-account legacy parity; check its exit status and the delivery report.
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ "${JARVIS_GATE_RUN:-}" != 1 ]]; then
  echo 'Refusing database work outside scripts/run-gate.sh' >&2
  exit 4
fi
: "${CARGO_TARGET_DIR:=/tmp/moss-people-host}"
export CARGO_TARGET_DIR
if [[ -z "${JS50_PEOPLE_COMPONENT:-}" ]]; then
  export JS50_PEOPLE_COMPONENT="$CARGO_TARGET_DIR/people.wasm"
  modules/people/tools/build-generated-component.sh "$JS50_PEOPLE_COMPONENT"
fi
export JS139_PEOPLE_PAGING_PROBE=1
export JS50_PEOPLE_SUITE=people_guest_database
exec rust-spike/module-host/tools/people-gate.sh
