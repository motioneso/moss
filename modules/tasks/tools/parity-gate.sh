#!/usr/bin/env bash
# Compare today's TypeScript API with the actual Tasks Wasm component.
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
tasks_root="$PWD"
tasks_parity_out="${TASKS_PARITY_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/moss-tasks-parity.XXXXXX")}"
mkdir -p "$tasks_parity_out"
modules/tasks/tools/build-component.sh "$tasks_parity_out/module.wasm"
export TASKS_COMPONENT="$tasks_parity_out/module.wasm"
cargo +1.95.0 build --locked --offline --manifest-path modules/tasks/tools/Cargo.toml \
  --bin tasks-component-server --bin tasks-component-parity
pnpm build:app-map
tasks_ts_port="$(devports claim js-56-component-parity-ts)"
tasks_rs_port=""
cleanup() {
  devports release "$tasks_ts_port" >/dev/null 2>&1 || true
  [[ -z "$tasks_rs_port" ]] || devports release "$tasks_rs_port" >/dev/null 2>&1 || true
}
trap cleanup EXIT
tasks_rs_port="$(devports claim js-56-component-parity-rs)"
tasks_target="${CARGO_TARGET_DIR:-$PWD/modules/tasks/tools/target}"
printf 'Component differential evidence: %s\n' "$tasks_parity_out"
"$tasks_target/debug/tasks-component-parity" \
  --repo "$tasks_root" \
  --cases "${TASKS_PARITY_CASES:-$tasks_root/rust-spike/parity/cases}" \
  --report "$tasks_parity_out/report.json" \
  --logs "$tasks_parity_out" \
  --rs-bin "$tasks_target/debug/tasks-component-server" \
  --ts-port "$tasks_ts_port" --rs-port "$tasks_rs_port" "$@"
