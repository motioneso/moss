# Computer managed existing-resource terminal lifecycle

Part of #3618/#3617/#3616/#3577. Base `2f3ff6ae6c631c45225b92fd8682a178ece6279f`,
the verified PR #3649 merge. Its tree equals final accepted `a35f508f377ca71248ce1b053578c5ed8c9a4e9d`;
all24 published source hashes match. Live final acceptance comments6384345154/6384478718,
run40094799674 and required CI gate120877071207 reconcile. All five parent tasks remain open.
The [host terminal dispatch](../handoffs/2026-10-24-moss-computer-host-terminal-integration.md),
[lifetime dispatch](../handoffs/2026-10-24-moss-computer-lifetime-fencing.md) and their stricter
inherited gates continue through actual owner acceptance. No production deployment.

## Scope and seams checked before planning

Deliver a real opt-in managed daemon for **existing exact resources**: the trusted root watchdog
also owns the sole lifecycle lock and host control service. The external runner stays a distinct
process/group supplying actual heartbeats; the collector stays a separate bounded native process.
Root-to-receiver delivery remains the accepted authenticated Unix lifetime, not shared memory.
This slice provides actual terminal disable and supervisor-triggered cleanup, never launch/reset.
Independent Computer closure, installed runtime and owner delivery remain subsequent gates.

Current citations (graph client unavailable: daemon connection timed out; bounded source used):

- `scripts/computer-host/state.ts:99`: openExisting shares the exclusive daemon.lock and existing
  identity/state validation. `:154` latches terminal admission; `:178` preserves terminal tuples.
- `scripts/computer-host/recovery.ts:117`: immutable stop intent and file+directory fsync;
  `:171` contains fixed gateway-first reconciliation, CAS advance and retained resource IDs.
  Factor its cleanup body for reuse; normal paths must not invoke the operator forced-stop entry.
- `scripts/computer-host/operations.ts:42`: old orchestration advances CAS before admission and
  removes tuples during cleanup. Do not compose it with a live lifetime: the CAS change alone
  invalidates that binding. Its executable caller is `scripts/computer-host.ts:19`.
- `scripts/computer-host/service.ts:10`: bounded private Unix service, currently concrete-operation
  typed; narrow to the existing request signature. Its close destroys active requests; add a
  drain path so a disable response can settle before owned shutdown without self-deadlock.
- `scripts/computer-watchdog/supervisor.ts:170`: terminal entry; independent lifetime stop,
  journal and collector finalization retain one absolute5s bound. `:408` composes real machinery.
- `scripts/computer-watchdog/trust.ts:254`: trusted artifact/config/Node/root/namespace/runner
  validation. `scripts/computer-watchdog.ts:15` fixes modes and anchors startup time before I/O.
- `scripts/computer-watchdog/observe.ts:130`: enabled exact lifetime binding and terminal-marker
  refusal. `apps/api/src/computer/lifetime-receiver.ts` invokes synchronous receiver retirement
  before its signed ack; this is fencing invocation, not independent resource closure.

Choose co-location over spawning a second root daemon and inventing another authenticated IPC.
The latter preserves separate processes but adds receipt provenance, shutdown and two-lock hazards
without improving the already independent runner/collector boundary. No new generic executor,
API root channel or alternate lock. Pre-plan independent security/Spec review supports this seam;
that review does not accept an uncommitted contract. Obtain exact committed acceptance before code.

## Managed composition and normal request contract

Add `scripts/computer-host/terminal.ts` and `scripts/computer-watchdog/managed-host.ts`; narrow
changes to recovery/service/supervisor and the two CLI composition roots, plus focused tests.
No configuration key, dependency, UI, app-map capability or deployment default is added.
unavailableAdmission remains byte-for-byte unchanged and remains unavailable.

