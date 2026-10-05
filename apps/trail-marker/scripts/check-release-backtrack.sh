#!/bin/bash
# Backtrack phase 2 plan §5.2: a Release build contains the uploader and none of the Debug-only
# preview (the in-memory ring, the Debug sink that feeds it, the Show text window).
#
#   check-release-backtrack.sh "<path to Release Trail Marker.app>/Contents/MacOS/Trail Marker"
set -u
binary="${1:?usage: check-release-backtrack.sh <Release binary>}"
symbols="$(nm "$binary" 2>/dev/null)" || { echo "error: can't read symbols from $binary"; exit 1; }
fail=0
if ! printf '%s\n' "$symbols" | grep -q "BacktrackUploader"; then
  echo "error: the Release build has no BacktrackUploader"; fail=1
fi
for name in BacktrackDebugRing BacktrackDebugTee BacktrackTextView; do
  if printf '%s\n' "$symbols" | grep -q "$name"; then
    echo "error: the Release build contains $name, which is Debug-only"; fail=1
  fi
done
[ $fail -eq 0 ] && echo "Release Backtrack: uploader present; no Debug-only preview."
exit $fail
