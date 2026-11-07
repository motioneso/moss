#!/usr/bin/env bash
# Phase 0b parity run. Builds the Rust Tasks server and the harness, then sends every case in
# rust-spike/parity/cases to the TypeScript and Rust servers and compares what each one did.
#
#   scripts/run-gate.sh start --gate rust-spike/parity/run-parity.sh
#
# Extra arguments pass through to the harness, for example `--only "lists"`.
set -euo pipefail
[ "${JARVIS_GATE_RUN:-}" = "1" ] || { echo "refusing: not inside a gate run" >&2; exit 3; }

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/rust-spike/target}"
out="${PARITY_OUT:-$CARGO_TARGET_DIR/parity}"
mkdir -p "$out"

(cd "$root/rust-spike" && cargo build --release --quiet -p tasks -p parity)

# The TypeScript server reads the built app map at startup.
(cd "$root" && pnpm --silent build:app-map >/dev/null)

ts_port=$(devports claim js-36-parity-ts)
rs_port=$(devports claim js-36-parity-rs)
release() {
  devports release "$ts_port" >/dev/null 2>&1 || true
  devports release "$rs_port" >/dev/null 2>&1 || true
}
trap release EXIT

"$CARGO_TARGET_DIR/release/parity" \
  --repo "$root" \
  --cases "$root/rust-spike/parity/cases" \
  --report "$out/report.json" \
  --logs "$out" \
  --rs-bin "$CARGO_TARGET_DIR/release/tasks" \
  --ts-port "$ts_port" \
  --rs-port "$rs_port" \
  "$@"