`computer-watchdog manage <trusted-supervisor-config>` explicitly requires lifetime configuration.
Use the same exact trusted loader and artifact, external heartbeat pipe, null stdout/stderr,
namespace anchors, distinct runner/watchdog PID/start/group and first durable healthy sample.
Open only existing host state under the canonical lock; reject an existing terminal marker or
binding mismatch before serving. Never initialize/reset state or steal a live/stale lock.
`observe`/`fence` retain their existing read-only lifecycle behavior and cannot silently manage.
Collector mode never opens the host service or lock. No actual installation occurs in this slice.

Managed requests use the existing bounded owner/CAS protocol and result schema. Owner denial
precedes filesystem/Docker work. Status reads complete exact inventory; running still means
process state only. Enable returns prerequisite-unavailable before changing CAS, enabled state
or invoking create/start. Disable validates owner/CAS, then enters terminal immediately; only
successful actual cleanup can return disabled/none. Recreate uses the same terminal stop but
returns prerequisite-unavailable after cleanup: no new run or implied successful recreation.
No repeated request can reset a stopped run, replay cleanup or overwrite first stop evidence.
Root autonomous termination and requests converge on one in-flight terminal action.

Replace the standalone `computer-host <private-host-config>` executable's old mutation composition
with the same terminal-only operations. Without a root lifetime it can report status and durably
request terminal stop but cannot claim receiver fencing or perform cleanup. SIGTERM/INT follow
that same path. The old launch-library tests are disclosed fixtures, not executable admission.
No installed executable retains the old tuple-erasing disable/recreate path. Enable/create/start
provisioning, new-run/reset and uncertain-create quiescence are explicitly deferred implementation.

## Terminal ordering and bounded failure

Add an optional narrow terminal hook to the actual supervisor driver/composition. At the first
terminal entry synchronously latch the store before any await, then start immutable lifecycle
stop persistence independently of signed receiver stop, observation journal and collector exit.
A hook failure must not skip receiver fencing or the existing finalization machinery. No cleanup
await is added to the root's absolute5s finalization deadline. Repeated signals remain terminal
no-ops through both observer finalization and managed cleanup; never restore Node's default
signal exit during unsettled persistence/mutation.

Normal request stop triggers this same supervisor instance's operator-stop path, not a separately
constructed outcome, fresh root connection, replacement epoch, timer/predicate or successful stub.
Managed cleanup consumes that instance's actual outcome only when receiverFenced, durableStop,
collectorExited are true and exitCode is0 or1 (never2). This includes descriptor-close/deadline
success already represented by the existing outcome. Observe outcomes cannot authorize cleanup.
Lifecycle intent file+directory durability is a separate required acknowledgement.

Only after both acknowledgements, advance request CAS once, disable state, reconcile complete
exact inventory, persist resolved IDs, then remove gateway before desktop using canonical recovery
code. Revalidate immutable marker bytes+inode, roots/state and absolute cleanup deadline before
each actual mutation, including after Docker inspect awaits. Halt on any gateway failure. Preserve
all original/resolved full IDs, creation generations, pending intents, roots and failed cleanup.
Only initial known-ID inspect404 proves absence; pending-name404/list misses stay unresolved.
No retry create, invented identity, home/volume deletion, lock stealing or terminal-marker erasure.

Managed lifecycle work has a separate absolute120s deadline from terminal entry, never refreshed.
At equality, refuse further mutations and fail. The CLI exits nonzero at that bound if kernel I/O
or cleanup remains unsettled, retaining daemon.lock, stop intent and exact identities for separately
accepted recovery. Do not release the lock while an operation/save is unsettled. This bound is
not the observer's five-second bound or a claim of real-time behavior during host suspension.
Settled cleanup success drains active host responses, closes only owned service resources and
releases the canonical lock. Settled failure retains stop evidence/identities and the lock.

The result reports only local terminal cleanup. It does not independently establish resource/PID/
start/group/endpoint closure or healthy Moss. That requires a distinct independently executed
closure verifier and receipt in a subsequent bounded contract; neither journal self-certifies it.

