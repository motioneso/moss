# Computer separate gateway process and private transport

Part of #3618/#3619/#3616/#3577. Base/current main
`583819299a29c900a5391aef4fcdf5952b87f1d4` (merged PR #3632).
Implementer: `computer-gateway-process`. Inherited authority: independent review, resolve,
verify exact candidate/evidence/checks, merge, verified fresh isolated successor until actual
owner integration finishes. No production deployment or bypass of runtime/live gates.

## Scope and evaluation

Deliver an opt-in separate Node executable and fixed private Unix API transport consuming the
accepted receiving core. This candidate connects one trusted configured Unix websockify socket,
adds WebSocket bounds before RFB decoding, and exposes private control plus standard raw RFB
streams to a trusted API client. It is internal tooling, never imported by ordinary API boot.
It does not build/load/qualify a container image, start a guest, implement admission/watchdog,
install owner routes/viewer assets/UI, or change deployment defaults. Host unavailableAdmission
remains unchanged. A separate executable is not independently supervised runtime acceptance.

Image qualification and independent admission are a distinct runtime boundary; evaluate this
transport first. Actual image fit, TigerVNC Fence behavior, fixed lifecycle/closure and owner
HTTPS/WSS/chat remain hard #3618/#3619 gates. No new app-map capability for internal tooling.
Tests run the executable only against real private Unix sockets and a synthetic library guest;
no real DB/Docker/desktop/browser or TCP listener. No accepted r21 persistence rerun.

## Current seams and design fork

- `apps/api/src/computer/receiving-gateway.ts:24-69,136-250`: composes bounded RFB, actual auth IPC,
  sole receiver, local viewer capabilities, transfers and shutdown, but takes an already connected
  Duplex. It has no listener/executable/private viewer API. Consume it without another policy.
- `apps/api/src/computer/receiving-gateway.ts:310-376`: expected controlling-parser retirement is
  distinct from unexpected visual loss. Keep the stable private control lifetime separate from
  replaceable RFB stream lifetimes. Watcher remains immutable during takeover.
- `apps/api/src/computer/auth-server.ts:175-215,255-273`: canonical0700 parent/trusted ancestors,
  private0600 bind and exclusive hardlink publication solve Node replacement-endpoint unlink.
  Extract only this canonical endpoint helper for reuse; retain auth behavior/tests.
- `apps/api/src/computer/host-http.ts:31-93`: fixed Unix HTTP is bounded one-shot traffic, not a
  lifetime supervisor or RFB stream. Native net control avoids HTTP routing/upgrades entirely.
- `scripts/computer-host/spec.ts:20-79`: gateway mounts /socket:ro, /ipc:rw, /auth:ro, /config:ro;
  network-none, UID1000,0.5CPU/128MiB/32PIDs; no guest-home mount. Runner still lacks admission.
- `spikes/moss-computer/entrypoint.sh:21-22,38-39`: fixed1280x800 TigerVNC + /socket/viewer.sock
  websockify. Only separate gateway connects it; API never mounts it.
- Inspected installed ws8.21.1 public client options: maxPayload, maxFragments, maxBufferedChunks,
  handshakeTimeout, followRedirects, perMessageDeflate and autoPong are configurable before
  decoding. `lib/receiver.js:431-446,504-515` reject oversized payload/fragment count before
  delivery; `lib/websocket.js:120-124` bufferedAmount includes socket and sender queues.
  Public send/pong still need preflight; createWebSocketStream alone has no aggregate queue cap.

Choose native Unix net for private control/standard RFB streams and ws for the one guest socket.
A WebSocket private API would align with browser framing but add a second WS decoder/HTTP upgrade
surface without helping private control lifetimes. HTTP one-shot commands simplify replies but
lose a natural API-loss lifetime. Browser traffic remains ordinary Moss HTTPS/WSS in #3619;
this private transport is never a browser authentication scheme or new RFB encoding.

## Files and exact private contract

Files: `apps/api/src/computer/private-endpoint.ts`, existing auth-server extraction,
`guest-websocket.ts`, `gateway-channel.ts`, `gateway-server.ts`, `gateway-client.ts`;
`scripts/computer-gateway.ts` and `scripts/computer-gateway/config.ts`; focused tests/fixtures.
Add pinned ws8.21.1 to API runtime dependencies (already root tooling/locked transitively);
frozen installation after the intentional lock update. No unrelated dependency update.

`serveComputerGateway({ownerUserId, authSocketPath, guestSocketPath, socketPath})` first reserves/publishes its exclusive private IPC endpoint with a rejecting startup handler, then
opens exactly one upstream UnixWS connection and core, then admits private API connections.
Publication conflicts fail before opening a second guest connection. Startup failure closes the
owned endpoint; shutdown racing publication cannot leave a late published listener/alias. No TCP fallback,
redirect, cookie, password, bearer token or request-derived upstream. Trusted local configuration
fixes all paths and owner UUID; paths absolute, normalized and distinct. The operator config is
regular nonsymlink0600 owned by effective UID in canonical0700 parent with trusted ancestors;
maximum4096bytes, exact keys, no environment/browser overrides. Only owner UUID/path metadata.
Runner accepts one config path, umask077, handles TERM/INT and exits on upstream/core failure.
Errors/logs are fixed sanitized strings. Missing prerequisites exit unavailable, no retry.
No import-time side effects, normal API listener or production registration.

Reuse canonical private endpoint publication for gateway IPC. Existing aliases survive startup
failure and old-service close. Stop destroys owned sockets, closes private listener and removes
only matching published dev/ino plus owned empty private directory. Never recursively remove
operator paths. Gateway server owns all accepted connections before reading bytes: at most12
including pending headers, four stable control connections, and four attached RFB streams.
Header deadline2s; header<=1024bytes; no queued operation when busy. Pending asynchronous opens
and transitions count until settlement even after disconnect; at most4 opens/global core bound.

Each socket starts with one newline JSON object, exact fields, requestId=1. Either:
`{type:"open",requestId:1,viewerId:<API-issued UUID>}` opens a stable control lifetime through real
core.openViewer/auth IPC, replies `{type:"ok",requestId:1}`, then accepts fixed commands
`{type:"takeOver"|"returnToMoss"|"closeViewer"|"snapshot",requestId:<next integer>}`.
Requests strictly sequential, at most8192 per lifetime, one outstanding; malformed/unknown/extra,
pipelined/busy, oversized or expired/lost operations retire the connection, never retry/resurrect.
Commands/replies<=1024bytes; actual queued outgoing bytes<=64KiB before every write. Whole
command deadline5s covers existing sequential2s Fence/auth waits; timeout closes the core
conservatively if a mutation could otherwise complete after its private lifetime is lost.
Snapshot is sanitized core state, no bindings/cookies/session IDs or serialized core handles.
Explicit close awaits existing authenticated closeViewer, then closes control; loss calls
core.disconnect (never intentional return). All post-await completions check original lifetime.

Or first frame `{type:"watch"|"control",requestId:1,viewerId:<same private issued UUID>}` attaches
one raw standard RFB Duplex to an already open local control entry, then no further JSON. Reply
`{type:"ok",requestId:1}` precedes RFB. Client waits for ack; header trailing bytes are rejected.
No arbitrary core capability is deserialized: server maps fixed private viewerId to its own handle.
IDs stay inside trusted API IPC, never browser URLs or guest mounts. At most one watcher and one
controller stream per lifetime, global four parsers; reserve before asynchronous attach.
Watcher is not upgraded: takeover needs a separate new controlling RFB parser. The immutable
watcher may stay attached until lifetime close. Expected controlling parser close during return
or replacement preserves control lifetime; unexpected loss is handled by the core and cannot
regrant authority. Stable control loss destroys all its RFB streams and disconnects its viewer.
Auth/core retirement still destroys active visual streams synchronously through accepted core.
Private control may remain inert until next request/loss; it grants no input by itself.
Agent lease/dispatch over IPC remains a tracked #3619 composition prerequisite; no fake agent
capability or automatic authority in this slice.

API client `connectComputerGatewayViewer({socketPath,viewerId})` returns a local object with
watch/controller stream open, takeOver, returnToMoss, closeViewer, disconnect and snapshot.
It serializes only the fixed vocabulary over trusted IPC, no cookies or core capability values.
Own socket/operation deadlines, strict response correlation/shape/byte limits and no reconnect;
a control-channel/protocol failure destroys the control and all its streams. Raw RFB stream close
retires only that local stream; accepted core decides expected versus unexpected visual loss.
Never cascade raw-stream close into control.disconnect during return/replacement, and never infer
return or automatically reconnect. A failed return stays
fail-closed. Deliberate controlling close uses the existing barrier/auth operation before loss.
Later API must validate real cookie/exact trusted Origin before issuing the auth viewer binding.

## Guest WebSocket transport contract

`connectComputerGuestWebSocket(socketPath): Promise<Duplex>` uses one ws client with fixed
`ws://localhost/` URL and a public createConnection callback that always opens only the configured
Unix socket; binary subprotocol only, no redirects/compression/automatic pong; handshake2s,
maxPayload=1280*800*4+4096, maxFragments=1024, maxBufferedChunks=1024,
allowSynchronousEvents=false. Validate exact binary protocol/no extensions. Only binary messages
reach the core envelope. Readable queue plus next payload capped to two max messages; pause WS
on backpressure, destroy on excess. An always-armed2s deadline starts at WS open and refreshes only on each complete binary message.
Raw bytes, fragments, ping and pong never refresh it; empty idle also closes after2s. Thus a
fragmented/trickled tail cannot survive past2s after its preceding complete message. The core
already requests updates every200ms with2s response limit; this conservative idle refusal is
intentional. Test fragmented tail after a complete message, trickling and ping-only idle. This
predecoder deadline is independent of the core's2s partial-RFB-record bound.

Public Duplex write checks before Node queues: reserve twice all queued adapter bytes plus actual
ws.bufferedAmount and new frame overhead against64KiB. Guard manual pong similarly (<=125bytes).
No unbounded queue behind a stalled callback; pre/post send checks, error/close destroys Duplex
and core, no reconnect. Core retains Raw/envelope/decoder/fence bounds. These component limits do
not prove whole128MiB image fit; exact qualified image and independent watchdog remain required.

## Verification, stop and runtime gates

Run unpiped with logs outside ~/Jarv1s; expected0: focused Vitest for new transport/process/client,
auth endpoint/lifetime and existing receiving core; root `pnpm exec tsc --noEmit` and tests
`pnpm exec tsc -p tsconfig.tests.json --noEmit`; scoped ESLint/Prettier; file-size; diff--check.
Use actual native Unix sockets, ws vendor and RFB library plus real auth IPC with synthetic fresh
session lookup and disclosed Fence-extension fixture. Spawn actual opt-in executable, verify one
upstream, control/watch pixel readback, real owner wire input/takeover/return/close, active revoke,
controller loss, malformed/oversized/fragmented/trickled WS, byte/connection/pending bounds,
publication conflict/replacement preservation, signal shutdown and exact owned socket/process
closure. No real TigerVNC or owner UI claim. Observe removed protections fail at intended assertions:
WS payload/fragment/queue preflight, private correlation/lifetime, lost control fencing, connection
budget and endpoint ownership. Restore exact source then full green; retain every review ruling.

Independent read-only security/spec acceptance of this committed contract precedes implementation.
Kill owner computer-gateway-process: split if public ws cannot bound predecoder retention or
private transport needs a generic protocol platform. Source Standards+Spec code-review at pinned
base, independent security/source/evidence acceptance, exact required green CI precede merge.
Then launch and verify a fresh isolated successor with the same continuing chain and gates.

Before ANY actual guest/image/runtime qualification: separately committed independently accepted
exact packet, healthy Moss, fresh RAM/root>=8GiB/data>=30GiB, exact adopted guest image and dedicated
protected home, claimed devports5180-5299, independent alive watchdog first complete healthy
sample, exact label/PID/start/group, <=1800s monotonic run, heartbeat<=90s, nominal5s sampling,
fail-closed floors/measurement/log/home+socket>=10GiB, lock/stop intent and exact-label emergency
closure. Guest network-none UID1000,2CPU/4GiB/512PIDs; gateway network-none UID1000,0.5CPU/128MiB/
32PIDs; RO roots, dropped caps/default profiles/no-new-privileges, bounded tmpfs/logs, no gateway
home or API guest/Docker/device mount. Monitoring is not quota. Preserve full immutable IDs,
CAS versus creation generation, pending intents/root identities/failed-cleanup identities;
known-ID container404 only proves absence. Disable gateway-first, retain data, never remove
volumes. No always-successful admission/config bypass or production restart/data substitution.

#3618 installed lifecycle, exact image fit, independent admission/watchdog/TigerVNC/closure and
#3619 ordinary owner HTTPS/WSS/trusted viewer/approved chat plus real login/frame/input/takeover/
return/intentional-close, hostile/expired/revoked sessions and stale/pressed input remain open.
Idle sleep/wake, confined Internet egress and release/platform claims remain separately bounded.
No model calls/UI here; later status derives from records, model only authorized task/next input.

## Plan review ledger

Independent read-only process_plan_security R1 on6725432be: BLOCKED.
Accepted B1: data-progress watchdog did not specify a reliable public predecoder deadline; replace
with always-armed2s complete-binary-message deadline, closing idle too. Accepted B2: generic client
stream-loss cascading could disconnect during expected parser retirement and fence a valid return.
Only control-channel/protocol failure cascades; raw stream close retires that local stream and core
owns visual-loss policy. No disputed findings. Use fixed URL with public Unix createConnection to
avoid ws+unix path encoding ambiguity. Exact amended plan requires acceptance before code.

Implementation seam correction before source acceptance: reserve the exclusive IPC endpoint before
opening guest transport. Publishing only after core startup could let a duplicate process connect
a second guest upstream before detecting an existing listener. Accept no client while starting;
failed startup and concurrent shutdown must remove the owned endpoint. Independent R3 contract
review required before this ordering amendment is implemented. Existing R1/R2 rulings stand.
