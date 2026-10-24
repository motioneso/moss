# Computer owner integration: receiving boundary first

Part of #3616 / parent #3577. First dependency #3617; fixed lifecycle/storage #3618;
owner transport and approved chat #3619. Source base/current main checked at
`076fc397e665c31c9f750d96e44bec8b18cb650c`. Live GitHub confirms #3598, #3607 and
#3612 merged. Older draft/stack descriptions are historical. No merge, deployment or
parent/qualification closure authority. Implementer: Codex `/root`.

## Reused acceptance and scope

Reuse the 28-test ComputerInputControl foundation and accepted r21 bounded offline
persistence, sandbox, flush, actual viewer/input and closure evidence. Read r21 report/JSON
and independent ledger; no standalone persistence rerun. Original r12 connection and r18
clipboard causes remain unknown. Six watchdog samples do not establish sustained fit.

The smallest delivered outcome remains one configured persistent Computer through ordinary
owner login in Moss chat/browser: visible watching, intentional takeover, return and controlling
viewer close. Implementing receiving input, trusted lifecycle and owner transport/UI together
would introduce three unqualified trust boundaries in one candidate. Split explicit dependencies;
this plan details only the first. **#3617 alone does not deliver that vertical slice.** Do not
close #3616 or advertise a usable Computer until #3618/#3619 and real live proof pass.

## Current seam evidence

- `apps/api/src/computer/input-control.ts:32`: controller has no production caller (graph and
  source checked). `:95–119` dispatch validates authority before synchronous send. `:183–186`
  advances local generation; no receiving queue/key release. `:86–93` authenticates intentional
  close, unlike `:121–126` unexpected disconnect.
- `packages/auth/src/session-bindings.ts:47–55,69–81`: auth-owned fresh session-row/account/expiry
  validation and cookie-only resolution. Consume this public service; do not query auth tables.
- `packages/auth/src/session-service.ts:123–192` revokes cookie sessions through auth-owned SQL;
  `packages/auth/src/index.ts:254–265` revokes a user's sessions. Neither supplies an active
  Computer socket invalidation callback. #3619 must cover ordinary Better Auth sign-out too.
- `apps/api/src/server.ts:357,426,626–634`: WebSocket registration, ordinary auth routes and
  feature composition using sessionBindings/trustedOrigins already exist. Terminal relay
  `packages/ai/src/terminal-routes.ts:174–215` checks an admin/ticket after upgrade, not ongoing
  owner identity; its URL ticket must not be copied.
- `spikes/moss-computer/entrypoint.sh:21–22,38–39`: loopback TigerVNC/websockify.
  `spikes/moss-computer/gateway.conf.template:33` forwards raw WS; this bypasses input policy.
  `spikes/moss-computer/compose.yaml:6–37,39–69` is isolated qualification storage/runtime,
  not an installed fixed lifecycle service.
- `packages/settings/src/host-restart-routes.ts:23–33,75` and
  `infra/host/jarv1s-restart.sh:4–10` implement a fixed Moss restart sentinel, not Computer ops.
- `infra/caddy/Caddyfile:31–35` proxies the HTTPS origin. Split-web
  `infra/nginx/jarv1s-web.conf:47–56` lacks Upgrade/Connection forwarding. Dev Vite config
  `apps/web/vite.config.ts:14–25` rewrites HTTP Origin; it cannot establish exact-origin proof.
- `apps/web/src/chat/chat-drawer.tsx:60,746–840` owns chat/header/body; it is already 988 lines.
  Add a focused Computer child/hook rather than push it above 1000.
  `packages/shared/src/app-map-core.ts:132–149` describes the assistant/chat surface.
  #3619 updates actual behavior, requirements, errors and remediation in that same PR.

## Library path and design decision

Use trusted bundled noVNC for eventual browser rendering and established RFB wire formats.
Do not forward raw viewer messages to the guest. Evaluate pinned `rfb2@1.1.0` as the receiving
library: it provides RfbClient, RfbServerConnection, typed key/pointer events and upstream
Fence support, without a new desktop protocol. Its published tarball was inspected privately:
`dist/server.js` parses input; `dist/client.js` keyEvent/pointerEvent call Transport.write;
`dist/transport.js` writes synchronously into Node Duplex and may buffer bytes. Consequently
local generation checks cannot retract accepted writes. Library maturity/provenance and this
exact path need independent review; a package name is not proof of security.

