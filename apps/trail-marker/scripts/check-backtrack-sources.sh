#!/bin/bash
# Backtrack plan §4.5, the structural half of "one way out" (Ben, 2026-09-23): every Backtrack
# source file lives in TrailMarker/Backtrack/ and, apart from the named sink implementations,
# touches no network, no disk and no preferences directly. The only output of BacktrackRuntime is
# its BacktrackSink (and isRecording). Phase 2b (plan 2026-10-03-backtrack-phase2.md §5.1): the
# uploader may use CompanionClient and its encrypted buffer the file system; the in-memory ring and
# the Show text view stay wrapped in #if DEBUG, so a Release build never contains them.
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

# Exactly what each sink implementation needs, and nothing else.
ALLOWED=(
  "BacktrackUploader.swift:CompanionClient"
  "BacktrackBuffer.swift:FileManager"
  "BacktrackBuffer.swift:write(to:"
  "BacktrackBuffer.swift:Data(contentsOf:"
  "BacktrackBuffer.swift:FileHandle"
)

# Debug-only files: never compiled into a Release build.
DEBUG_ONLY=("BacktrackDebugRing.swift" "BacktrackTextView.swift")

FORBIDDEN=(
  "import Network" "import WebKit" "URLSession" "NSURLConnection" "CompanionClient"
  "FileManager" "FileHandle" "write(to:" "Data(contentsOf:" "UserDefaults"
)

is_debug_only() {
  local entry
  for entry in "${DEBUG_ONLY[@]}"; do
    [ "$entry" = "$1" ] && return 0
  done
  return 1
}

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
    first="$(printf '%s\n' "$code" | grep -v '^[[:space:]]*$' | sed -n '1p' | sed 's/[[:space:]]*$//')"
    last="$(printf '%s\n' "$code" | grep -v '^[[:space:]]*$' | tail -1 | sed 's/[[:space:]]*$//')"
    if is_debug_only "$name"; then
      if [ "$first" != "#if DEBUG" ]; then echo "error: $name does not start with #if DEBUG"; fail=1; fi
      if [ "$last" != "#endif" ]; then echo "error: $name does not end with #endif"; fail=1; fi
    fi
    for token in "${FORBIDDEN[@]}"; do
      is_allowed "$name" "$token" && continue
      if printf '%s\n' "$code" | grep -qF -- "$token"; then
        echo "error: $name uses $token, and Backtrack data may leave only through BacktrackSink"
        fail=1
      fi
    done
  done
  if [ "$count" -lt 5 ]; then echo "error: found only $count Backtrack sources in $dir"; fail=1; fi
  for name in "${DEBUG_ONLY[@]}"; do
    [ -e "$dir/$name" ] || { echo "error: $name is missing from $dir"; fail=1; }
  done
  return $fail
}

plant() {
  # plant <dir> <file> <label> <expected message fragment> <sed expression>
  local source="$1" file="$2" label="$3" expected="$4" expression="$5" work out
  work="$(mktemp -d)"
  cp "$source"/*.swift "$work/"
  # Portable on both the Mac build runner and Linux source-check workers. A failed
  # mutation is a harness failure, never a passing protection test.
  if ! sed "$expression" "$work/$file" > "$work/$file.tmp"; then
    rm -rf "$work"
    echo "error: self-test: could not plant $label"
    return 1
  fi
  mv "$work/$file.tmp" "$work/$file"
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
  plant "$dir" BacktrackRuntime.swift "network call" "uses URLSession" \
    's/private func publish() {/private func publish() { _ = URLSession.shared/' || exit 1
  plant "$dir" BacktrackRuntime.swift "file write" "uses FileManager" \
    's/private func publish() {/private func publish() { _ = FileManager.default/' || exit 1
  plant "$dir" BacktrackRuntime.swift "companion request" "uses CompanionClient" \
    's/private func publish() {/private func publish() { _ = CompanionClient.self/' || exit 1
  # Phase 2b: the uploader may send, but never through its own URLSession or to disk itself.
  plant "$dir" BacktrackUploader.swift "uploader network call" "uses URLSession" \
    's/func discardAll() {/func discardAll() { _ = URLSession.shared/' || exit 1
  plant "$dir" BacktrackUploader.swift "uploader file write" "uses FileManager" \
    's/func discardAll() {/func discardAll() { _ = FileManager.default/' || exit 1
  plant "$dir" BacktrackDebugRing.swift "ring without #if DEBUG" "does not start with #if DEBUG" \
    '1s/^#if DEBUG$//' || exit 1
  plant "$dir" BacktrackTextView.swift "Show text view without #if DEBUG" "does not start with #if DEBUG" \
    '1s/^#if DEBUG$//' || exit 1
  exit 0
fi

check "${1:-$default_dir}" || exit 1
echo "Backtrack sources: no way out but BacktrackSink; the ring and Show text are Debug-only."
