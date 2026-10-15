#!/usr/bin/env bash
set -euo pipefail

# Credential-free probe of the installed Codex sandbox. Requires the named host
# AppArmor profile; never relaxes the container policy or mounts a host login.
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
image=${MOSS_NATIVE_SANDBOX_IMAGE:?set MOSS_NATIVE_SANDBOX_IMAGE to the candidate image}
docker run --rm -i --network none --user 200000:200000 --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --security-opt "seccomp=$repo_root/infra/security/native-sandbox-seccomp.json" \
  --security-opt apparmor=moss-native-sandbox \
  --tmpfs /sandbox-home:uid=200000,gid=200000,mode=0700 \
  --tmpfs /sandbox-outside:uid=200000,gid=200000,mode=0700 \
  --entrypoint sh "$image" -s <<'PROBE'
set -eu
export HOME=/sandbox-home
set -- /app/node_modules/.pnpm/@openai+codex@*/node_modules/@openai/codex/bin/codex.js
test "$#" -eq 1 && test -f "$1"
codex_entry=$1
node "$codex_entry" --version
test "$(cat /proc/self/attr/current)" = 'moss-native-sandbox (enforce)'
test "$(awk '/CapEff:/ { print $2 }' /proc/self/status)" = 0000000000000000
expected=$(cat /etc/hostname)
actual=$(node "$codex_entry" sandbox -- /bin/cat /etc/hostname)
test "$actual" = "$expected"
# Controls prove each denial is due to the native sandbox, not the enclosing
# container's filesystem permissions or its network-none loopback interface.
printf control > /sandbox-outside/marker
rm /sandbox-outside/marker
node -e 'require("net").createServer().listen(0,"127.0.0.1",function(){this.close()})'
if node "$codex_entry" sandbox -- /bin/sh -c 'printf denied > /sandbox-outside/marker'; then
  echo 'FAIL: native read-only policy allowed an outside write' >&2
  exit 1
fi
test ! -e /sandbox-outside/marker
if node "$codex_entry" sandbox -- node -e 'require("net").createServer().listen(0,"127.0.0.1",function(){this.close()})'; then
  echo 'FAIL: native network policy allowed a listener' >&2
  exit 1
fi
if unshare -m true; then
  echo 'FAIL: outer policy allowed a mount namespace without a user namespace' >&2
  exit 1
fi
printf 'PASS: enforced profile, zero capabilities, exact native read, denied outside write and network; controls succeeded\n'
PROBE
