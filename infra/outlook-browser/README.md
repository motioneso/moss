# Managed Outlook runtime primitives

Internal implementation for #3570 / draft PR #3571. **Not an installable browser service.**
Do not enable managed setup or point it at a real account from these files alone.
The existing operator-bound collector is unchanged.

```text
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
This is not yet proof of recovery from a hard host-service crash with an orphaned engine process.

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

- Private host broker transport, singleton service, hardened service definition and installer.
- Service-cgroup termination/startup recovery proof for orphaned in-flight Podman operations.
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

This runs 21 tests plus four guard-removal checks against temporary copies of the actual source.
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

The observed Python fixture manifest digest was
`sha256:884d3f3d9b4ef25b050f984ca8781efd6b0f49312721d2c321536b7cecf1c224`.
It is pinned in the engine fixture build. It is not a production browser image.
