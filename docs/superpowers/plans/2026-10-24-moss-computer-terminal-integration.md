# Computer root observer to receiving lifetime fencing

Part of #3618/#3617/#3616/#3577. Base `6da85fff63ab4e0144bab49caa99086934ee004a`,
verified actual PR #3647 merge. Its final `346bcadd3dda2a150889a7643da597787e799c30`
passed run40089817925 attempt1 and required CI gate; the PR records independent final local
and supplemental CI/evidence acceptance before merge. This is the next bounded contract under
the [terminal dispatch](../handoffs/2026-10-24-moss-computer-terminal-integration.md) and complete
[lifetime dispatch](../handoffs/2026-10-24-moss-computer-lifetime-fencing.md).

## Scope and verified seams

Deliver actual opt-in root-observer-to-receiver lifetime IPC and terminal acknowledgement for
**existing exact resources**. Consume the real supervisor and receiving core; no replacement
policy, successful admission stub, fixture closure certificate or new RFB implementation.
This remains internal tooling: no normal API boot, product surface/app-map capability,
deployment configuration, image/runtime operation, Docker mutation or production deployment.
unavailableAdmission remains unchanged. Parent owner issues remain open.

Current source seams, checked before this plan (graph covers API; scripts required bounded reads):

- `apps/api/src/computer/gateway-server.ts:31-48,71-90`: exclusive endpoint before guest;
  close sets closed and invokes core.close before asynchronous teardown. Existing viewer header
  parsing starts at99; reserve a dedicated lifetime slot separately from the ordinary12 sockets.
- `apps/api/src/computer/receiving-gateway.ts:234-247`: close retires input epochs, frames,
  grants and viewer entries synchronously, then finishes upstream cleanup asynchronously.
- `apps/api/src/computer/gateway-channel.ts:19-99`: existing bounded1024byte newline channel
  permits one frame per chunk, so it is unsuitable for valid terminal delivery coalescing with
  an in-flight renewal. Add a dedicated bounded lifetime parser, not a generic protocol framework.
- `scripts/computer-gateway/config.ts:9-60`: NOFOLLOW|NONBLOCK private regular0600 configuration,
  canonical0700 parent,4096byte cap and exact keys. Extend the exact schema; never infer defaults.
- `scripts/computer-watchdog/supervisor.ts:161-229,311-338,382-412`: terminal latch, independent
  collector/journal finalization, accepted sample persistence and executable composition.
- `scripts/computer-watchdog/trust.ts:20-107,244-316`: trusted config/code/namespace anchors
  and immutable config revalidation. pid/mnt/user anchors do not establish shared monotonic time
  across gateway containers; receiver deadlines use its own clock.
- `scripts/computer-watchdog/observe.ts:68-113,130-169`: exact Docker/spec/log checks and stable
  before/after host state. Fenced mode must additionally require the configured exact running pair.
- `scripts/computer-host/spec.ts:42-49`: gateway /ipc and separate read-only /config mount;
  API may reach /ipc but receives neither gateway config nor guest/Docker/device access.
  Launch operations do not provision per-run gateway configuration after create/save and before
  start. That missing service remains implementation work after this existing-resource slice.

Reuse the existing endpoint with a dedicated lifetime header, instead of a new mount/root socket
hierarchy. A separate endpoint could simplify routing but would add ownership/mount machinery
without distinguishing same-UID API/gateway callers. Authenticate with config-held per-run HMAC
proofs; pathname or Unix UID alone never proves trusted root identity. Replacement may deny
service but cannot furnish a valid fencing proof without the secret. Installed config isolation
and root deployment are separate exact-packet acceptance requirements, not established here.

## Fixed configuration and binding

Add `apps/api/src/computer/lifetime-protocol.ts`, `lifetime-channel.ts`, `lifetime-receiver.ts`;
`scripts/computer-watchdog/lifetime.ts`; narrow edits to gateway config/server and watchdog
trust/observe/supervisor/CLI. Native suites/fixtures cover both authority ends.

`ComputerLifetimeConfiguration` has exact keys `binding,secret`. Binding has exact fields
`runId,instanceId,requestGeneration,desktopId,desktopGeneration,gatewayId,gatewayGeneration`.
UUIDs, safe positive generations and full lowercase64hex distinct Docker IDs only. Resource
creation generations cannot exceed requestGeneration. Snapshot/freeze all fields. Secret is
exact lowercase64hex (256random bits), provisioned freshly per run into separate trusted root
and gateway configuration, never supplied by API/browser/guest and never sent on the wire,
logged or included in receipts. The later packet owns actual randomness/provisioning/isolation.
This slice never writes installed configs. Public evidence contains hashes and sanitized metadata.

