#!/usr/bin/env bash
# Checks the safety rules the compiler cannot see in the Rust server code (safety-core/ and
# tasks/). Prints each broken rule with the offending lines and exits 1 if any rule breaks.
#
#   rust-spike/tools/check-safety-rules.sh [rust-spike folder to check]
#
# Rules:
# 1. File access goes through the vault crate: no std::fs, tokio::fs or Path calls that touch
#    the disk.
# 2. Only tasks/src/main.rs serves files, for the built screens. ServeDir, ServeFile and the
#    rest of tower_http::services appear nowhere else. A hand-written file reply passes this
#    rule, but its disk access must still go through the vault crate (rule 1).
# 3. Secret::expose_secret is called only where a secret must be used: sealing
#    (safety-core/src/secret.rs), and signing cookies and hashing passwords (safety-core/src/auth.rs).
# 4. The server never reads the bootstrap or migration database URL, so it has no connection
#    that skips row-level security.
# 5. Only the redacting log writer (safety-core/src/http.rs) prints.
#
# Items marked #[cfg(test)] and whole-line comments are not checked. Tests build fixtures on
# disk and handle secrets on purpose. A test item ends at its first closing brace in column 0,
# or at its own line when that line ends in ";" or "}", so code after it is still checked.
set -euo pipefail
dir=${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
cd "$dir"

# Every checked line, as "file:line:text".
code() {
  local file
  find safety-core/src tasks/src -name '*.rs' | sort | while read -r file; do
    awk -v file="$file" '
      pending && /^[[:space:]]*#\[/ { next }
      pending { pending = 0; if ($0 ~ /[;}][[:space:]]*$/) next; skip = 1 }
      skip { if ($0 ~ /^}/) skip = 0; next }
      /^#\[cfg\(test\)\]/ { pending = 1; next }
      { print file ":" FNR ":" $0 }
    ' "$file"
  done | grep -Ev '^[^:]+:[0-9]+:[[:space:]]*//' || true
}

failed=0

# rule <label> <pattern> [file allowed to match]...
rule() {
  local label=$1 pattern=$2 hits allowed
  shift 2
  hits=$(code | grep -E -- "$pattern" || true)
  for allowed in "$@"; do
    hits=$(grep -v -- "^$allowed:" <<<"$hits" || true)
  done
  if [ -n "$hits" ]; then
    echo "BROKEN: $label"
    sed 's/^/  /' <<<"$hits"
    failed=$((failed + 1))
  else
    echo "ok: $label"
  fi
}

rule "1 file access goes through the vault crate" \
  '\b(std|tokio)::fs\b|std::os::unix::fs|use std::\{[^}]*\bfs\b|\bFile::(open|create)\b|\bOpenOptions\b|\.(exists|try_exists|is_file|is_dir|metadata|symlink_metadata|read_dir|read_link|canonicalize)\('
rule "2 only the start-up code serves files" '\bServe(Dir|File)\b|tower_http::services' tasks/src/main.rs
rule "3 secrets are read only where they are used" '\bexpose_secret\(' \
  safety-core/src/secret.rs safety-core/src/auth.rs
rule "4 no connection that skips row-level security" 'BOOTSTRAP_DATABASE_URL|MIGRATION_DATABASE_URL'
rule "5 every log line goes through the redacting writer" '\b(eprintln|println|eprint|print|dbg)!' \
  safety-core/src/http.rs

[ "$failed" -eq 0 ]
