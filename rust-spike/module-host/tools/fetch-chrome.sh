#!/usr/bin/env bash
# Fetches the pinned Chrome for Testing build into DEST and writes the pin marker.
# Usage: fetch-chrome.sh DEST [ZIP]. With ZIP, uses that file instead of downloading.
# The version and checksum must match browser/launch.rs. Nothing is installed system-wide.
set -euo pipefail
VERSION="157.0.8103.78"
SHA256="9223832977a13db3646201b1341c1f9cf08afa3ceae92540116d7b0c062364fb"
dest="${1:?destination folder}"
zip="${2:-}"
mkdir -p "$dest"
work="$(mktemp -d "$dest/.fetch.XXXXXX")"
trap 'rm -rf "$work"' EXIT
if [ -z "$zip" ]; then
  zip="$work/chrome-linux64.zip"
  curl -fsSL -o "$zip" "https://storage.googleapis.com/chrome-for-testing-public/$VERSION/linux64/chrome-linux64.zip"
fi
echo "$SHA256  $zip" | sha256sum --check --status || { echo "Checksum mismatch, refusing to unpack" >&2; exit 1; }
rm -rf "$dest/chrome-linux64"
unzip -q "$zip" -d "$dest"
printf '%s %s\n' "$VERSION" "$SHA256" > "$dest/.moss-pin"
echo "Browser $VERSION ready in $dest"