Gateway config requires `lifetime` in addition to its existing four fields. No legacy ungated
executable fallback. Root config optionally adds `lifetime`; old `observe` remains read-only.
New explicit CLI `fence <trusted-config>` requires it; `observe` refuses it to prevent a misleading
configured-but-inactive boundary. Collector mode can parse either schema, but opens no IPC.
Root derives the fixed host endpoint `<host.gatewayDir>/gateway.sock`; gateway container config
uses its corresponding fixed mount path. No browser/environment/request-selected target.
Validate binding run/instance against root config and exact enabled state requestGeneration,
both full IDs and immutable creation generations before/after observations. In fenced mode,
exact Docker inventory must contain both running resources; absence or replacement is terminal.

## Authenticated bounded lifetime

All messages use exact keys, fixed types and HMAC-SHA256 with constant-time MAC comparison.
MAC input is domain-separated by protocol version, message type, canonical binding and all
message fields except MAC. No secret travels to a receiver-controlled endpoint. Receiver begins
with a signed challenge containing a fresh random128bit session nonce, fresh128bit challenge
nonce and sequential counter1. Root verifies proof before responding. Alive response and active
acknowledgement bind those exact fields with their own type-separated MACs. Never reflect a MAC
as another message type. One receiver challenge outstanding; sequential counters<=4096.
After an accepted response, issue the next challenge nominally1s after the preceding challenge;
each challenge has one absolute receiver-local1s reply deadline. Equality expires. Byte tricks,
invalid frames or stale/late responses never renew it. No cross-process clock assumptions.

Root opens one connection only after the first complete policy-healthy sample has been durably
journaled. Recheck policy expiry and that initial sample age is<5s after awaited persistence,
before connecting/responding; no publication from a late sample completion. Every later response
rechecks current policy.tick, including run/heartbeat/sample gap; IPC messages do not renew runner
heartbeat, restamp measurements or replace nominal5s collection. Existing receipt age<5s and
gap<10s remain distinct. Root permits at most one outstanding challenge response/ack, with a
local2s absolute acknowledgement deadline. It treats malformed/forged/stale/late/extra messages,
EOF, connection error, active-ack timeout or receiver loss as terminal supervisor failure.

Gateway reserves its existing exclusive endpoint before guest connection. It admits no API
viewer/control/watch connection before authenticated lifetime activation; unbound API sockets
are rejected immediately. Initial lifetime must arrive within5s of endpoint publication; this
absolute startup deadline does not reset during guest setup. Startup/lifetime loss during awaited
guest/core creation destroys late completions before API admission. Keep one pending/active
lifetime slot, distinct from12 API sockets. Candidate lifetime headers have a2s absolute limit;
invalid authentication fails the entire gateway closed. Once one lifetime has bound, replacement
attempts close the core; never reconnect/restart into a former epoch.

The dedicated parser bounds raw chunk<=4096, partial line<=1024, at most4 complete frames per
event and actual outgoing backlog plus next frame<=4096. It accepts coalesced final renewal/stop
without an unbounded queue. Wrong/unknown/extra fields and counters, duplicate/stale challenge
responses, partial timeout2s and unexpected EOF permanently retire the lifetime. Preserve the
existing guest predecoder and all API/RFB bounds; lifetime traffic cannot enter RFB parsers.

## Terminal ordering and acknowledgement

Root terminal entry immediately and irreversibly prevents further alive responses, before any
await. Independently initiate a signed stop with a fresh128bit stop nonce, and journal persistence
and collector termination. Cancel pending renewal acknowledgements without permitting their late
completion to reactivate anything. Stop is accepted even with a pending challenge/renewal; it binds
the current session nonce and exact configuration. No reconnect to deliver it. Root accepts only
a signed fenced acknowledgement with its exact stop nonce and session/binding; deadline2s.
Lost connection before/during stop is failure, never an invented fencing acknowledgement.

Receiver sets closed, invokes the existing gateway close/core.close synchronous retirement,
then sends the signed fenced acknowledgement. A narrowly separated transport-retirement callback
keeps only the lifetime socket alive long enough for that bounded write; no viewer/frame/input
admission survives it. Ack proves local retirement was invoked, not successful pressed-release
delivery after upstream loss, completed asynchronous transport teardown or independent Computer
closure. Failed ack/write stays failure. End the lifetime after its flushed ack; close only owned
resources. Root's outcome explicitly reports receiverFenced; fenced mode cannot return success
without it plus the inherited durable-stop/collector-exit/descriptor-close acknowledgements.
Keep the single absolute5s terminal finalization deadline; receiver2s wait never postpones it.
Repeated TERM/INT remain terminal no-ops through finalization; retain failed receipts/identities.
Root death closes the socket; a suspended/hung root expires at the receiver challenge deadline.
Distributed delivery is bounded, not synchronous shared memory or hard real time under suspension.

