#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
image=${MOSS_NATIVE_SANDBOX_IMAGE:?set MOSS_NATIVE_SANDBOX_IMAGE to the candidate image}
volume_name="moss-native-vault-probe-$$"
docker volume create "$volume_name" >/dev/null
trap 'docker volume rm "$volume_name" >/dev/null' EXIT
# Model startup followed by the seed service mounting an otherwise empty vault.
# Docker copies the image directory mode again while the volume is empty.
docker run --rm --network none --user 1000:1000 --cap-drop ALL \
  --entrypoint sh -v "$volume_name:/data/vaults" "$image" \
  -c 'chmod 711 /data/vaults'
docker run --rm -i --network none --cap-drop ALL \
  --cap-add CHOWN --cap-add SETUID --cap-add SETGID --cap-add FOWNER \
  --security-opt no-new-privileges:true \
  --security-opt "seccomp=$repo_root/infra/security/native-sandbox-seccomp.json" \
  --security-opt apparmor=moss-native-sandbox \
  --tmpfs /sandbox-home:uid=100001,gid=100001,mode=0700 \
  -v "$volume_name:/data/vaults" \
  --entrypoint sh "$image" -s <<'PROBE'
set -eu
test "$(stat -c %a /data/vaults)" = 711 || {
  echo 'FAIL: mounting the empty shared volume restored a writable vault parent' >&2; exit 1
}
mkdir -p /data/vaults
chown 1000:1000 /data/vaults
as_app() { setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all --ambient-caps=-all -- "$@"; }
as_owner() { setpriv --reuid=100001 --regid=100001 --clear-groups --inh-caps=-all --ambient-caps=-all -- "$@"; }
as_foreign() { setpriv --reuid=100002 --regid=100002 --clear-groups --inh-caps=-all --ambient-caps=-all -- "$@"; }
as_app node_modules/.bin/tsx -e '
import {VaultContextRunner, writeVaultFile} from "./packages/vault/src/index.ts";
void (async()=> { const runner=new VaultContextRunner("/data/vaults");
for(const actorUserId of ["owner","foreign"]) await runner.withVaultContext({actorUserId},ctx=>writeVaultFile(ctx,"proof.md",actorUserId+"-synthetic-proof")); })();'
if as_owner cat /data/vaults/owner/proof.md; then
  echo 'FAIL: owner native account could read private vault before grant' >&2; exit 1
fi
as_app node --import tsx packages/cli-runner/src/native-vault-prepare.ts owner 100001
if as_foreign mv /data/vaults/owner /data/vaults/stolen; then echo 'FAIL: foreign account replaced owner root' >&2; exit 1; fi
test "$(as_owner cat /data/vaults/owner/proof.md)" = owner-synthetic-proof
if as_owner cat /data/vaults/foreign/proof.md; then echo 'FAIL: foreign vault readable' >&2; exit 1; fi
if as_foreign cat /data/vaults/owner/proof.md; then echo 'FAIL: foreign account read owner vault' >&2; exit 1; fi
if as_owner sh -c 'echo overwrite > /data/vaults/owner/proof.md'; then echo 'FAIL: file writable' >&2; exit 1; fi
if as_owner touch /data/vaults/owner/created; then echo 'FAIL: directory writable' >&2; exit 1; fi
as_app ln -s /data/vaults/foreign /data/vaults/owner/foreign-link
as_app node --import tsx packages/cli-runner/src/native-vault-prepare.ts owner 100001
if as_owner cat /data/vaults/owner/foreign-link/proof.md; then echo 'FAIL: linked foreign vault readable' >&2; exit 1; fi
export HOME=/sandbox-home
set -- /app/node_modules/.pnpm/@openai+codex@*/node_modules/@openai/codex/bin/codex.js
test "$#" -eq 1
test "$(as_owner node "$1" sandbox -- cat -- /data/vaults/owner/proof.md)" = owner-synthetic-proof
test "$(as_app cat /data/vaults/owner/proof.md)" = owner-synthetic-proof
printf 'PASS: exact owner native read; pre-grant, foreign reads, native writes, linked foreign read denied; app write authority retained\n'
PROBE
