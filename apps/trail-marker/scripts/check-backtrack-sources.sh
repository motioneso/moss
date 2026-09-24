#!/bin/bash
# Backtrack plan §4.5, the structural half of "one way out" (Ben, 2026-09-23): every Backtrack
# source file lives in TrailMarker/Backtrack/, is wrapped in #if DEBUG, and, apart from the named
# sink implementations, touches no network, no disk and no preferences directly. The only output
# of BacktrackRuntime is its BacktrackSink (and isRecording).
#
# Run by the TrailMarkerTests target as a build phase, so every test run (local and CI) checks it.
# It is a script rather than a unit test because the test host app reading sources under the
# checkout would trigger a macOS privacy prompt that blocks the run.
#
#   check-backtrack-sources.sh [dir]     check the real sources (default) or another folder
#   check-backtrack-sources.sh --self-test   prove the check fails on planted violations
set -u

script_dir="$(cd "$(dirname "$0")" && pwd)"
default_dir="$script_dir/../TrailMarker/Backtrack"

# Phase 1's sink (the in-memory Debug ring) needs none of the forbidden APIs, so nothing is exempt.
# Phase 2b adds its uploader here with exactly what it needs, e.g. "BacktrackUploader.swift:CompanionClient".
ALLOWED=()

FORBIDDEN=(
  "import Network" "import WebKit" "URLSession" "NSURLConnection" "CompanionClient"
  "FileManager" "FileHandle" "write(to:" "Data(contentsOf:" "UserDefaults"
)

is_allowed() {
  local entry
  for entry in ${ALLOWED[@]+"${ALLOWED[@]}"}; do
    [ "$entry" = "$1:$2" ] && return 0
  done
  return 1
}

check() {
  local dir="$1" fail=0 count=0 file name code first last token
  for file in "$dir"/*.swift; do
    [ -e "$file" ] || continue
    count=$((count + 1))
    name="$(basename "$file")"
    # Comments are not code: a doc comment may name what the file must never do.
    code="$(grep -v '^[[:space:]]*//' "$file")"
    first="$(printf '%s\n' "$code" | grep -v '^[[:space:]]*$' | head -1 | sed 's/[[:space:]]*$//')"
    last="$(printf '%s\n' "$code" | grep -v '^[[:space:]]*$' | tail -1 | sed 's/[[:space:]]*$//')"
    if [ "$first" != "#if DEBUG" ]; then echo "error: $name does not start with #if DEBUG"; fail=1; fi
    if [ "$last" != "#endif" ]; then echo "error: $name does not end with #endif"; fail=1; fi
    for token in "${FORBIDDEN[@]}"; do
      is_allowed "$name" "$token" && continue
      if printf '%s\n' "$code" | grep -qF -- "$token"; then
        echo "error: $name uses $token, and Backtrack data may leave only through BacktrackSink"
        fail=1
      fi
    done
  done
  if [ "$count" -lt 5 ]; then echo "error: found only $count Backtrack sources in $dir"; fail=1; fi
  return $fail
}

plant() {
  # plant <dir> <label> <expected message fragment> <sed expression>
  local source="$1" label="$2" expected="$3" expression="$4" work out
  work="$(mktemp -d)"
  cp "$source"/*.swift "$work/"
  sed -i '' "$expression" "$work/BacktrackRuntime.swift"
  out="$(check "$work")"
  local status=$?
  rm -rf "$work"
  if [ $status -eq 0 ] || ! printf '%s\n' "$out" | grep -qF -- "$expected"; then
    echo "error: self-test: the check did not catch a planted $label"
    return 1
  fi
  echo "self-test: planted $label was caught"
}

if [ "${1:-}" = "--self-test" ]; then
  dir="$default_dir"
  check "$dir" > /dev/null || { echo "error: self-test: the real sources do not pass"; exit 1; }
  plant "$dir" "network call" "uses URLSession" \
    's/private func publish() {/private func publish() { _ = URLSession.shared/' || exit 1
  plant "$dir" "file write" "uses FileManager" \
    's/private func publish() {/private func publish() { _ = FileManager.default/' || exit 1
  plant "$dir" "missing #if DEBUG" "does not start with #if DEBUG" '1s/^#if DEBUG$//' || exit 1
  exit 0
fi

check "${1:-$default_dir}" || exit 1
echo "Backtrack sources: Debug-only, and no way out but BacktrackSink."
