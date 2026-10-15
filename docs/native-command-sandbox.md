# Native commands in restricted Linux deployments

Codex's Linux command runner uses bubblewrap and seccomp. Installing bubblewrap alone does not
make it work inside Docker: Docker's default syscall policy blocks namespace creation, and the
default AppArmor profile blocks bubblewrap's mount setup. The legacy Landlock mode cannot isolate
app-server sockets and is not a replacement for filesystem-restricted commands.

The supported Linux configuration below retains the production capability list and
`no-new-privileges`. It adds a named, enforced AppArmor profile and a syscall profile based on
Moby v24.0.7's default. It does not grant `SYS_ADMIN`, use a privileged container, disable host
AppArmor restrictions, or use an unconfined profile. Existing deployments keep their current
configuration until the operator explicitly applies the overlay. No production deployment is
part of #3514's verification work.

## Container setup

From `~/Jarv1s`, review `infra/security/moss-native-sandbox.apparmor` and
`infra/security/native-sandbox-seccomp.json`. On an AppArmor-enabled Linux host with ABI 4.0
support, install the named profile once:

```sh
sudo install -m 644 infra/security/moss-native-sandbox.apparmor /etc/apparmor.d/moss-native-sandbox
sudo apparmor_parser -r /etc/apparmor.d/moss-native-sandbox
```

Load it again after changing the profile. Keep the file installed so the host loads it after a
reboot. On a host without AppArmor support, do not replace it with `apparmor=unconfined`; this
configuration has not been verified there.

Apply the overlay after production Compose, retaining any other deployment overlays:

```sh
docker compose -p moss -f infra/docker-compose.prod.yml \
  -f infra/docker-compose.native-sandbox.yml \
  --env-file infra/env.production.local up -d --no-build
```

The syscall JSON path resolves relative to the first Compose file's directory. The overlay
changes only the `jarv1s` service's security options. Database and renderer services retain their
base policies. A missing host profile or invalid syscall profile refuses container creation;
there is no permissive fallback. Installing the profile alone does not change running services.

For the disposable installed harness, set `MOSS_NATIVE_SANDBOX=1` together with the normal UAT
variables. The provisioner applies this same overlay for every lifecycle operation; the real
#3065 wrapper's explicit login-use preflight remains required. No scenario assertion changes.

## Development runner

The development CLI runner is a host system service, not the development API container. Install
bubblewrap using the distribution package and load the same AppArmor profile. Copy
`infra/systemd/jarv1s-dev-cli-runner-native-sandbox.conf` to
`/etc/systemd/system/jarv1s-dev-cli-runner.service.d/native-sandbox.conf`, then reload systemd and
restart that service. Keep the base unit's capability bounds and `NoNewPrivileges=true`.
The Docker syscall JSON applies only to containers; do not attach it to the host service.

## Private owner vault access

The overlay also sets `MOSS_NATIVE_VAULT_READS=1` on the supervisor's CLI-runner child. This is
separate from namespace setup: the app owns private vault directories and files, while native
commands run as a different, stable account for each person. Namespace setup alone cannot make
that account read an app-owned `0700` directory or `0600` file.

Before forwarding an ACP line, the runner serializes a metadata preparation step as the vault
service account, dropping all capabilities. Through `VaultContext`, it grants the authenticated
session owner's stable CLI UID read/traverse access to that owner's subtree under `/data/vaults`.
The shared parent grants traversal only. Group and other entries within the subtree stay empty;
existing foreign/default ACLs, hardlinked files, symlink ancestors, unexpected ownership/types,
more than 10,000 entries, or a 30-second timeout refuse preparation. Child symlinks are skipped.
Non-sticky ancestors writable by another account also refuse preparation. Container startup
sets the shared vault parent to `0711`, so isolated accounts cannot replace another owner's root.
The image directory also starts at `0711`: Docker can copy its mode again when another service
mounts an otherwise empty shared volume, after the main service has already initialized it.
The service account remains the trusted filesystem writer; this is not protection from a hostile
app process concurrently changing its own directory entries. No file contents reach the launcher.

The image includes the `acl` utilities. The grant is refreshed before each line because an app
write's `0600` chmod can mask an existing read grant. Grants remain assigned to stable person
UIDs, which are not recycled; deleting a user's vault removes its grants with the files. Turning
the opt-in off stops preparation, but does not erase existing ACLs. To revoke those grants, stop
the affected CLI sessions, then have the vault service account remove the specific named-user
entries using `setfacl -x u:UID` on that owner's subtree. Do not clear unrelated ACLs blindly.

If preparation refuses, inspect metadata as the vault service account. Correct unexpected ACLs
or links through the normal vault administration process, or keep native private-vault access
disabled; never make private files world-readable or share one CLI UID. The shared vault parent
must already permit traversal (the container's normal parent does); its ACL mask is preserved.
The host development sandbox drop-in enables namespace support only. Opting a host runner into
private-vault reads additionally requires `acl`, the same `/data/vaults` service-account topology
and `MOSS_NATIVE_VAULT_READS=1`; other host vault layouts are not covered by this opt-in.

## Policy and verification

The syscall delta permits mount setup, pivot-root and unmount operations, a final user-namespace
unshare, and clone calls requiring a new user namespace while excluding new cgroup namespaces.
It retains Docker's other syscall rules, including its clone3 fallback behavior. AppArmor permits
mount operations only at bubblewrap's temporary root construction paths, root propagation and
its device setup paths, retaining Docker's proc/sys write denials and signal/ptrace rules.
The kernel's namespace boundaries and unchanged outer capability bounds remain necessary parts
of this configuration; these profiles are not a general-purpose host command sandbox.

Upstream base files:

- https://github.com/moby/moby/blob/v24.0.7/profiles/seccomp/default.json
- https://github.com/moby/moby/blob/v24.0.7/profiles/apparmor/template.go

Their Apache-2.0 license is retained in `infra/security/LICENSE.moby`.

After building the candidate image, run the credential-free probe:

```sh
MOSS_NATIVE_SANDBOX_IMAGE=ghcr.io/motioneso/moss:CANDIDATE \
  tests/scripts/test-native-sandbox.sh
```

It checks the enforced label, zero effective capabilities, a real native read, and refused
out-of-workspace writes and network listeners. Unsandboxed, credential-free control operations
must succeed first so a container permission failure cannot masquerade as sandbox enforcement.
This probe does not replace the complete installed real-provider scenario, automatic recall,
approval/deletion/authority checks, or the separate clean automatic-execution requirements.

If a model reports namespace or mount failure, check the applied container security options,
loaded profile name and exact image/CLI identity. Preserve the failed receipt and correct the
host configuration; do not disable policy or ask the model to retry without its sandbox.
