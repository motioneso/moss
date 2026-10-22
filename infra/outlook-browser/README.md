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

candidate Chromium network namespace (network=none)
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
The account-free candidate-image proof below now covers actual Podman/Chromium crash boundaries
after creation and container removal, before acknowledgment. Crashes inside arbitrary engine or
storage operations remain unverified; the earlier cgroup proof uses an external-engine stand-in.

The engine takes an installed immutable image ID, a reviewed seccomp file and a private transport
root from trusted installation configuration. Clients cannot supply any of those values. Containers
use a read-only root, no network, no added capabilities, no-new-privileges, bounded resources and
disabled container logging. Resource labels are checked before reusing/removing a container or
volume. Native candidate-browser checks are described below. Image maintenance and full browser
network acceptance on both supported architectures remain release blockers.

Egress accepts bounded HTTP/1.1 CONNECT authorities on port 443, rejects special-use IPv4/IPv6
and configured/discovered infrastructure networks, rejects mixed private/public DNS answers, and connects to
a validated numeric address without a second hostname lookup. Each tunnel is limited to five
minutes and 60 seconds idle; each runtime has at most 64 active tunnels. Revocation closes active
tunnels. TLS remains end-to-end between the client and remote service; this code does not decrypt
the tunnel. Public HTTPS servers are not restricted to Microsoft, allowing federated sign-in.

**Remaining release blockers:**

- Installer, deployment mounts/UID mapping and host-service hardening on supported installations.
- Crash coverage inside actual engine/storage operations beyond the tested acknowledgment
  boundaries, and repetition against the maintained release image on supported hosts.
- Installer delivery of complete public host/NAT and application ingress names/CIDRs, and
  browser acceptance against those deployed addresses. Host-policy discovery/refresh is implemented
  below; local interfaces alone cannot identify external NAT or reverse proxies.
- Browser security-update delivery and release review, remaining managed-policy behavior coverage,
  ARM64 sandbox diagnostics, redirect/rebinding tests, public IPv6 and alternate-route browser proof.
- Authenticated viewer/collector leases, real session revocation, user setup, account confirmation,
  calendar import/removal and app-map/UI/deployment integration from the approved build spec.
- Real Microsoft sign-in/MFA, two-user live UI proof and empty-install/update/uninstall evidence.

## Reproduce the checks

From `~/Jarv1s`, Python 3.12+:

```sh
pnpm test:outlook-runtime
```

This runs 55 tests plus 32 guard-removal checks against temporary copies of the actual source.
CI runs the same command. No database, browser, credentials or network access is needed.

The account-free native host-policy proof uses real interface discovery, DNS, Unix CONNECT and
public TLS, with no browser or container:

```sh
PYTHONPATH=infra/outlook-browser python3 -B infra/outlook-browser/tests/verify_infrastructure.py
```

It first verifies ordinary Microsoft HTTPS with certificate checks. It then deliberately classifies
that public endpoint as an application-ingress stand-in, closes an existing CONNECT, and checks
hostname and resolved IPv4/IPv6 literal denial. Omitting the infrastructure policy must fail the
same denial assertion on the reachable endpoint. No actual Moss ingress, account or deployment is
used. Unit tunnel fixtures use real Unix proxy/echo sockets with disclosed DNS/upstream stand-ins;
they exercise failed refresh, expiry without another request, DNS rotation, unchanged refresh,
history exhaustion and service/runtime binding. The independent generation-barrier tests suppress
proactive tunnel closure deliberately; separate tests require actual closure/cancellation.

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

To test actual rootless Podman and the candidate Chromium image, build the candidate below, then:

```sh
PYTHONPATH=infra/outlook-browser python3 -B infra/outlook-browser/tests/verify_podman_service.py --image sha256:<reported-image-id>
PYTHONPATH=infra/outlook-browser python3 -B infra/outlook-browser/tests/verify_podman_service.py --image sha256:<reported-image-id> --negative-control
```

These start disposable user units with the real service properties, entrypoint, engine and image.
A disclosed test-only PATH wrapper delegates to the actual Podman binary, pausing after successful
`run` or `rm`, before returning completion to the broker. SIGKILL must recover the allocating record
and profile marker, or finish deleting the remaining volume from the removing record before the
broker listens again. Both cases check the other runtime's marker. Image source bytes and actual
Chromium sandbox diagnostics are checked. The negative control changes only KillMode to process,
pauses before a real `run`, observes the positive cgroup assertion fail, then allows that orphan to
create candidate Chromium after broker death. This establishes deterministic operation-boundary
recovery, not every possible crash within Podman's storage operations. No real account is used.
Containers, volumes, units and barrier files are removed; the supplied image remains installed.
Use `--engine-root` and `--engine-runroot` together to select a separate test store consistently.
The test requires a working user-systemd bus; terminals without session variables can set
`XDG_RUNTIME_DIR=/run/user/$(id -u)` and
`DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus` before running it.

