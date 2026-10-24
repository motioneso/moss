# Computer independently executing observation supervisor

Part of #3618/#3616/#3577. Base `81e2d112bb129eb146e6e80c18c9ad39861a45c2`, merged
measurement PR #3644. Accepted collector source `45820eda5ca9cd5a5b6c0e3645318a323a594aac`
and policy source `708d6a585ed4e920c26f16d19bc4e6cf33c64763` remain inputs, not admission.
The [trusted-supervisor dispatch](../handoffs/2026-10-24-moss-computer-trusted-supervisor.md)
authorizes independent review, fixes, exact checks/evidence/CI, merge and a verified isolated
successor until actual owner integration finishes. No production deployment.

## Scope, seams and evaluation

Implement an opt-in root-trusted observation supervisor, with a separately executing collector,
complete read-only samples and an irreversible durable stop journal. It runs independently of
the configured runner. It can observe and terminate its own collector only; it cannot launch,
stop or remove Computer containers. No launch capability, product route, listener, deployment
default or app-map capability is added. Host unavailableAdmission remains unchanged.
Actual deployment on the host is not established by fixture tests or root ownership predicates.

Current seams were checked before this plan; initial graph results lacked scripts, so bounded
source reads supplied these citations. The refreshed graph now includes the host script symbols:

- `scripts/computer-watchdog/policy.ts:130-275`: canonical fixed monotonic decision policy.
- `scripts/computer-watchdog/linux.ts:118-162`: real partial measurements, initial timestamp,
  repeated OS identity checks; no health/log/run/stop fields or namespace provenance.
- `scripts/computer-host/config.ts:58-116`: canonical distinct roots and ancestor validation.
- `scripts/computer-host/state.ts:29-46,97-176`: private JSON, root marker, durable resource state
  and exclusive daemon lock. Private JSON needs NONBLOCK before FIFO type validation. Reuse
  state parsing/read validation without acquiring or altering the daemon's lock/state.
- `scripts/computer-host/docker.ts:63-145`: exact immutable-ID/spec/inventory validation; image
  and pending-name404 do not establish absence. Its GET adapter can expose validated log paths.
- `scripts/computer-host/spec.ts:53`: fixed json-file 2m x2 configuration; actual log accounting
  is missing. Owner of that implementation in this slice: trusted-supervisor implementer.
- `apps/api/src/server.ts:401-423`: `/health/ready` checks DB and pg-boss; `/health` alone does not.
- `scripts/computer-host/operations.ts:11-21,133-153`: unavailable admission, local invalidation
  port and gateway-first cleanup. No root-to-gateway lifetime/fence channel or durable lifecycle
  stop intent exists. These remain concrete required successor work, described below.
- `apps/api/src/computer/receiving-gateway.ts:234-247`: close synchronously retires the receiver
  before its asynchronous work. Cross-process delivery is not synchronous shared memory.

Choose an independently executing collector process rather than a same-event-loop timer around
collection: synchronous traversal or a hung collector must not prevent policy ticks. A complete
supervisor plus lifecycle mutation/fencing would combine new root observation and cross-process
authority boundaries. Evaluate the read-only observer first. Kill owner: trusted-supervisor;
split/reject if this slice needs Docker mutation, generic exec, a health/log boolean override,
API privileges or a replacement admission. This is execution machinery, not another predicate.

## Root deployment/configuration contract

Files under `scripts/computer-watchdog/`: `trust.ts`, `observe.ts`, `journal.ts`, `supervisor.ts`;
opt-in `scripts/computer-watchdog.ts`. Focused tests under `tests/unit/computer-watchdog-*.test.ts`.
Reuse the existing collector/policy and bounded host HTTP. Export host state parsing and add the
missing NONBLOCK guard; add only a read-only validated Docker log-path method. No dependencies.

