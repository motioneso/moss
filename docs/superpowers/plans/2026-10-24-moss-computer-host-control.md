# Computer fixed host control prerequisite

Part of #3618 / #3616 / #3577. Base `9ff285c01162535a15fb2cb06d52d52328bc1114`,
merged receiver PR #3621. Ben's continuing authority is recorded in the
[lifecycle dispatch](../handoffs/2026-10-24-moss-computer-lifecycle-integration.md):
code-review → resolve → verify → merge → fresh isolated successor until owner integration is
finished. Production deployment and bypassing admission/live-path gates are excluded.

## Scope and evaluation boundary

Implement the **internal fixed host control service**, not a product route or installed desktop.
Separately establishing a root-equivalent host executor and a guest-protocol decoder in one
candidate would combine two new trust boundaries. Evaluate this service first; next implement
and qualify the receiving gateway, then wire ordinary owner sessions and approved chat #3619.
#3618 remains open until isolated actual lifecycle operations and installed gateway qualify.
#3616 remains open until its real owner UI and receiving-seam acceptance pass.

This slice owns a real private Unix HTTP listener, client, fixed Docker request adapter, durable
CAS generation and fixed pair specifications. Test the service over a real Unix socket with a
recording Docker HTTP stand-in, explicitly **not** a guest/runtime proof. There is no installer,
startup integration, automatic enable, API route, advertised app-map capability or production
configuration change. No real Docker mutation or guest launch is authorized by this plan.
An opt-in operator runner is useful internal tooling; default dev/prod behavior stays as today.

## Verified seams and decisions

- `apps/api/src/computer/rfb-input.ts:25–58,60–142` composes the accepted receiver but has no
  transport/lifecycle caller. Preserve it unchanged. Four parsers, epochs, post-Fence auth and
  backlog limits are not a full decoder envelope.
- `packages/auth/src/session-bindings.ts:20–28,40–87` exposes cookie resolution and fresh session
  checks. Host control must consume an already-authorized owner binding through its trusted API
  client; the host does not resolve cookies, query auth tables or grant admin private access.
- `packages/settings/src/host-restart-routes.ts:23–33,75–156` and
  `infra/host/jarv1s-restart.sh:4–38` are a fixed restart sentinel. Reusing its no-request-derived-
  command principle is appropriate; extending that sentinel with parsed Docker commands is not.
- `spikes/moss-computer/compose.yaml:6–37,39–69` supplies the accepted guest and gateway envelopes,
  dedicated storage and offline guest. It is qualification configuration, not an installed service.
- `spikes/moss-computer/entrypoint.sh:21–22,38–39` uses loopback TigerVNC and a Unix websockify
  socket. Only the separate receiving gateway may mount that socket; API gets neither socket nor
  Docker access. Raw passthrough cannot implement owner input exclusion.
- `infra/host/` currently has only restart scripts. Fixed lifecycle executor, private control IPC,
  gateway build/auth IPC and independent runtime admission service do not exist. Owner: implementer
  and successors. Missing services are implementation work, never routine questions for Ben.

Choose native Node HTTP over Unix sockets rather than parsed shell commands or adding a daemon
framework. It reuses Node's bounded HTTP server/client and Docker's fixed JSON API without exec,
image pulls, shell interpolation or new runtime dependencies. A sentinel per operation is simpler
for a single restart but cannot safely correlate generation/state/error responses across an enable
or replacement. Do not build a generic host job platform.

## Host trust and storage contract

The operator runner takes exactly one trusted local configuration path, never a browser value.
Configuration fixes UUID instance/owner, private state root, home/socket/IPC directories, Docker
socket and qualified gateway image ID. Guest image is a source constant:
`sha256:c84e2db2add5f4c3c5073c7f021f6a2b4a04866948f7a5c4c47437c0d5d9ffbf`.
Gateway image is absent until separately built and independently accepted; absence is unavailable.
No inferred image tag, pull, rebuild, image load or substituted image. Exact image IDs only.

The daemon runs as a trusted host operator; it is not imported by the API server. The API mounts
only its private control socket directory, with filesystem permissions restricting other users;
no TCP listener. The host-private state/config/admission directory is not mounted into API or guest.
The configured owner ID is the only owner. Request actor identity is an assertion from trusted
Moss API after fresh auth, not independent browser authentication. A compromised API is within
this control channel's trust boundary; the fixed vocabulary still prevents generic Docker access.

