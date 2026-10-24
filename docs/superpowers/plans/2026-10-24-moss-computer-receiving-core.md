# Computer terminating receiving gateway core

Part of #3618/#3619/#3616/#3577. Pinned base `46a12cf1e8ea9dcc237d830b4db01315dec3fb5b`,
merged PR #3627; accepted auth source `371386564566b44190cc269b1c1845a683899ea1`.
Implementer: `computer-receiving-gateway`. Continuing independent review, fix, exact verification,
merge and verified fresh isolated successor authority comes from the receiving dispatch.

## Bounded delivery and evaluation

Build the terminating receiving **core**, composing real auth IPC, the sole accepted input writer,
a predecoder guest envelope and framebuffer fan-out over standard RFB. It is an internal library,
not installed into ordinary API boot. It opens no guest socket itself: the later separately
supervised executable owns exactly one websockify connection and passes its Duplex here.
Do not embed the guest decoder in the ordinary API process. No browser route, UI, image build/load,
DB or Docker mutation, guest launch or runtime admission is in this candidate. These remain hard
tracked dependencies under #3618/#3619, not waived predicates. Evaluate this core before process
packaging/admission, then actual owner UI. No app-map change for an unadvertised internal library.

The guest decoder and process/admission supervisor are different trust boundaries. This candidate
establishes bounded standard-protocol composition; a later exact image, independent admission,
watchdog and actual TigerVNC proof must establish the installed boundary. Keep every parent open.

## Current seams, including vendor limitations

- `apps/api/src/computer/rfb-input.ts:25-58,95-113,205-246`: accepted receiver composes one writer,
  session checks, immutable parsers and normalized key/pointer input. Its RFB connections do not
  publish framebuffer updates. Add an optional synchronous connection hook after its guards are
  installed, exposing viewer, connection, raw transport and bounded parser stream together;
  gateway attaches frame-request handlers there, never a second input parser/writer.
- `apps/api/src/computer/rfb-input-stream.ts:5-45`: viewer parser lifetime ingress is capped64KiB.
  Preserve it, including watcher isolation; large guest frames never enter this input direction.
- `apps/api/src/computer/rfb-input-writer.ts:23-58,87-120`: requires Fence, bounds dimensions,
  releases inputs and waits for correlated BlockBefore acknowledgement. Preserve it.
- `apps/api/src/computer/auth-client.ts:24-182`: real private channel supplies immutable issued
  owner binding, fresh checks, active polling/absolute expiry and synchronous invalidation.
  Consume it directly, never session-table queries, credentials or a test admission adapter.
- `scripts/computer-host.ts:1-40` deliberately installs unavailable admission;
  `scripts/computer-host/spec.ts:20-79` fixes a separate network-none gateway with no guest home.
  This candidate does not replace admission or launch anything.
- Inspected installed pinned `rfb2@1.1.0` dist: `transport.js:76-83` feeds ByteReader directly;
  `reader.js:30-42` retains incoming chunks without a cap. `client.js:715-744` retains all rects in
  an update; it accepts decoder-supported unrequested encodings. `decoder.js:90-165` admits
  pseudo-resizes/cursors; therefore requested Raw alone cannot establish decoder bounds.
  `server.js:35-72,102-116` converts and concatenates output before void writes. Enforce bounds
  before those calls and inspect actual downstream stream backlog. No private vendor imports.
- `spikes/moss-computer/entrypoint.sh:21-22,38-39`: adopted guest is fixed1280x800, RFB3.8 None
  over private websockify. The core consumes an already connected standard-RFB Duplex; it never
  exposes that unauthenticated guest transport to browser/API callers.

## Guest envelope contract

New `apps/api/src/computer/guest-envelope.ts` exports `boundedComputerGuest(stream: Duplex): Duplex`.
This is a rejecting standard-RFB wire envelope, not a new desktop protocol or decoder. rfb2 still
owns handshake, pixel decoding, Fence and viewer input. No vendor monkeypatch or private API.

Before forwarding guest records, validate exactly RFB003.008, a bounded security offer containing
None, successful4-byte security result, and ServerInit dimensions1..1280 by1..800, true-colour
32-bit depth24 format and name<=4096bytes. Reject other handshakes; never follow a server-selected
TCP/TLS target or accept credentials. The trusted client selects None and requests bgrx pixels,
Raw and Fence only, no autoUpdate/continuous updates, clipboard, resize or cursor extensions.

