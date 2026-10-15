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
