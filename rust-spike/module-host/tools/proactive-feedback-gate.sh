#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ "${JARVIS_GATE_RUN:-}" != 1 ]]; then
  echo 'Refusing database work outside scripts/run-gate.sh' >&2
  exit 4
fi
# The pure rules natively and in WebAssembly, then the database proof with TypeScript in the loop.
cargo +1.95.0 test --locked --offline --manifest-path rust-spike/Cargo.toml -p usefulness-rules
cargo +1.95.0 build --locked --offline --release --manifest-path rust-spike/Cargo.toml -p usefulness-rules --target wasm32-unknown-unknown
target_dir="$(cargo +1.95.0 metadata --offline --format-version 1 --manifest-path rust-spike/Cargo.toml | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
USEFULNESS_RULES_WASM="$target_dir/wasm32-unknown-unknown/release/usefulness_rules.wasm" \
  cargo +1.95.0 test --locked --offline --manifest-path rust-spike/module-host/Cargo.toml --test usefulness_rules_wasm -- --include-ignored --nocapture
pnpm exec tsx rust-spike/module-host/tools/proactive-feedback-gate.ts
