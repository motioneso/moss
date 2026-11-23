#!/usr/bin/env bash
set -euo pipefail
: "${RUSTUP_HOME:?Set RUSTUP_HOME explicitly}"
: "${CARGO_TARGET_DIR:?Use an isolated CARGO_TARGET_DIR}"
export CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
cargo +1.95.0 test --locked --manifest-path rust-spike/module-publisher/Cargo.toml --test phase6_registry_artifacts -- --test-threads=1