Prefer a terminating bridge over a raw byte filter: the library parses the browser's RFB stream;
only normalized key/pointer events can reach the one upstream writer. A filter could preserve
compression and lower memory, but would need a second parser for fragmented initialization,
extensions and message lengths, and would retain multiple guest input connections. Do not build
that parser here. Framebuffer fan-out is later #3619 work, using the same upstream identity.
Clipboard, resizing, power operations, downloads and unknown extension forwarding are excluded.

## #3617 bounded contracts before code

Files: `apps/api/src/computer/rfb-input.ts`, existing `input-control.ts`, API package manifest/
lockfile, and `tests/unit/computer-rfb-input.test.ts` with a focused wire fixture if needed.
No route, viewer asset, guest launch or product UI in this dependency. No app-map capability
for an internal receiver. Its production transport caller remains #3619's hard delivery gate.

Add an optional synchronous authority-transition observer to ComputerInputControl dependencies.
It runs after local generation changes, before any subsequent input dispatch. The receiver owns
that observer, invalidates its admission epoch and releases tracked pressed keys/buttons on every
actual transition (including revocation/expiry failure, disconnect and shutdown). Watcher closure
must not invalidate another controller. Observer failures must fail closed; no exception can leave
input enabled. Existing policy behavior and tests must continue to pass.

Receiver contract (signatures, not implementations):

- `ComputerRfbInput` composes ComputerInputControl and a single connected library RfbClient.
- `connect(binding: BrowserSessionBinding): Promise<ComputerViewer>` starts watching.
- `takeOver`, `returnToMoss`, `closeViewer`: freshly authenticated controller operations followed
  by the receiving barrier before success. `disconnect`, `invalidateSession`, `close` fail closed.
- `attachWatcher(viewer, stream: Duplex): void` creates a library RfbServerConnection whose
  key/pointer/clipboard events can never write to the upstream.
- `attachController(viewer, stream: Duplex): Promise<void>` freshly authorizes current ownership
  and binds a new RFB parser/stream to an immutable receiver epoch. A former watcher stream is
  never upgraded. One writable viewer stream maximum; replacing it invalidates/destroys the old.
- `acquireAgentLease(actorUserId)` and `dispatchAgent(lease, event)` retain the foundation's
  browser-session grant. Input events are only validated keysyms and in-bounds pointer values.
- `snapshot()` exposes policy mode plus receiving readiness, never credentials.

Bound parser streams and input work. At most four attached streams, 64 KiB ingress per stream
lifetime, 32 queued normalized inputs and 64 simultaneously pressed keys. Reject on overflow;
do not retain arbitrary buffered input. Queue entries capture the admission epoch at receipt,
check it before authorization and immediately before writing, and cannot become valid after a
later takeover. Bound every auth wait and barrier; a timeout closes the receiver rather than
letting an unresolved auth promise keep the queue alive. No automatic retry after a hard failure.

Require upstream Fence support before admitting input. On transition, stop admission, invalidate
queued/parser capabilities, release tracked keys and all pointer buttons through the sole writer,
then send a unique Fence request with BlockBefore. Reopen admission and acknowledge the transition
only after matching response/payload/flags and fresh post-barrier session authorization. If the
backend lacks/ignores fences, disconnects or times out, remain unavailable/paused and close the
upstream; do not treat local write/drain as remote consumption. Verify exact TigerVNC support and
ordering during #3619 live proof; fixture replies are not that proof. Never claim byte retraction.

Intentional close returns control only after fresh authorization and the receiving barrier.
Unexpected parser/stream loss disconnects the controlling viewer, invalidates its epoch and
releases inputs; reconnect begins watching. Agent authority survives watcher closure only while
its original grant stays live. Startup/shutdown are paused; no automatic authority resurrection.

## #3618 prerequisite and #3619 real caller

#3618 owns a separately reviewed fixed-operation host service for one configured owner, pinned
adopted image and dedicated durable home/socket. API gets no Docker socket, devices, generic
exec or request-derived image/path/mount. Disable retains data; deletion is excluded. A separate
trusted receiving gateway has its own resource/isolation envelope; do not silently put an
unbounded RFB decoder inside ordinary Moss. Missing/stopped/unqualified lifecycle reports
unavailable. The gateway-to-auth fresh-check channel and sole upstream socket access must be
fixed in #3618/#3619's exact contract before launch; they do not exist today (owner: implementer).

