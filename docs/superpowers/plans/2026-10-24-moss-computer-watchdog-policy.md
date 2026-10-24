# Computer watchdog policy prerequisite

Part of task #3618 and #3616/#3577. Pinned base `5b10880d016b61f280140c3359c8aad1ad54c0db`,
merged packaging PR #3640. Follow the [admission dispatch](../handoffs/2026-10-24-moss-computer-admission-watchdog.md)
and persistent-desktop spec sections 24–27. Independent review → resolve → exact checks/evidence/CI
→ merge → verified fresh isolated successor continues until actual owner integration finishes.
No production deployment or bypass of runtime/live-path gates.

## Bounded outcome and seams

Deliver a deterministic, fail-closed watchdog **decision policy**, with no resource acquisition,
process launch, timer, listener, Docker/image/guest/DB/browser operation or host integration.
This is a no-runtime prerequisite, not an independently running watchdog or launch admission.
It issues no capability and cannot replace unavailableAdmission. No product behavior/app-map or
deployment requirement changes. No accepted r21 persistence rerun; r12/r18 causes remain unknown.

Current tree checked before planning (initial graph path-filter queries were insufficient;
bounded source reads verified these seams):

- `scripts/computer-host/operations.ts:11-21` defines the launch admission port and deliberately
  unavailable implementation. `:74-92,133-162` invalidate before disable/failure and retain failed
  cleanup identities. A pure resource predicate is insufficient to implement that port.
- `scripts/computer-host.ts:26` still supplies unavailableAdmission. Leave it unchanged.
- `scripts/computer-host/state.ts:15-26,100-176` owns resource creation generations/full IDs,
  pending intents, canonical roots and exclusive daemon lock. This policy must not own or erase them.
- `scripts/computer-host/spec.ts:20-79` fixes separate guest/gateway resource/isolation envelopes.
- `apps/api/src/computer/receiving-gateway.ts:136-250` composes receiver/auth retirement; a policy
  decision alone is not synchronous cross-process receiving invalidation or actual closure.
- Packaging source `31983368533b2115f0394d22e925985ba0118f26` and final evidence candidate
  `1c5f4a462b5a1cc115b8bc09a49bade6ed470474` were independently accepted; PR #3640 actually merged
  with required CI gate SUCCESS. A bundle/recipe is not a qualified gateway image.

Implement policy first rather than combine trusted Linux measurement, independent process
supervision, Docker recovery and receiving invalidation in one new boundary. Directly wiring a
sampler into assertAdmitted would be shorter, but would grant launch without independent lifetime
supervision or accepted closure. Those concrete integrations are mandatory successor work, not
assumed capabilities. Kill owner: computer-admission-watchdog; split/reject if this library begins
granting launch, executing cleanup or claiming independence from supplied identity metadata.

## Exact policy contract

Files: `scripts/computer-watchdog/policy.ts` and
`tests/unit/computer-watchdog-policy.test.ts`. No runtime dependencies or package scripts.
Export `ComputerWatchdogPolicy` and readonly process/sample/decision types and fixed limits.

Constructor takes trusted `runId` (UUID), monotonic integer `startedAtMs` and fixed runner/watchdog
identities `{pid, startTicks, processGroupId}`. PIDs/groups are positive safe integers; startTicks
is a positive decimal string up to 20 digits. Runner/watchdog PIDs and groups must differ. Copy
configuration, never retain mutable identity objects. Invalid configuration throws a fixed error.
Matching metadata is necessary, not proof of actual OS identity or independent supervision.

Methods (signatures only): `sample(nowMs: number, value: unknown): WatchdogDecision`,
`tick(nowMs: number): WatchdogDecision`, `heartbeat(nowMs: number): WatchdogDecision`,
`stop(nowMs: number): WatchdogDecision`, and readonly `decision`. No callback/async work or I/O.
Caller supplies a trusted single monotonic millisecond clock; never wall time or guest timestamps.
Each call checks finite safe nonnegative now and nondecreasing time, run duration, heartbeat and
missing/stale samples **before** accepting a new sample or heartbeat. Late activity cannot rescue
an already expired run. Returning healthy never authorizes launch by itself.

