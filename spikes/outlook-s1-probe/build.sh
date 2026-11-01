#!/bin/sh
# Builds the probe image from a temporary context holding the candidate's files.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
cp "$repo/infra/outlook-browser/proxy.py" "$repo/infra/outlook-browser/image/policy.json" \
   "$here/runner.py" "$here/Containerfile" "$ctx/"
podman build -q -t localhost/moss-outlook-s1:probe -f "$ctx/Containerfile" "$ctx"
