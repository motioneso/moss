#!/usr/bin/env bash
# Contract tests for the Google, IMAP and SMTP stand-ins. Native build, no database.
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_TARGET_DIR:=/tmp/moss-standins}"
export CARGO_TARGET_DIR
cargo +1.95.0 test --locked --offline --manifest-path rust-spike/standins/Cargo.toml
