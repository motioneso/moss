#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Use scripts/run-gate.sh' >&2; exit 4; }
: "${CARGO_HOME:?Use task-owned Rust directories}"
: "${RUSTUP_HOME:?Use task-owned Rust directories}"
: "${CARGO_TARGET_DIR:?Use task-owned Rust directories}"
cargo +1.95.0 build --offline --locked --manifest-path rust-spike/shell/Cargo.toml -p moss-shell -p moss-app
cargo +1.95.0 build --offline --locked --manifest-path rust-spike/network/Cargo.toml --bin moss-network
pnpm exec tsx rust-spike/shell/tools/click-live.ts