The executable is bundled with locked esbuild to one builtin-only CJS artifact, executed with
an absolute Node executable. The later accepted deployment packet installs that exact hash into
a root-owned non-writable ancestry and supplies a private root-owned0600 single-link regular
configuration file in a canonical root-owned0700 parent. Do not install/chown anything here.
Reject loaders/preloads (`NODE_OPTIONS`, `NODE_PATH`, extra execArgv), non-Linux or non-root
effective/real UID, writable/non-root code/Node/config ancestors, symlinks, nonregular files,
unsafe sizes, missing metadata, unknown keys and changed configuration/artifact bytes.
Open files NOFOLLOW|NONBLOCK before fstat; bound config<=16KiB, artifact<=2MiB.

Configuration fixes run UUID, exact runner PID/startTicks/process group, existing HostConfig,
pinned data/docker-data/monitor RootIdentity records, trusted loopback ready URL and expected
artifact SHA-256. It also carries independently provisioned expected boot ID and pid/mount/user
namespace link identities. Compare both this process and host PID1 to those explicit anchors;
require the initial full-range uid_map. Never discover an anchor and declare it trusted in the
same execution. Matching PID1 or UID0 alone is insufficient. Root-owned config is an operator
trust boundary, not cryptographic host attestation; actual namespace/deployment qualification
remains an independent exact-packet gate. No alternate proc root or environment fallback.

Use existing inspectRoots and the exact existing identity.json marker to validate host config
and roots; never initialize/reset a missing marker. Snapshot fields and bytes; revalidate every
observation. Pinned data/docker-data/monitor paths have trusted root-owned ancestors and do not
overlap host roots or each other, except data/docker-data may be ancestor storage filesystems.
Home/socket are dedicated guest-owned roots under trusted parents as the existing contract permits.
Monitor is root-owned0700 and outside all guest/API mounts. Runner and supervisor must be live,
have different PIDs and groups; derive supervisor identity from actual /proc, never a healthy flag.
The operator starts the supervisor separately, not through an API or guest request.

## Complete observation contract

`observeComputer(config, watchdog): Promise<WatchdogSample>` anchors measuredAtMs before its
first I/O, then revalidates deployment/config/recorded roots, reads the durable host state and
collects Linux measurements. Preserve the earliest timestamp across all work; do not use a later
collector timestamp to freshen earlier checks. Recheck state/marker/root identities and process
identities before returning. Any failure throws a fixed sanitized error, never substitutes values.

Health uses the configured trusted loopback HTTP(S) URL with exactly `/health/ready`, no userinfo,
query/fragment/redirect/proxy, absolute2s timeout and <=4096byte response. Require200 and the exact
record `{ok:true,db:"ok",pgboss:"ok"}`. No permissive `/health` fallback or external destination.
Tests use real private Unix HTTP fixtures through the existing HTTP seam and disclose that no
live DB/readiness or host admission is established. No TCP server is needed for this slice.

Read-only Docker inventory reconciles the exact durable resource snapshot using the existing
adapter, without mutation/retry. Validate actual json-file rotation settings through its exact
spec check. Return log paths only for verified full immutable IDs. Require each path to be the
canonical `<pinned Docker data>/containers/<full ID>/<full ID>-json.log`; validate trusted root
ancestors and nonsymlink regular root-owned single-link files, including the sole `.1` rotation.
Refuse additional matching rotations, unsafe metadata, each log>=2MiB, absent current log or
unaccounted inventory. Stat metadata only, never read private log contents. Log disappearance or
rotation races may conservatively stop. Prelaunch empty inventory is valid only after the actual
exact-label list is empty; a pending creation intent is never treated as absence.

Runner stdout/stderr and supervisor stdout/stderr must resolve to `/dev/null`; this avoids an
unbounded external log sink. The collector has only bounded pipes to its parent. Monitor's only
writable receipt is the owned journal: fixed header/sample/stop records, <=512KiB total with
reserved terminal space, <=400 samples, no private content/raw errors. Inspect actual journal
metadata and directory entries; unexpected files, replacement, excess bytes or outstanding write
at the next sample fail closed. These sampled checks are not quota/snapshot/continued-liveness
guarantees. logsBounded is computed from these checks, never supplied in configuration.