All directories must already exist, be absolute canonical nonsymlink paths with distinct,
nonoverlapping roots. Never create, chown, delete or migrate home data automatically. Home and
guest socket directory are dedicated to this instance; a host-private identity marker binds the
canonical paths and owner/instance before operations. Changed ownership/path configuration fails
closed. Record root device/inode/owner/mode in the private identity marker and revalidate before
each operation; require trusted ancestors that API/guest cannot rename. Guest-owned home/socket
roots may contain guest-controlled entries, but their parent is host-controlled. API IPC is distinct from guest socket and host state. Host state and IPC permissions are
validated; symlinked state files, replacement roots and an existing listener/lock fail closed.
A single exclusive daemon lock prevents competing controllers; do not steal a stale lock.

Persist `{generation, enabled, resources}` atomically with file and directory fsync. Each resource
records its role, separate creation generation, deterministic name and full immutable Docker ID
(or a pending create intent). Persist the intent before create, the returned ID before start, and
retain old resource identities until verified removal. CAS generation never substitutes for the
resource generation: a failed/no-op operation must leave the existing pair reachable to disable.
On daemon restart, reconcile only recorded IDs/intents. A timed-out create is not retried; inspect
the intent's exact deterministic name once and validate all identity/spec fields before recording
its full ID. If Docker remains unreachable, retain unavailable pending state for explicit recovery.
Never conclude an unknown Docker result means no container exists. Generation increments
and is durable **before** every mutation, including failed operations. Serialize operations;
reject busy work instead of keeping an unbounded queue. Every mutating request carries the
expected generation, and stale requests perform no Docker mutation. Daemon restart never
re-enables anything; explicit enable requires a fresh generation and fresh admission.

## Fixed operation contract

`ComputerHostClient.request(binding, operation, expectedGeneration)` sends only
`{actorUserId, operation, expectedGeneration}`; operations are `status`, `enable`, `disable`,
`recreate`. Reject unknown keys, operations, foreign owner, malformed/oversized JSON and unsafe
integer generations. Client freshly checks the supplied session before sending. Actual browser
routes and repeated active-session enforcement remain #3619. No URL credentials or raw Docker
responses/errors/logs returned. Results contain generation, enabled, state and fixed reason codes.
Missing/stopped/unqualified prerequisites never report available.

- **status:** inspect only configured instance resources; report disabled, unavailable or running
  only when the qualified pair is actually running. No startup and no mutation.
- **enable:** preserve home, require exact installed images, qualified gateway and fresh supervised
  admission; create/start exactly one fixed guest/gateway pair. No automatic retry.
- **disable:** durably set enabled=false, stop gateway first (fence input), stop guest, remove only
  verified owned containers; retain all home/profile/socket data. Stop failure cannot report disabled
  as successful closure. No sleep, data deletion, process or clean-profile-flush promise.
- **recreate:** explicit mutation, same dedicated home and pinned image, fresh generation/admission;
  stop/remove exact pair, then create a distinct pair. No request image/path/mount/container ID.

Docker adapter has only bounded inspect/list/create/start/stop/kill/remove operations. It captures
full returned IDs and reinspects immutable IDs before mutation. Enumerate only exact instance
labels; reject duplicate/foreign/mismatched name, owner, role, generation, image or fixed runtime
configuration. A matching label alone is not authority. No mutation of an ambiguous inventory.
Remove never includes volumes. Docker API response/time/connection sizes are bounded and errors
are scrubbed. Failure closes admission and stops the exact resources created by this operation;
never discovers arbitrary cleanup targets from error text or production names.

## Exact pair and later gateway contract (not launch acceptance)

Guest: adopted image, UID/GID1000, network none, 2 CPU/4GiB RAM+swap/512 PIDs, read-only root,
drop ALL capabilities, no-new-privileges, default seccomp/AppArmor, 256MiB shm, bounded `/tmp`
256MiB and `/run`32MiB, home→`/home/desktop`, socket→`/socket`, no other mounts, no ports, no
restart policy, json-file logs2MiB×2. No devices, Docker socket, credentials or production mounts.

