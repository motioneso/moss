#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
[[ "${JARVIS_GATE_RUN:-}" == 1 ]] || { echo 'Refusing database work outside verify-gate' >&2; exit 4; }
pnpm exec tsx rust-spike/network/tools/live.ts
