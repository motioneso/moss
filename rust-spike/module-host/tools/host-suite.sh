#!/usr/bin/env bash
# Runs the host crate's own tests. The plaid_probe target is left out because it needs the
# axum crate, which this crate does not declare, so it does not compile here.
set -euo pipefail
cd "$(dirname "$0")/../../.."
tests=()
for f in rust-spike/module-host/tests/*.rs; do
  name="$(basename "$f" .rs)"
  [[ "$name" == plaid_probe ]] || tests+=(--test "$name")
done
cargo +1.95.0 test --locked --offline --manifest-path rust-spike/module-host/Cargo.toml --lib "${tests[@]}"