After handshake, permit only FramebufferUpdate, Bell and Fence. FramebufferUpdate has<=256rects,
only Raw rectangles, positive in-frame geometry, total pixel bytes<=1280*800*4 per update and
wire overhead<=4096. Reject every other encoding/message before forwarding its header to vendor.
Fence length<=64; all bits/payload semantics still belong to the accepted writer/vendor.
An entire validated update is released at once, then yield a turn before another record so the
vendor async parser can finish. Partial records and one incoming chunk are each capped to one
maximum update plus header allowance. Pause raw source while processing; reject oversized chunks
rather than retaining them. Bound partial-record wall time to2seconds, including slow trickles;
handshake absolute2seconds. Empty idle is allowed, auth liveness remains independent.

The client issues one update request at a time, nominal maximum5Hz; no per-viewer upstream.
Enforce one outstanding frame response and2second response deadline. Unsolicited frame updates
retire the core. The wire envelope may buffer a bounded record before this core check, but cannot
invoke arbitrary compressed decoders. No accumulation of multiple updates in vendor ByteReader.
On bounds, malformed input, partial timeout, guest close/error or output backlog failure, retire
permanently and close the source; no reconnect or late continuation.

## Gateway and viewer contracts

New `apps/api/src/computer/receiving-gateway.ts` exports
`connectComputerReceivingGateway({ownerUserId, authSocketPath, upstream: Duplex})`.
It resolves only after real vendor connect and Fence announcement, within2seconds. It creates
exactly one RfbClient and ComputerRfbInput. Width/height remain fixed for that lifetime.
The caller is trusted local composition, never a browser-selected socket/path or upstream.

The returned core exposes `openViewer(viewerId)`, `attachWatcher(handle, stream)`,
`takeOver(handle)`, `attachController(handle, stream)`, `returnToMoss(handle)`,
`closeViewer(handle)`, `disconnect(handle)`, agent lease/dispatch and sanitized `snapshot/close`.
Handles are process-local object capabilities, never browser IDs. `viewerId` is API-issued private
IPC metadata, not browser auth. At most4 pending+active viewer lifetimes; reserve capacity before
awaiting auth; duplicates rejected and never automatically retried. Each open consumes the real
`connectComputerAuth` and receiver.connect path. Fresh checks route by fixed owner/session to an
active auth channel; after-await terminal checks prevent late opens or transfers from reviving.

Auth invalidation synchronously calls receiver.invalidateSession and destroys every corresponding
viewer stream before asynchronous cleanup. Deliberate local auth-channel
retirement sets an explicit local-retired marker before channel.close and suppresses only that
local callback, never an unexpected auth loss/push. Closing a watcher must preserve another
controller, including the same login session. Track exactly which channel supervises the current
Moss grant. Intentional controlling close first awaits receiver.closeViewer and retains its channel
as a bounded grant monitor; unexpected visual loss likewise retains a channel only if it already
supervises the existing Moss grant. After a successful authority transition, transfer monitor
ownership before intentionally retiring an obsolete monitor. Closing old monitors must not fence
a newer same-session grant. Actual auth invalidation still retires all affected session viewers
and grant immediately. Count retained monitors inside the4pending+active lifetime cap. A failed
close stays paused. No orphan grant without active supervision or independent auth implementation.

Receiver hooks attach exactly one bounded renderer per parser, after policy handlers. Store one
bgrx framebuffer<=4,096,000bytes using public rfb2.Framebuffer. Apply only validated Raw rects
through its bounded put path; never retain history,
compressed bytes, clipboard or guest HTML. Each viewer update request sets one pending boolean;
coalesce requests rather than queue them. At most5Hz, send a full current frame only when pending.
Output is standard RFB Raw through the same RfbServerConnection; only32-bit little-endian depth24 true-colour bgrx
and rgbx viewer formats are supported initially via vendor conversion. Retained adopted noVNC
uses rgbx (red0,green8,blue16), whereas native X commonly uses bgrx; reject other formats.
Preflight the sum of raw Duplex AND bounded parser Duplex writableLength plus packet length
against two frame packets; the latter can queue while raw write awaits a stalled callback. Destroy a slow
viewer on overflow. No unbounded send queue; no drain-as-consumption claim. Late frame callbacks
check core/viewer/connection lifetime. Frame readiness is false until the first actual full frame;
initially request a complete update and require the first response to contain a single full-screen
Raw rectangle before reporting frame readiness. Watchers share that frame without acquiring input authority.

All policy transitions retain existing receiving epochs, stale queue guards, pressed releases,
post-Fence fresh auth and matching acknowledgements. Parser replacement/transfer deliberately
retires former controller stream; watching never becomes writable. Agent input uses only the
accepted writer. Gateway close synchronously fences input before any await and closes auth,
viewers, timers and upstream idempotently. No automatic reconnect or changed authority on loss.

## Verification and negative controls

Inspect cached dependencies first; scoped frozen offline install only. No DB/foundation command.
Expected exit0, unpiped, logs outside `~/Jarv1s`:

- `pnpm exec vitest run tests/unit/computer-guest-envelope.test.ts tests/unit/computer-receiving-gateway.test.ts tests/unit/computer-rfb-input.test.ts tests/unit/computer-input-control.test.ts tests/unit/computer-auth.test.ts tests/unit/computer-auth-lifetime.test.ts`.
- `pnpm exec tsc --noEmit`; `pnpm exec tsc -p tsconfig.tests.json --noEmit`.
- Scoped `pnpm exec eslint ... --max-warnings=0`, `pnpm exec prettier --check ...`,
  `pnpm check:file-size`, `git diff --check`.

Exercise actual rfb2 wire parsers and real Unix auth IPC with synthetic session lookup, not fake
transport callbacks. Fixture supplies Fence because rfb2 server does not; no TigerVNC claim.
Prove exact frame pixels through watcher and controller, no watcher guest input, real owner input,
takeover/return/intentional close, same-session watcher close preserving another controller,
old monitor cleanup preserving a new same-session grant, active push immediately fences delayed input, lost auth/guest,
late open after shutdown, viewer capacity including pending binds, timeout/fragment/flood/geometry/
encoding/update bounds, actual noVNC rgbx red/blue-distinct pixels, unsupported viewer format and real stalled output. Remove protections
separately: raw-encoding whitelist, geometry/pixel cap, idle partial timeout, auth retirement,
post-await lifetime and output preflight. Each must fail at the intended assertion, not compile or
harness timeout; restore exact source and rerun green. Retain hashes and all reviewer rulings.

Independent read-only security/spec acceptance of exact committed contract precedes code.
Then code-review Standards+Spec against pinned base; fix, verify exact source/evidence and required
CI, independently review evidence, merge internal dependency and verify fresh isolated successor.
Kill owner `computer-receiving-gateway`: stop/split if bounded standard RFB needs unsupported vendor
internals or cannot preserve the sole writer. No custom compression/desktop protocol or weaker
Fence/auth fallback. No model/UI work here; later record-derived UI, model only authorized task
selection and next input proposals.

## Runtime handoff contract: not launch permission

Next process packaging must connect one adopted guest UnixWS socket, use this core in a **separate**
gateway image, and expose bounded private API IPC only. Build/qualify exact gateway image before
configuring its hash. Keep host unavailableAdmission until independent fresh resource service,
watchdog, synchronous receiver retirement and independent closure are actually implemented and
accepted. Preserve pending intents/full IDs/CAS/root identities and explicit unresolved-intent
recovery; disable gateway-first, retain home, no volume deletion. Never fake admission.

Before any live work: exact separately committed packet, independent acceptance, fresh healthy
Moss and RAM/root>=8GiB/data>=30GiB; adopted exact guest image (no new r21 qualification), protected
dedicated data and claimed devports. Guest network-none UID1000,2CPU/4GiB/512PIDs; separate gateway
network-none UID1000,0.5CPU/128MiB/32PIDs, read-only roots, dropped caps/default profiles, bounded
tmpfs/logs. API gets no Docker/devices/guest socket; gateway gets no guest home. Watchdog alive
before launch, first complete healthy sample, <=1800s run, <=90s heartbeat, nominal5s samples,
fail closed on floors/measurement/log/home+socket>=10GiB, exact label/PID/start/group closure and
stop intent. Monitoring is not quota; no production restart/data substitution/deployment.

Real TigerVNC Fence behavior, exact image/runtime lifecycle and ordinary owner HTTPS/WSS/trusted
viewer/approved chat design remain #3618/#3619 gates. Actual login/frame/input/takeover/return/
close, hostile active sessions, stale/pressed input and independent evidence/closure must pass
before #3616/#3577 completion. Idle sleep/wake, confined useful Internet and platform/release
claims remain separate. Historical private artifacts are read-only; own state stays outside tree.

## Review ledger

Independent read-only `/root/gateway_security_review` R1 on `d52d1918c`: BLOCKED.
Receipt SHA-256 `e377ef132d9c1ea2c620f5460f4a9236d2edbd96074088ac98383a497fc87c2e`.
Accepted B1: raw output backlog alone misses queued writes in the receiver adapter; sum both
queues before output. Accepted B2: deliberate auth close must preserve same-session controllers
and transfer grant-monitor ownership before closing stale monitors. Accepted B3: retained noVNC
actually selects rgbx; support both verified32-bit formats through bounded vendor conversion.
Add intended behavioral regressions for all three. No disputed findings. Process packaging must
also cap WebSocket payload/queues before its decoder; this core begins at an already connected
Duplex and cannot qualify that absent transport or total image fit. Exact amended plan requires
R2 acceptance before implementation.