Initial decision is waiting. The first complete healthy sample is required for healthy. Maximum
run duration is 1,800,000ms; heartbeat expires at 90,000ms since startup/last explicit heartbeat.
Samples do not refresh heartbeat. Nominal collection interval is 5,000ms; maximum gap since startup
or the last sample's measurement time is 10,000ms (one missed nominal sample closes the policy).
These are fixed upper bounds, never operator relaxation options. At each limit equality stops.
Caller must tick independently of measurement completion; a policy without a running scheduler
cannot enforce deadlines. Host/event-loop suspension is not a hard real-time guarantee.

Sample is an exact-key object containing `runId`, `measuredAtMs`, `runner`, `watchdog`,
`availableMemoryBytes`, `rootAvailableBytes`, `dataAvailableBytes`, `homeBytes`, `socketBytes`,
`mossHealthy`, `logsBounded`, `stopRequested`. Each process is its exact configured identity plus
`state: "running"`; any dead/zombie/replaced/missing process fails closed. Extra keys reject.
Every byte/time measurement is a nonnegative safe integer; booleans must actually be booleans.
Measurement time is >=startup, <=now, strictly newer than the previous sample, and less than
5,000ms old at receipt. The future trusted collector must anchor measuredAtMs before its first
measurement and never stamp old measurements as new. Missing/failed/invalid measurements stop.

Floors: available memory and root available space each >=8GiB, data available space >=30GiB.
Home+socket total must be <10GiB. Moss must be healthy and logsBounded true; the successor must
independently verify bounded log configuration/actual growth and bounded writable receipts.
stopRequested true stops. Monitoring is not quota. No filesystem scan, health measurement or
log-bound verification is implemented by this policy.

Decision is a frozen discriminated union: waiting/healthy with reason null, or stopped with one
fixed reason: clock-invalid, run-deadline, heartbeat-expired, sample-expired, measurement-failed,
identity-changed, moss-unhealthy, logs-unbounded, resource-floor, home-limit or operator-stop.
First terminal reason is retained forever. No late healthy sample/heartbeat/stop can resurrect it.
No mutable internal decision or config escapes, no sample history/queues, memory stays constant.
The reason is diagnostic metadata; actual receiving invalidation, stop-intent durability, verified
cleanup and retained failed identities remain separate required implementations.

## Behavior and verification

Exercise the actual exported policy with deterministic monotonic times and boundary vectors.
Prove waiting before a full sample, exact floors, identity/run mismatch, zombie/replacement,
missing/unknown/nonfinite/unsafe fields, stale/future/duplicate measurements, backward clock,
first-sample expiry, periodic sample expiry, independent heartbeat, duration, operator stop and
permanent first-reason retention. Mutating constructor/sample/decision objects must not alter
future decisions. Tick must stop a run even when no measurement completes. Tests are policy
proof only; they are not real Linux measurement, independent supervision or resource closure.

Observe separate removed-protection controls fail at intended assertions for resource floors,
terminal nonresurrection, process identity, heartbeat independence and pre-update expiration.
Restore exact source after each, then rerun the full scoped green suite; retain every attempt.
Before tests, search Hindsight conventions. Inspect existing install/cache, then scoped frozen
offline install including root, API/workspace dependencies, worker/workspace dependencies, web
and visual-chat spike for root checks. No manifest/lock changes. No DB/foundation command needed;
any future DB work requires verify-gate with isolated target.