## Verification and evaluation

Kill owner: computer-host-terminal. Split/reject if composition requires API privileges, a new
root protocol, admission success, fixture closure, terminal reset or weakening any inherited gate.
No model/UI here; later feedback comes from records and model only selects authorized task/input.

Inspect cache before scoped frozen install including root/API/worker/web/spike and workspace deps.
Expected0, unpiped with private logs outside ~/Jarv1s: focused managed-host/host/recovery/lifetime/
supervisor suites; root `pnpm exec tsc --noEmit`; tests `pnpm exec tsc -p tsconfig.tests.json --noEmit`;
scoped ESLint max-warnings0/Prettier; `pnpm check:file-size`; `git diff --check`; builtin-only
watchdog/host bundles and gateway build. No DB/foundation, TCP server, browser or Docker/image work.

Native Unix request→actual supervisor→actual receiver retirement→durable lifecycle stop→recording
Docker cleanup must execute, including a separate native executable composition. Disclose synthetic
auth/readiness/Docker/root ownership/namespace/library Fence fixtures; they do not qualify installed
trust, TigerVNC, actual image/Node24/128MiB, live owner access or independent closure. Exercise
autonomous terminal, signal/EOF, owner/CAS denial, enable immutability, recreate no restart,
held/failed lifecycle fsync versus prompt fencing, missing/failed/late ack, malformed marker,
gateway failure, retained IDs/intents, lock contention and bounded response/descriptor/child cleanup.
Observe intended assertion failures with each claimed new security protection removed, retain
failed rounds/patch/log hashes, restore source byte-for-byte and run the final green batch.

Independent Standards+Spec/security source review, corrections, exact final local evidence
acceptance and exact final HEAD required green CI precede protected actual merge. Verify merge,
then herdr-handoff to a fresh isolated successor with verified durable name, actual session UUID
and handoff-read execution acknowledgement. A prerequisite never finishes owner integration.

## Preserved runtime and owner gates

Before ANY Computer image/runtime operation require a separately committed independently accepted
exact packet; fresh healthy Moss and RAM/root>=8GiB/data>=30GiB; independently alive watchdog and
first complete healthy sample before launch. Retain exact labels/PID/start/group, hrtime run<=1800s,
heartbeat<=90s, nominal5s collection/gap<10s/receipt age<5s, timestamps before I/O, no sample heartbeat
renewal, equality expiry, bounded actual logs/home+socket<10GiB and root code/config/namespace trust.
Sampled accounting is not quota/continuous liveness. Inspect every sample/reason and independently
verify exact closure plus healthy Moss; retain failed receipts and exact-label emergency cleanup.

Reuse accepted r21 persistence; r12/r18 causes unknown. Adopted exact guest image/protected data:
guest UID1000/network-none/2CPU/4GiB/512PIDs; separate gateway UID1000/network-none/0.5CPU/128MiB/
32PIDs, RO roots/dropped caps/no-new-privileges/default profiles/bounded tmpfs/logs/no gateway home.
API gets no Docker/devices/generic exec/guest socket. No unrestricted bridge, production restart,
data substitution or deployment. Actual image/Node24/128MiB/TigerVNC/fixed lifecycle/independent
closure precede installed usability. Sole writer/predecoder bounds/absolute deadlines/synchronous
auth retirement/immutable epochs/pressed releases/matching BlockBefore Fence/fresh post-Fence auth
and stable private control separate from replaceable raw RFB remain unchanged.

Real owner cookie/exact Origin/HTTPS/WSS/trusted assets/approved concise chat/fresh agent leases,
actual positive/hostile/expired/revoked/watcher/stale/pressed-input paths and independent live
acceptance precede owner completion. App-map and affected dev/prod config accompany product
wiring. Servers require devports claim5180–5299 and release. Keep all parent owner issues open.
