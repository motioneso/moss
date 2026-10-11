#!/usr/bin/env bash
# Materialize only the exact official recipe; native tests use synthetic local endpoints.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/moss-constrained-claude.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$repo/packages/cli-runner/recipes/anthropic/npm-shrinkwrap.json" "$work/npm-shrinkwrap.json"
node - "$work" <<'JS'
const fs = require('node:fs');
const dir = process.argv[2];
const lock = JSON.parse(fs.readFileSync(`${dir}/npm-shrinkwrap.json`, 'utf8'));
fs.writeFileSync(`${dir}/package.json`, JSON.stringify({name: lock.name, version: lock.version, private: true, dependencies: lock.packages[''].dependencies}));
JS
npm ci --prefix "$work" --ignore-scripts --omit=dev --no-audit --no-fund
arch=$(node -p 'process.arch')
case "$arch" in x64|arm64) ;; *) echo 'Unsupported native fixture architecture' >&2; exit 1 ;; esac
binary="$work/node_modules/@anthropic-ai/claude-code-linux-$arch/claude"
test -x "$binary"
cd "$repo"
MOSS_TEST_CLAUDE_NATIVE_BINARY="$binary" node_modules/.bin/vitest run packages/chat/src/live/constrained-claude-profile.test.ts
