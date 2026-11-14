#!/usr/bin/env bash
# Runs the browser port proof. Needs MOSS_BROWSER_DIR (see fetch-chrome.sh) and bubblewrap.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo test --locked --features browser-proof --test browser_port -- --ignored --test-threads=1 --nocapture "$@"