## Internal service configuration

`service.py --config <trusted-json-file>` reads exactly `state`, `transport`, `socket`, `image`,
`seccomp`, `allowed_uid`, `socket_gid`, `denied_networks` and `infrastructure_hosts`. Paths are absolute installation
configuration, never client arguments. The file must be a regular non-symlink, owned by the
service account or root, with no group/other write permission. State/transport directories are
service-owned 0700. The socket's parent must already be service-owned 0750 with socket_gid;
the socket is 0660 and Linux peer credentials must match allowed_uid. API and worker need the
documented matching host UID and group when the installer/deployment seam is implemented.

The user unit targets a dedicated non-root runtime account and is separate from the legacy
browser service. It is a delivery template, not enabled by this change. Host NoNewPrivileges is
not set because rootless Podman needs newuidmap/newgidmap; container no-new-privileges remains
enforced. The host requires iproute2 at `/usr/sbin/ip`. Both a nonempty explicit CIDR deny list
(at most 64 entries) and infrastructure hostname list (at most 32 entries) are required. The trusted
installer must include every public host/NAT and application ingress name, or its addresses in
the CIDR list. Local interface discovery cannot infer external NAT/reverse-proxy addresses. Shared
CDN addresses are denied conservatively too; there is no hostname exception to the address policy.

Before engine recovery or broker listening, `infrastructure.py` discovers all interface addresses
and resolves every configured name. Discovery repeats after each 30-second interval, with a
ten-second discovery timeout and independent 60-second policy expiry. Configured names are always
denied directly, including between DNS refreshes. Discovered addresses remain denied until service
restart, alongside static CIDRs; a 4096-network history limit fails closed on exhaustion. Failed or
expired discovery blocks new tunnels and closes existing ones. Any new address also closes all
current tunnels; unchanged successful refresh preserves them. Egress checks the policy generation
after destination DNS and again after dialing, before acknowledging a connection. Each runtime
uses the same service-owned policy. No configuration, DNS answer or request content is logged.

This is host-policy implementation and bounded native/fixture evidence. Installer population of
complete infrastructure inputs, deployed browser ingress checks and supported-host/ARM64 acceptance
remain hard release blockers. Never enable real sign-in from this foundation alone.

The lifecycle socket grants trusted API/worker processes access to runtime references. It does
not authenticate Moss users, bind browser sessions or authorize viewer/collector leases. Those
checks and the remaining fixed browser operations must be implemented at their approved seams.

The observed Python fixture manifest digest was
`sha256:884d3f3d9b4ef25b050f984ca8781efd6b0f49312721d2c321536b7cecf1c224`.
It is pinned in the engine fixture build. It is not a production browser image.

## Candidate browser image

`image/Containerfile` pins the base manifest, Chromium package and websocket-client package.
Only the fixed runner, relay and browser policy are copied; no profile or operator binding is
included. The image starts at `about:blank`. The runner accepts no arguments, waits for the
loopback relay before launching Chromium, supervises both children and discards their output.
Chromium uses the proxy with implicit loopback bypass disabled. Its local DNS rule excludes
only the proxy's numeric loopback address; the host egress resolves HTTPS destinations.
The debugging listener is container-local and has no published host port.

The policy file configures password-manager, autofill, download, printing and browser-sync
restrictions. The native policy proof below checks Chromium's mandatory-policy report, five
enforced preferences and a synthetic Blob download. It does not exercise every policy's browser
UI behavior. Profile files still contain live login material after sign-in; do not treat these
policies as encryption or backup protection.

The checked-in pin is a **candidate**, not a maintained release channel or a completed security
review. Before release, review browser/base vulnerabilities, update the pins, rebuild both supported
architectures, rerun acceptance and publish immutable image identities. An unavailable exact
package must fail the build; never silently substitute an unreviewed version or disable sandboxing.

Account-free native proof, from `~/Jarv1s`:

```sh
podman build --tag localhost/moss-outlook-browser:candidate --file infra/outlook-browser/image/Containerfile infra/outlook-browser
podman image inspect --format '{{.Id}}' localhost/moss-outlook-browser:candidate
PYTHONPATH=infra/outlook-browser python3 -B infra/outlook-browser/tests/verify_browser.py --image sha256:<reported-image-id>
```

Supply exactly one `sha256:` prefix. The verifier checks image runner/relay/policy bytes against
the checkout. It creates two real runtimes through the managed engine and egress, checks Chromium's
own namespace/seccomp diagnostics, public Microsoft HTTPS with ordinary certificate checks, fresh
separate localStorage, restart persistence, profile-volume removal and the unaffected second
browser. It exercises selected private IPv4/IPv6 and local debugging-page navigation. Test-only
derivative images remove the sandbox and loopback-bypass protections individually; each must cause
the corresponding assertion to fail. No arbitrary-CDP helper or bypass flag is installed in the
candidate image or exposed by the lifecycle broker. The probe runs only through test-side exec.