## Independent driver and durable terminal state

`runComputerSupervisor(...)` consumes the policy and monotonic clock. Executable bootstrap fixes
startedAtMs before startup I/O; time spent validating does not reset the run. All policy activity
uses hrtime milliseconds: run<=1800s, heartbeat<=90s, nominal5s collection, gap<10s, receipt age<5s,
RAM/root>=8GiB, data>=30GiB, home+socket<10GiB. Equality expires. Samples never renew heartbeat.

Supervisor ticks every1s without awaiting collection or journal writes. At most one collector
child and one outstanding journal write. Spawn only the same verified Node/artifact with a fixed
internal collection mode and fixed config; no shell, plugin path or caller-selected executable.
Child input/output are bounded<=16KiB, exactly one correlated result, no stderr accumulation.
Kill a collector at5s or terminal state; require its exact exit acknowledgement for successful
closure, without delaying the stop append behind that acknowledgement. A late result cannot
overwrite the first stop. A blocked/dead collector or slow persistence never suspends policy ticks. Host or
supervisor event-loop suspension provides no hard real-time guarantee.

The configured runner alone supplies metadata heartbeat records over the inherited private stdin
pipe: exact runId and sequential counter, <=512bytes/frame, bounded chunk/frame budget, no replay,
automatic heartbeat or caller timestamps. Loss/EOF, malformed input or TERM/INT requests terminal
stop; expired policy is checked before accepting heartbeat. Reobserve the exact runner identity.
No listener, automatic retry/restart or launch acknowledgement. stdout/stderr remain /dev/null.

Journal creation is exclusive in an empty dedicated monitor root and fsyncs file plus directory
before observation. Its existence prevents reopening the run after crash; never steal/delete an
old marker or overwrite a terminal run. Stop first irreversibly latches the local terminal state,
rejects further activity, initiates termination of the owned collector and independently schedules
exactly one first stop append/fsync plus directory fsync. Appends remain ordered behind any pending
sample append; a stuck append can prevent durability but cannot prevent local terminal state.
Finalization has one absolute5s deadline from terminal entry, covering collector exit, journal
write/fsync and descriptor closure. The CLI exits nonzero at that deadline even with unsettled I/O;
retain the journal and exact uncertain collector PID/start/group recorded before accepting output.
If terminal entry precedes identity acquisition, retain the owned raw child PID with explicitly
unknown full identity in the stop record; unconfirmed exit cannot be successful closure. Keep OS
TERM/INT handlers installed as terminal no-ops until finalization completes, including repeated signals.
Late writes cannot create healthy state. If persistence or collector closure fails, report failure
through exit status; retain journal and uncertain identities. Do
not claim durable stop or successful closure without both acknowledgements. Keep every record;
never truncate logs to pretend a failed run was clean. This journal is observation stop intent,
not yet the lifecycle daemon's stop intent or proof of Computer container closure.

## Required authority composition after this slice

Before unavailableAdmission can change, independently review/implement a root-owned supervision
lifetime channel tied to exact run/instance/resource generation. Root terminal state immediately
closes root admission; delivery to a different process is bounded IPC, not synchronous memory.
The receiving process must synchronously call its existing core.close/epoch retirement on terminal
or lost lifetime, then acknowledge fencing. No new frames/input or fresh launch while waiting.
Stop intent must be fsynced before lifecycle mutation; failure still closes admission and retains
all identities. Gateway-first exact cleanup follows fencing or a separately accepted forced-stop
path. Preserve the sole lifecycle lock, request CAS, immutable IDs/creation generations and roots.

Recovery never automatically launches or resets a stopped run. Hold the same lifecycle lock;
reconcile each recorded full ID with exact spec and each pending deterministic creation intent.
Only known-ID initial container inspect404 proves absence. Pending-name404/list misses remain
unresolved; retain intents until a separately accepted quiescence/reconciliation contract proves
the original create cannot still complete. No retry create, invented IDs, state erasure, volumes
or home deletion. Independent closure rechecks exact resources, PID/start/group, endpoints and
healthy Moss, and signs a separate receipt; the observer cannot self-certify resource closure.
These are explicit successor implementation gates, not capabilities this observer supplies.

