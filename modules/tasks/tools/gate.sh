#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ "${JARVIS_GATE_RUN:-}" != 1 ]]; then
  echo 'Refusing database work outside scripts/run-gate.sh' >&2
  exit 4
fi
tasks_build_dir="$(mktemp -d "${TMPDIR:-/tmp}/moss-tasks-component.XXXXXX")"
trap 'rm -rf "$tasks_build_dir"' EXIT
modules/tasks/tools/build-component.sh "$tasks_build_dir/module.wasm"
export TASKS_COMPONENT="$tasks_build_dir/module.wasm"
cargo +1.95.0 test --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --test component --test metadata --test tool_services
cargo +1.95.0 build --locked --offline --manifest-path modules/tasks/tools/Cargo.toml --bin tasks-domain-check
TASKS_SCREEN_BIN="${CARGO_TARGET_DIR:-$PWD/modules/tasks/tools/target}/debug/tasks-domain-check" \
  node --test modules/tasks/ui/*.test.mjs
pnpm exec tsx modules/tasks/tools/view-parity.mjs
pnpm exec tsx modules/tasks/tools/capture-parity.mjs
pnpm exec tsx modules/tasks/tools/filter-parity.mjs
pnpm exec tsx modules/tasks/tools/gate.ts
