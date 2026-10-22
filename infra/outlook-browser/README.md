# Managed Outlook host foundations

Internal implementation for #3570 / draft PR #3571. **Not an installable browser service.**
Do not enable managed setup or point it at a real account from these files alone.
The existing operator-bound collector is unchanged.

```text
private Unix lifecycle broker (broker.py / service.py)
  trusted app/worker UID checked with SO_PEERCRED
  allocate/remove only; runtime ID + generation, bounded JSON line
Runtime.allocate/remove
  Inventory: durable SQLite state and permanent removal tombstones
  Egress: one private Unix CONNECT socket per runtime
  Podman: fixed rootless container/profile operations

planned browser network namespace (network=none)
  loopback relay (proxy.py) → runtime's Unix socket → public TCP 443
```

The inventory contains opaque runtime IDs, generation and lifecycle state only. Its directory
must be owner-owned mode 0700 and its database mode 0600. Removal commits a tombstone before
revoking egress or deleting the container/profile. Failed removal stays pending and blocks reuse.
Request cancellation drains an in-flight engine operation before releasing its inventory lock.
The broker holds a permanent-file singleton lock. Each engine command has an external supervisor
that retains the lock until the command exits; Podman itself receives no lock descriptor. Direct
inheritance into Podman was tested and rejected because a detached monitor retained the descriptor,
preventing normal broker restart. A timed-out supervisor requests broker shutdown through its
parent's pidfd and drains the command; it never frees the lock by killing only the engine CLI.
The service unit terminates the old service cgroup before restarting. Startup retries pending
removals before restoring allocated runtime sockets, and listens after that recovery pass.
An individual failure keeps that runtime pending with egress closed; it does not acknowledge
removal or prevent other owners' runtime restoration. Worker retries or later allocation can
retry failed operations. The application's cleanup scheduler remains unwired.
Actual hard-crash tests with Podman and Chromium remain required; the cgroup proof uses an
external-engine stand-in, as described below.

The engine takes an installed immutable image ID, a reviewed seccomp file and a private transport
root from trusted installation configuration. Clients cannot supply any of those values. Containers
use a read-only root, no network, no added capabilities, no-new-privileges, bounded resources and
disabled container logging. Resource labels are checked before reusing/removing a container or
volume. Chromium sandbox readiness and the maintained browser image are still pending.

Egress accepts bounded HTTP/1.1 CONNECT authorities on port 443, rejects special-use IPv4/IPv6
and configured infrastructure networks, rejects mixed private/public DNS answers, and connects to
a validated numeric address without a second hostname lookup. Each tunnel is limited to five
minutes and 60 seconds idle; each runtime has at most 64 active tunnels. Revocation closes active
tunnels. TLS remains end-to-end between the client and remote service; this code does not decrypt
the tunnel. Public HTTPS servers are not restricted to Microsoft, allowing federated sign-in.

**Remaining release blockers:**

- Installer, deployment mounts/UID mapping and host-service hardening on supported installations.
- Hard-crash/removal proof with actual Podman operations and the production Chromium image.
- Populate/refresh the denied infrastructure networks, including the server's public addresses
  and the app's public ingress; the special-use deny list alone does not identify those.
- Maintained pinned Chromium image, actual browser proxy configuration, sandbox diagnostics on
  both architectures, redirect/IPv6/rebinding browser tests, and no alternate network route.
- Authenticated viewer/collector leases, real session revocation, user setup, account confirmation,
  calendar import/removal and app-map/UI/deployment integration from the approved build spec.
- Real Microsoft sign-in/MFA, two-user live UI proof and empty-install/update/uninstall evidence.

## Reproduce the checks

From `~/Jarv1s`, Python 3.12+:

```sh
pnpm test:outlook-runtime
```

This runs 36 tests plus eleven guard-removal checks against temporary copies of the actual source.
CI runs the same command. No database, browser, credentials or network access is needed.

Optional real rootless Podman proofs use a **Python fixture**, not a browser or real account:

```sh
podman pull docker.io/library/python:3.12-alpine3.23
PYTHONPATH=infra/outlook-browser python3 -B infra/outlook-browser/tests/verify_network.py
PYTHONPATH=infra/outlook-browser python3 -B infra/outlook-browser/tests/verify_network.py --negative-control
PYTHONPATH=infra/outlook-browser python3 -B infra/outlook-browser/tests/verify_engine.py
```

The network proof makes a public Microsoft HTTPS HEAD request with normal certificate checks. It
checks direct IPv4/IPv6 failure and 11 denied proxy destinations. Its negative control substitutes
rootless networking and requires observing direct networking become available. The engine proof
builds a disposable sleeping Python image, uses two actual containers/profile volumes, checks
separate persisted markers and idempotent allocation, removes one container and volume, restarts
the inventory and checks the tombstone while the other runtime stays intact. Helpers remove their
own containers, volumes and fixture image tags. The pulled base image remains local.
The engine proof also releases/reacquires the singleton lock while the second real container
remains running, proving the detached monitor does not retain it through the supervisor path.

With a working Linux user-systemd bus, run the real lifecycle service crash test:

```sh
python3 -B infra/outlook-browser/tests/verify_service.py
python3 -B infra/outlook-browser/tests/verify_service.py --negative-control
```

This starts a disposable user unit using the checked-in service properties and real broker
entrypoint, with a disclosed executable stand-in for a slow external engine. Killing the main
broker must terminate that operation, restart, recover its allocating record and accept removal
only after fixture resources disappear. The negative control changes only KillMode to process
and observes the orphan make a late creation after broker death. Units and fixture files are
removed afterwards. This does not establish actual Podman/container cgroup behavior.

## Internal service configuration

`service.py --config <trusted-json-file>` reads exactly `state`, `transport`, `socket`, `image`,
`seccomp`, `allowed_uid`, `socket_gid` and `denied_networks`. Paths are absolute installation
configuration, never client arguments. The file must be a regular non-symlink, owned by the
service account or root, with no group/other write permission. State/transport directories are
service-owned 0700. The socket's parent must already be service-owned 0750 with socket_gid;
the socket is 0660 and Linux peer credentials must match allowed_uid. API and worker need the
documented matching host UID and group when the installer/deployment seam is implemented.

The user unit targets a dedicated non-root runtime account and is separate from the legacy
browser service. It is a delivery template, not enabled by this change. Host NoNewPrivileges is
not set because rootless Podman needs newuidmap/newgidmap; container no-new-privileges remains
enforced. A nonempty explicit deny list is required, but that alone cannot discover the host's
public addresses or application ingress. Automatic infrastructure policy discovery/refresh is
still a hard release blocker. Never enable real sign-in from this foundation alone.

The lifecycle socket grants trusted API/worker processes access to runtime references. It does
not authenticate Moss users, bind browser sessions or authorize viewer/collector leases. Those
checks and the remaining fixed browser operations must be implemented at their approved seams.

The observed Python fixture manifest digest was
`sha256:884d3f3d9b4ef25b050f984ca8781efd6b0f49312721d2c321536b7cecf1c224`.
It is pinned in the engine fixture build. It is not a production browser image.