## Verification and continuation

Search Hindsight conventions; inspect cache before frozen scope including root/API/worker/web/
spike dependencies. No DB/foundation command. Tests disclose root/namespace/config and Docker
stand-ins; native temporary trees, bounded pipe/HTTP fixtures and actual collector subprocesses
exercise machinery. No image pull/build/load/create/start/stop or real Computer runtime here.
No installation, production modification, r21 requalification, UI or model calls. Later feedback
comes from records; models only select authorized tasks and propose input.

Expected0, unpiped, private logs outside ~/Jarv1s: focused supervisor/trust/observation/journal and
existing Linux/policy/host suites; root and tests TypeScript; scoped ESLint max-warnings0/Prettier;
file-size; diff--check. Build the builtin-only artifact and run its real non-root refusal. Execute
a fixture driver with real collector children, including synchronous infinite block, truncated/
oversized/late output, dead runner, heartbeat expiry, old sample timestamp, terminal reentry,
bounded journaling, held collector exit and held/failed fsync with bounded nonzero finalization,
replacement/symlink/FIFO/ancestor/namespace refusal and crash
reopen refusal. Verify all owned children/FDs/fixtures close; no TCP port/server is started.
Observe intended removed-guard failures for namespace/config trust, initial timestamps, independent
ticks during hung collection, terminal nonresurrection, log/receipt bounds and durable stop.
Restore exact source; retain every attempt and independent review round.

Independent read-only security/spec acceptance of this committed contract precedes code.
Afterwards Standards+Spec review at pinned base, independent security/evidence acceptance and
required exact green CI precede merge. Then verify a fresh isolated successor carrying all
inherited gates and implementing real lifetime fencing/durable lifecycle recovery/closure.
Actual image/TigerVNC/fixed lifecycle and #3619 owner HTTPS/WSS/chat remain open. Before ANY
image/runtime operation require a separately committed independently accepted exact packet,
fresh healthy Moss and resource floors, alive independent watchdog plus first complete healthy
sample, protected dedicated data/adopted image, exact labels/PID/start/group and independent
closure. Preserve guest UID1000/network-none/2CPU/4GiB/512PIDs and separate gateway UID1000/
network-none/0.5CPU/128MiB/32PIDs, RO roots/dropped caps/default profiles/bounded tmpfs/logs;
API gets no Docker/devices/guest socket, gateway gets no home. No unrestricted bridge or production
restart/data substitution. Real owner cookie/exact Origin, trusted assets/approved concise chat,
sole writer/epochs/pressed releases/matching Fence/fresh agent leases and independent live proof
still gate owner completion. App-map/dev+prod config accompany product wiring. Keep parents open.

## Review rulings

Independent security/spec R1 on `434a2c316`: BLOCKED on collector-dependent persistence and
unbounded finalization. Accepted correction: latch terminal, independently initiate ordered stop
persistence and owned-collector termination, then require both acknowledgements within one5s
deadline. A stuck prior append or fsync is unresolved failure, never durable-stop success. Retain
the journal and exact uncertain identity; test held exit and held persistence independently.
No other blocking security finding or disputed ruling. Exact amendment needs independent R2.

Source R1 (`f04cd45e4`): Standards and Spec accepted; independent security blocked on three
accepted P2 findings. Keep real OS signal handlers through finalization (EventEmitter removal
does not model Node's restored default exit); include raw owned child PID even when full identity
acquisition has not completed; use path-segment ancestry so a legal `..monitor` child cannot
bypass trusted-root overlap checks. Add real double-signal, held-identity/exit and equal/ordinary/
double-dot-prefixed-child regressions. No disputed findings; exact correction needs independent R2.