This proof passed on native x86_64. It does not establish ARM64 support, Microsoft sign-in/MFA,
full redirects/rebinding/public IPv6 behavior, public host/app ingress denial, arbitrary engine
crash recovery or authenticated Moss viewing. The separate service proof above exercises selected
crash boundaries. No real account or production instance is used.
The verifier removes its containers, volumes and control-image tags; the candidate/base remain
until explicitly removed. Ensure sufficient build storage. On this host, an environment-only
storage override was ignored; verify `podman info` and use explicit engine root/runroot options
consistently for builds and every test subprocess when selecting a separate disposable store.

`chromium_seccomp.py` derives a policy from the trusted host default, changing only `chroot`
rules while preserving unrelated syscall names and conditions. The installed host default
requires this adjustment for Chromium's nested namespace sandbox. It adds no outer capability.
The test uses the generated file; installer policy delivery and host support checks remain pending.

## Effective candidate policies

After building the candidate, run this account-free native proof:

```sh
PYTHONPATH=infra/outlook-browser python3 -B infra/outlook-browser/tests/verify_policies.py --image sha256:<reported-image-id>
```

Use `--engine-root <disposable-store> --engine-runroot <disposable-runroot>` together to select
a separate store. A test-only PATH adapter forwards every engine subprocess, including runtime
operations, to those explicit locations. It does not change the installed service or image.

The test creates actual Runtime/Podman/Egress browsers, checks runner/relay bytes and policy
values against the checkout, and checks Chromium's own namespace/seccomp diagnostics. Chromium's
policy page must report all nine configured policies with the expected values, Platform source,
Machine scope, Mandatory level and OK status. Its settings API must report address/card autofill,
background mode, password saving and browser sign-in as enforced false; attempts to set those
five preferences true must fail and leave them false. Repeat after a graceful browser restart.

The download fixture clicks a page-created Blob link with a user gesture and checks for its exact
synthetic bytes in the profile's download directory for five seconds. Test-side CDP explicitly
allows headless saving in both positive and control browsers, so that default cannot explain the
policy denial. No file may appear with the configured policy. Clearing only the policy file's
contents in a derivative image must make all policy/preference assertions fail and actually save
the fixture. All five previously rejected preference writes must then succeed, change the values
to true and fail the same write-rejection assertion. Removing only DownloadRestrictions must also
save it and fail the same no-download assertion while the other eight policies and five
preference locks still pass.

This establishes the reported policy state, preference enforcement and this bounded Blob-download
case on native x86_64. It does not prove every download route, printing behavior, notification
prompts, sync/sign-in UI, password-form behavior, ARM64 or real Microsoft sign-in. The controls
change only the policy JSON; no CDP helper or test bypass is shipped. No accounts or production
services are used. Containers, profile volumes and control tags are removed; the supplied image
and build cache remain until explicitly removed.

## Candidate browser infrastructure policy

After building the candidate, run the account-free browser network proof:

```sh
PYTHONPATH=infra/outlook-browser python3 -B infra/outlook-browser/tests/verify_browser_network.py --image sha256:<reported-image-id>
```

The same paired `--engine-root` / `--engine-runroot` options select a disposable store.
The verifier uses actual Runtime/Podman/Egress, interface discovery, DNS and ordinary public
Microsoft TLS. It checks candidate runner/relay/policy bytes, Chromium namespace/seccomp
diagnostics and container isolation settings. Every public navigation uses a fresh query string.

It observes the real 60-second policy expiry without advancing the clock: Chromium must report
CONNECT failure, and real discovery must restore HTTPS. Trusted test code then classifies the
public Microsoft endpoint as an infrastructure-ingress stand-in. Refresh must close the captured
live transports and deny the hostname. Removing the direct hostname match while retaining the
discovered addresses must still deny Chromium after destination resolution.

Two controls must fail the same positive assertions. Omitting only Runtime's infrastructure-policy
binding restores public HTTPS and fails browser denial. Suppressing only proactive tunnel closure
leaves new-CONNECT hostname/address/generation checks active, but Chromium reuses its old tunnel
and renders another public response; both transport-closure and browser-denial assertions fail.
Restoring closure and invalidating policy must close those captured transports.

The six proof groups passed on native x86_64. This is a deliberately reclassified public endpoint,
not deployed Moss ingress acceptance. There is no TLS interception, certificate bypass, account,
host TCP listener or production service. Redirect/rebinding, public IPv6 browser reachability,
ARM64/supported hosts, installer population and authenticated product acceptance remain blockers.
The verifier removes its three containers and profile volumes; the supplied candidate/base image
and build cache remain until explicitly removed.