## Verification and evaluation

Independent read-only security and Spec acceptance of this exact committed contract precedes
implementation. Kill owner: computer-terminal-integration. Split/reject if this requires generic
exec, root privileges in API, bearer-secret transmission, gate bypass, new admission or self-certified
resource closure. Evaluate this actual IPC composition before normal terminal lifecycle integration.
No model or UI here; later feedback derives from records and model selects authorized task/input.

Expected0 unpiped with private logs outside ~/Jarv1s: native lifetime/gateway/supervisor/observation
tests and affected auth/receiving/host suites; root `pnpm exec tsc --noEmit`, tests
`pnpm exec tsc -p tsconfig.tests.json --noEmit`; scoped ESLint max-warnings0 and Prettier;
`pnpm check:file-size`; `git diff --check`; builtin-only observer bundle and gateway build.
Inspect cache before frozen install including root/API/worker/web/spike and workspace dependencies.
No DB/foundation command, TCP server, browser, Docker/image or real Computer operation.

Native temporary Unix sockets and separate executable processes must exercise real supervisor
terminal entry to actual gateway/core retirement, active owner wire input, watcher frames and
pressed releases through accepted RFB machinery. Use disclosed synthetic auth/readiness/Docker/
root-ownership/namespace and library Fence stand-ins; these do not establish installed root trust,
real health/inventory/TigerVNC, image/Node24/128MiB fit, live owner paths or independent closure.
Assert no API access before lifetime, terminal retirement before ack despite held async cleanup,
held journal fsync versus stop delivery, root EOF/death/hang, startup loss/late guest completion,
wrong binding/MAC/type, nonce replay, delayed/trickled challenge response, equality expiry,
forged/replaced endpoint acknowledgement, duplicate lifetime, API socket saturation, chunk/line/
backlog bounds and bounded native process/socket cleanup. Security assertions must be observed
failing at their intended assertion with the relevant protection removed; retain failed attempts
and patches/log hashes, restore source byte-for-byte and run final green checks.

Independent Standards+Spec/security source review at pinned base, corrections, exact final local
evidence acceptance and exact final HEAD required green CI precede protected actual merge.
Verify merge; herdr-handoff launches/verifies a fresh isolated successor with durable routing name,
actual session UUID and handoff-read execution. Leave clean pushed tree and owned resources closed.

## Preserved remaining gates

This does not integrate normal disable/recreate or daemon/supervisor lifecycle mutation, provision
post-create runtime configs, reset/new-run admission, reconcile uncertain create quiescence,
steal crash locks or prove independent Computer closure. Preserve stop-file+directory fsync before
mutation, canonical sole lock, request CAS versus resource generation, full IDs/pending intents/
roots/failed cleanup; gateway-first exact cleanup after fencing or separately accepted forced stop.
Only initial known-ID inspect404 proves absence; no pending-name404 inference, retry create,
identity erasure, volume/home deletion or terminal reset. Separate closure rechecks resources,
PID/start/group/endpoints and healthy Moss; neither journal self-certifies it.

Before ANY Computer image/runtime operation: separately committed independently accepted exact
packet; fresh healthy Moss, RAM/root>=8GiB/data>=30GiB, independently alive watchdog and first
complete healthy sample before launch. Preserve hrtime run<=1800s, heartbeat<=90s, nominal5s
samples/gap<10s/receipt age<5s, timestamps before first I/O, no sample heartbeat renewal,
equality expiry, actual bounded logs/home+socket<10GiB, root code/config/namespace trust and one5s
observer finalization with durable/exit acknowledgements. Sampled accounting is not quota or
continuous liveness; host/event-loop suspension is not hard real time. Inspect every sample/reason
and independent closure; retain emergency exact-label cleanup and failed records.

Adopted exact guest image/protected dedicated data; guest UID1000/network-none/2CPU/4GiB/512PIDs;
separate gateway UID1000/network-none/0.5CPU/128MiB/32PIDs; RO roots/dropped caps/no-new-privileges/
default profiles/bounded tmpfs/logs/no gateway home. No unrestricted bridge, production restart,
data substitution or deployment. Actual image/Node24/128MiB/TigerVNC/fixed lifecycle and independent
closure precede installed usability. Reuse accepted r21 persistence; r12/r18 causes remain unknown.
Preserve sole writer, synchronous auth retirement, immutable epochs, pressed releases, matching
BlockBefore Fence and fresh post-Fence auth; stable control is separate from replaceable raw RFB.
Real cookie/exact Origin/HTTPS/WSS/trusted assets/chat/agent leases and positive/hostile/expired/
revoked/stale-input live evidence precede owner completion. Product app-map and dev/prod config
accompany product wiring. Dev servers require devports5180–5299. Keep parent issues open.