Unpiped commands, expected exit0, private logs outside ~/Jarv1s: focused new policy plus existing
host service/client suites; `pnpm exec tsc --noEmit`; `pnpm exec tsc -p tsconfig.tests.json --noEmit`;
scoped ESLint max-warnings0 and Prettier; `pnpm check:file-size`; `git diff --check`.
The executed policy tests are this internal slice's end-to-end seam; no user UI is added.
No model calls or model-authored feedback. Later UI derives from records; model jobs remain
choosing an authorized task and proposing its next input.

Independent read-only security/spec acceptance of this exact committed plan precedes code.
After code: independent Standards+Spec review at pinned base, security review, resolve findings,
exact evidence/checks acceptance and required green CI before merge. Publish only sanitized
hashes/summaries; retain all failed attempts and review rounds privately.

## Mandatory continuation gates

Next implement the real root-trusted independent watchdog/measurement/receiving invalidation and
closure path, with fixed full container IDs/creation generations, request CAS, pending intents,
root identities, exclusive lock/stop intent and retained failed cleanup identities. Explicitly
design unresolved intent recovery; only known-ID container inspect404 proves absence. Disable
gateway first, retain dedicated home, never delete volumes. API gets no Docker/devices/generic
exec/guest sockets. No always-successful admission or config bypass. unavailableAdmission stays
until the complete boundary is independently accepted.

Before ANY image/runtime operation: separately committed exact packet independently accepted,
fresh healthy Moss and RAM/root>=8GiB/data>=30GiB, alive independent watchdog first complete
healthy sample, exact label/PID/start/group, <=1800s monotonic deadline, <=90s heartbeat, nominal5s
samples, fail closed on floors/missing/failed measurements/logs/home+socket>=10GiB. Inspect every
sample/reason, independently verify exact closure/healthy Moss. Preserve exact-label emergency
cleanup, adopted exact guest image/protected data and claim devports5180–5299 for servers.
Guest UID1000/network-none/2CPU/4GiB/512PIDs; separate gateway UID1000/network-none/0.5CPU/128MiB/
32PIDs; RO roots, dropped caps/no-new-privileges/default profiles, bounded tmpfs/logs, no gateway
home mount. No unrestricted bridge, production restart/data substitution or deployment.

Qualify actual built gateway image ID/Node24/128MiB fit/start/stop/Unix mounts/auth invalidation
before configuring its hash. Real adopted TigerVNC Fence proof and actual fixed lifecycle/closure
precede installed #3618 usability. Then #3619 ordinary cookie/exact Origin before upgrade, fixed
private binding/viewer IDs, trusted bundled assets, approved concise chat/browser UI and real
API-to-gateway agent leases. Credentials/viewer IDs stay out of URLs/guest mounts. Keep stable
control separate from replaceable raw RFB; preserve watcher isolation, pressed releases, epochs,
matching BlockBefore Fence/fresh post-Fence auth, unexpected-loss pause and intentional close.
App-map and affected dev/prod config accompany product wiring. Actual login→chat/browser→frame/
input→takeover→return/intentional-close, hostile/expired/revoked sessions, stale/pressed input,
independent exact evidence and resource closure are required. Keep parent issues open.
Idle sleep/wake, confined useful Internet egress and platform/release remain bounded work.
After merge, herdr-handoff a fresh isolated successor with this continuing chain; verify durable
routing name plus actual session UUID and handoff-read execution, not pane creation alone.

## Review rulings

Plan security/spec R1 accepted the no-runtime contract with one nonblocking discovery-account
correction; R2 accepted exact `1e0ddde4c` before code. Source R1 on `6d85512d5`: Standards passed;
Spec/security blocked reentrant sample inspection overwriting a terminal decision, and security
also blocked constructor accessors changing validated start time before storage. Both findings
were accepted. Snapshot constructor own data properties and reject accessors; inspect all supplied
process objects before rechecking current clock/terminal state and validating measurement order.
Regressions cover stop reentry at top-level and both process objects, newer nested clock/sample
history, and constructor getter rejection without invocation. Exact source R2 and final evidence
acceptance remain separate gates. All immutable review rounds and control attempts are retained.