#3619 registers the actual caller, packages trusted noVNC assets and uses the same Computer in
ordinary browser/app chat. Check exact trusted Origin and fresh cookie owner binding before
upgrade, every transition and every input; no replayable credential/ticket in URLs or logs.
Active liveness revalidation: at most 2 seconds between checks, 2-second check timeout, and an
absolute expiry deadline; denial/timeout closes active viewers and receiver input. Explicit
logout/revocation must reach the active writer; per-event checks alone are insufficient. The
exact cross-process/session callback contract is a prerequisite, not an invented existing seam.

Use the approved full-screen recent still, expanded viewer beside conversation, narrow drawer
and inline phone viewer. Shared Button/Badge/PeekPanel/Thread; deterministic concise status and
capture age. No separate destination/module. Watching preserves authority; intentional controlling
close awaits authenticated return/barrier. Unavailable, paused, reconnecting and failed-return
states must stay truthful. UI and configuration/app-map changes ship together. Fix the split-web
WSS proxy and include affected dev/prod settings with their requirements.

## Verification and stop gates

Dependencies are absent here; inspect existing installs/cache first, then scoped frozen install
for API/root test tooling only. Adding rfb2 requires a reviewed pinned manifest/lock update, not
an unfrozen broad install. No DB/foundation command for #3617. Before any DB work read verify-gate
and use an isolated target. All commands unpiped; expected exit 0 unless a named negative control.

- `pnpm exec vitest run tests/unit/computer-input-control.test.ts tests/unit/computer-rfb-input.test.ts`.
- `pnpm exec tsc --noEmit` and `pnpm exec tsc -p tsconfig.tests.json --noEmit`.
- Scoped `pnpm exec eslint` on changed source/tests, `pnpm exec prettier --check` on changed files,
  `pnpm check:file-size`, `git diff --check`.
- Real library stream tests: watcher input never arrives at upstream parser; owner/agent input
  does; old watcher/owner streams and queued delayed-auth events remain invalid across transfer;
  releases precede successful Fence acknowledgement; unrelated watcher close preserves authority;
  auth expiry/revocation, unsupported/mismatched/timed-out Fence, disconnect and queue/byte/key
  bounds fail closed. Assert actual received wire events, not just send mocks. Remove epoch guard
  and release protection separately, observe intended assertions fail, restore and record green.

Independent read-only security/spec review of exact committed plan precedes code. Reviewers never
author fixes. Preserve every ruling and exact candidate/receipt identity. After #3617 scoped
verification, evaluate that dependency before detailing/starting the next one. Kill owner:
Codex `/root`. Stop/split if mature library paths cannot establish a sole writer, bounded buffering
or receive-fence ordering; no custom remote protocol or silent weaker handoff.

#3616 delivery e2e remains mandatory after all dependencies: real signup/login → chat → real
HTTPS/WSS visible frame/input → takeover excludes agent → return/intentional close needs fresh
lease. Independently hit foreign/unauthenticated/expired/revoked endpoints and active sockets;
observe stale-input/key-release controls fail at their intended seams. No stubbed responses or
synthetic-certificate substitute. Independent exact runtime/evidence and closure acceptance;
otherwise status stays incomplete/unverified and tasks stay open.

Before any live work commit/review the exact isolated runtime/auth/storage/network contract.
Fresh floors RAM/root 8 GiB, data 30 GiB and healthy Moss. Exact adopted image only; restore only
after actual archive/config/all-seven-layer checks and independent acceptance. Guest UID 1000,
network-none, 2 CPU/4 GiB/512 PIDs; trusted gateway 0.5 CPU/128 MiB/32 PIDs; read-only roots,
dropped capabilities, default profiles, bounded tmpfs/logs. Keep offline fixture content. Claim
and release devports; independent alive watchdog before launch, 1800-second maximum, 90-second
heartbeat, nominal five-second samples, fail closed at floors/measurement/log failure or
home+socket 10 GiB. Preserve lock/stop intent, first healthy sample, zombie rejection, exact-label
emergency stop and PID/start/group cleanup. No reclamation or production restart to meet floors.
Inspect every actual sample/reason and independently close resources; retain private homes/receipts.

Later independently bounded work: idle sleep/wake with active viewer/agent inhibitors, safe clean
flush/unsaved-work behavior, actual resource reclamation and lifecycle race fencing; useful
HTTP(S)/DNS egress excluding host/LAN/metadata/Moss; installer/platform/release and downloads.
Do not replace network-none with unrestricted bridge or promise process/package/site-session
persistence. No model calls in #3617. In later integration the model only chooses an authorized
task and proposes its next input; permissions, statuses and confirmations come from records.
