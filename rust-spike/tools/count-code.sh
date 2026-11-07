#!/usr/bin/env bash
# Counts the TypeScript and tests that the Phase 0b report scales from. Read-only.
#
#   rust-spike/tools/count-code.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

lines() { if [ -n "$1" ]; then xargs -r -d '\n' cat -- <<<"$1" | wc -l; else echo 0; fi; }
files() { if [ -n "$1" ]; then wc -l <<<"$1"; else echo 0; fi; }
pick() { grep -E -- "$2" <<<"$1" || true; }
drop() { grep -v -E -- "$2" <<<"$1" || true; }

prod=$(git ls-files -- '*.ts' '*.tsx' |
  grep -v -E '(\.test\.|\.spec\.|^tests/|/__tests__/|\.d\.ts$|^rust-spike/)')
tooling=$(pick "$prod" '^(docs|scripts|tools)/')
rest=$(drop "$prod" '^(docs|scripts|tools)/')
screens=$(pick "$rest" '\.tsx$|^apps/web/|/web/')
server=$(drop "$rest" '\.tsx$|^apps/web/|/web/')
hard_re='^packages/(chat|ai|module-registry|meetings|connectors|cli-runner|integrations|module-sdk|auth|acp|workshop)/'
hard=$(pick "$server" "$hard_re")
entry=$(pick "$server" '^apps/(api|worker)/')
other=$(drop "$(drop "$server" "$hard_re")" '^apps/(api|worker)/')

echo "production TypeScript: $(lines "$prod") lines in $(files "$prod") files"
echo "  server code: $(lines "$server")"
echo "    hard parts: $(lines "$hard")"
for name in chat ai module-registry meetings connectors cli-runner integrations module-sdk auth acp workshop; do
  echo "      $name: $(lines "$(pick "$hard" "^packages/$name/")")"
done
echo "    API and worker entry points: $(lines "$entry")"
echo "    other server code: $(lines "$other")"
echo "  screens: $(lines "$screens")"
echo "  scripts and doc tooling: $(lines "$tooling")"
css=$(git ls-files -- '*.css' | grep -v -E '^(docs|rust-spike)/' || true)
echo "CSS: $(lines "$css") lines"

it_re='^\s*(it|test)(\.each\([^)]*\))?\('
integration=$(git ls-files -- 'tests/integration/*.ts' | grep -E '\.test\.ts$' || true)
echo "integration tests: $(xargs -r -d '\n' cat -- <<<"$integration" | grep -c -E "$it_re") in $(files "$integration") files"
inject=$(xargs -r -d '\n' grep -l -F '.inject(' -- <<<"$integration" || true)
echo "  in files that call the server in-process: $(xargs -r -d '\n' cat -- <<<"$inject" | grep -c -E "$it_re") in $(files "$inject") files"
tasks=$(pick "$integration" '/task')
echo "  Tasks: $(xargs -r -d '\n' cat -- <<<"$tasks" | grep -c -E "$it_re") in $(files "$tasks") files"
echo "browser test files: $(git ls-files -- 'tests/e2e/*.spec.ts' | wc -l)"
