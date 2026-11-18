#!/usr/bin/env bash
# SQL-only Notes cases on the existing two-server harness; no Notes HTTP claim.
set -euo pipefail
cd "$(dirname "$0")/../../.."
exec bash rust-spike/parity/run-parity.sh --cases "$PWD/modules/notes/tests"