Trusted gateway: separately accepted exact image, UID/GID1000, network none, 0.5CPU/128MiB RAM+
swap/32PIDs, read-only root, dropped caps, no-new-privileges/default profiles, `/tmp`16MiB, logs2MiB×2,
read-only guest socket mount and private gateway IPC/config mounts only. No guest home access.
All communication uses separate Unix sockets: browser⇄API on ordinary Moss HTTPS/WSS, API⇄gateway
on trusted gateway IPC, gateway⇄auth on auth IPC, gateway⇄guest on websockify Unix socket.
The gateway terminates RFB using accepted ComputerRfbInput; never raw viewer passthrough.
No public guest/gateway port. Trusted viewer assets remain on Moss origin; no guest HTML served.

Successor owns gateway executable/build, bounded framebuffer/decoder envelope and exact auth IPC:
API resolves cookie+exact Origin before upgrade; gateway receives a server-issued viewer binding,
fresh-checks owner/session before transitions/input and after Fence. Auth replies carry request
correlation and absolute expiry, are bounded to2s, and denial/timeout/disconnect invalidates the
receiver. Poll active liveness at most2s apart with2s deadline and absolute expiry timer; explicit
logout/revocation must push invalidation to the active receiver. Sequence/correlation and epoch
checks exclude delayed reply resurrection. No cookie/token/ticket in URL, logs or guest mounts.
#3619 must include ordinary Better Auth logout as well as admin/session-service revocation.
This is a required design boundary, not an implemented auth channel or accepted live ordering.

Enable/recreate require a host-private admission port supplied by the independently reviewed
runtime operator. In this slice the runner deliberately supplies **unavailable** admission: it
cannot launch. A later runtime integration must implement fresh RAM/root≥8GiB/data≥30GiB and
healthy-Moss checks; exact alive independent watchdog, initial complete healthy sample, fixed
label, PID/start identity, ≤1800s monotonic run, heartbeat≤90s, nominal5s samples, fail closed on
floor/measurement/log failure or home+socket≥10GiB, lifecycle lock/stop intent and exact-label
emergency cleanup. Monitoring is not quota. Implement and independently accept this port before
any real enable/recreate. No fake Fence/auth/admission result establishes runtime acceptance.

## Files, checks and kill gate

Host modules under `scripts/computer-host/` plus opt-in `scripts/computer-host.ts`; pure IPC contract
and private API client `apps/api/src/computer/host-contract.ts` and `host-client.ts`; behavior tests `tests/unit/computer-host*.test.ts`.
No runtime dependency change. Inspect installed dependencies/cache, then scoped frozen tooling
install. Before tests, search Hindsight conventions. Before any DB command use verify-gate with
isolated target; no DB/foundation command is needed for this internal slice.

Commands are unpiped, expected exit0: scoped Vitest for host and existing59 receiver tests,
`pnpm exec tsc --noEmit`, `pnpm exec tsc -p tsconfig.tests.json --noEmit`, scoped ESLint/Prettier,
`pnpm check:file-size`, `git diff --check`. Native Unix-socket tests must assert real serialized
requests, no Docker calls on denial/stale generation/absent admission, durable generation after
restart, same home across replacement, ambiguous labels/paths refused, gateway stopped first,
partial start cleanup and bounded malformed requests. Observe separate removed-protection
controls fail at the intended owner/generation/path/identity assertions, then restore and rerun.
Stand-in Docker proves adapter protocol only; no guest, live TigerVNC or persistence requalification.

No model calls or model-authored records. Later UI statuses render from lifecycle records; model
jobs remain choosing an authorized task and proposing its next input. No UI is added in this slice.

Independent read-only security/spec review of the exact committed plan precedes code. Preserve
rulings, including rejected findings. Kill owner Codex `/root`: split/reject if fixed operations
need generic exec, request-derived mounts, API Docker access or a guessed runtime admission.
After code-review Standards+Spec at pinned base, resolve findings, verify exact candidate,
independently review evidence and merge the internal prerequisite only. Keep #3618/#3616 open.
Launch and verify a fresh isolated successor for the gateway/admission continuation, carrying
review → resolve → verify → merge → fresh successor authority. Parent completion requires actual
owner HTTPS/WSS/chat/input and hostile active-session/stale-input/release proof, independent
exact evidence and closure. No production deployment is authorized.
