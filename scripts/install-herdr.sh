#!/usr/bin/env bash
set -euo pipefail

# Installs the Herdr terminal-multiplexer binary into the persistent CLI-tools volume so it
# survives container replacement (see infra/docker-compose.prod.yml: JARVIS_CLI_TOOLS_PREFIX is
# bind-mounted to the jarv1s-cli-tools named volume). Runnable by a host operator directly, and by
# the fixed, argument-free executor behind POST /api/admin/host/install (spec
# 2026-07-15-993-host-truth.md) — that route invokes this exact script via execFile with no
# request-derived args, never a shell string. Mechanics below are unchanged either way.
#
# Per-arch release artifacts and their SHA-256 checksums are pinned here rather than resolved at
# install time, so a compromised or yanked upstream release can't silently swap the binary.
HERDR_VERSION="v0.8.2"
HERDR_REPO="herdrdev/herdr"
INSTALL_PREFIX="${JARVIS_CLI_TOOLS_PREFIX:-/data/cli-tools}"
INSTALL_DIR="${INSTALL_PREFIX}/bin"
INSTALL_PATH="${INSTALL_DIR}/herdr"

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64)
    ASSET="herdr-linux-x86_64"
    EXPECTED_SHA256="976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4"
    ;;
  aarch64|arm64)
    ASSET="herdr-linux-aarch64"
    EXPECTED_SHA256="f55610658e1c2e0d2aaef730b4b2ab885f7f8ba00285ab372bfb14f2e3d5b40d"
    ;;
  *)
    echo "install-herdr: unsupported architecture '${arch}'" >&2
    exit 1
    ;;
esac

DOWNLOAD_URL="https://github.com/${HERDR_REPO}/releases/download/${HERDR_VERSION}/${ASSET}"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Idempotent: skip re-download if the installed binary's hash already matches the pinned checksum.
if [ -x "$INSTALL_PATH" ]; then
  existing_sha256="$(sha256_of "$INSTALL_PATH")"
  if [ "$existing_sha256" = "$EXPECTED_SHA256" ]; then
    echo "install-herdr: ${INSTALL_PATH} already matches ${HERDR_VERSION} (sha256 ${EXPECTED_SHA256}); nothing to do"
    exit 0
  fi
fi

mkdir -p "$INSTALL_DIR"
tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

# No curl/wget in the runtime image (only tmux git ca-certificates bubblewrap via apt-get) —
# fetch with Node's built-in https module instead.
node --input-type=module -e "
import { createWriteStream } from 'node:fs';
import { get } from 'node:https';
import { pipeline } from 'node:stream/promises';

function fetchFollowingRedirects(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error('too many redirects'));
        res.resume();
        return resolve(fetchFollowingRedirects(res.headers.location, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('unexpected status ' + res.statusCode + ' fetching ' + url));
      }
      resolve(res);
    }).on('error', reject);
  });
}

const res = await fetchFollowingRedirects('${DOWNLOAD_URL}');
await pipeline(res, createWriteStream('${tmp_file}'));
"

actual_sha256="$(sha256_of "$tmp_file")"
if [ "$actual_sha256" != "$EXPECTED_SHA256" ]; then
  echo "install-herdr: checksum mismatch for ${ASSET} (expected ${EXPECTED_SHA256}, got ${actual_sha256}); aborting" >&2
  exit 1
fi

mv "$tmp_file" "$INSTALL_PATH"
chmod +x "$INSTALL_PATH"
trap - EXIT

echo "install-herdr: installed herdr ${HERDR_VERSION} (${ASSET}) to ${INSTALL_PATH}"
