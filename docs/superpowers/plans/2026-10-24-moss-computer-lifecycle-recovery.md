# Computer terminal stop and explicit reconciliation prerequisite

Part of #3618/#3616/#3577. Base `e6f0c388297e31b065f3dc93b651a8dede318d95`,
actually merged PR #3645. The [lifetime dispatch](../handoffs/2026-10-24-moss-computer-lifetime-fencing.md)
authorizes independent review, corrections, exact checks/evidence/CI, protected actual merge and
verified fresh isolated successors until actual owner delivery. No production deployment.

## Scope and current seams

Implement a real opt-in **fixed inspect/terminal-stop executable** for existing host state. It
holds the canonical lifecycle lock and reconciles recorded resources through the existing Docker
adapter. This is a bounded prerequisite to supervisor/receiving integration, not installed recovery
or admission. It never launches, initializes state, resets terminal runs, steals stale locks or
certifies independent closure. Normal API boot, host deployment and unavailableAdmission stay
unchanged. No new product behavior, app-map capability, UI, dependency or deployment setting.

Verified current-tree seams (graph coverage omitted host scripts; bounded source reads used):

- `scripts/computer-host/state.ts:97-129`: exclusive `daemon.lock`, marker/roots and durable state;
  currently initializes absent state. Add an existing-only open path sharing this implementation.
- `scripts/computer-host/state.ts:134-175`: root/durable-state revalidation and atomic file plus
  directory fsync. Preserve the original state schema and marker; observer parsing stays compatible.
- `scripts/computer-host/docker.ts:63-150`: exact immutable-ID/spec and complete inventory checks;
  only initial known-ID inspect404 proves absence. Pending-name404 stays unresolved.
- `scripts/computer-host/docker.ts:152-189`: fixed create/start/remove; remove validates before
  stop/kill/delete and never requests volume deletion. A thrown remove is not stopped proof.
- `scripts/computer-host/operations.ts:42-118`: real host request orchestration and launch port;
  no durable terminal marker or explicit existing-only reconciliation executable.
- `scripts/computer-host.ts:16-35`: opt-in host service owns the lock until shutdown. A separate
  recovery invocation cannot act while that daemon holds it. Crashed stale locks remain operator
  work under a future accepted reconciliation contract; this tool never removes them.
- `scripts/computer-watchdog/supervisor.ts`: independently running read-only observer; its stop
  journal cannot mutate Computer resources or certify closure. Leave it read-only in this slice.
- `apps/api/src/computer/gateway-server.ts:71-83` and `receiving-gateway.ts:234-247`: receiver-local
  close retires authority synchronously, but root-to-receiver lifetime IPC does not yet exist.

Choose a fixed recovery executable over adding unauthenticated lifecycle vocabulary to API IPC.
The existing service could serialize recovery requests conveniently, but cannot yet receive a
trusted root-supervisor lifetime. A standalone tool first makes stop persistence/reconciliation
concrete without pretending API-local invalidation reaches another process. It is usable only
after the old daemon releases its lock cleanly; stale locks are retained, not bypassed.

## Required complete authority contract (subsequent integration)

Root terminal state immediately latches root admission closed. Cross-process delivery is bounded
IPC tied to exact run UUID, instance and immutable resource creation generation; it is not shared
memory. The receiver synchronously invokes core.close/epoch retirement before acknowledging its
terminal fence. No new frames/input or fresh launch while acknowledgement is pending. Missing,
replaced, expired, replayed/late lifetime messages and EOF fail closed; never reconnect into an old
epoch. Preserve sole writer, predecoder bounds, absolute deadlines, auth retirement, immutable
epochs, pressed releases, matching BlockBefore Fence and fresh post-Fence authorization.

Fsync lifecycle stop intent before mutation; persistence failure still closes admission and retains
identities. Hold the one lifecycle lock and preserve request CAS, roots, full IDs, pending creation
intents and failed cleanup. Gateway-first cleanup requires receiver fencing or a separately
accepted forced-stop path. This slice proposes that explicit forced-stop path below; it does not
implement delivery or acknowledgement of receiver fencing. API receives no Docker/device/exec/
guest socket; gateway receives no home. No volumes or home deletion.

Independent closure must separately recheck exact resources, PID/start/group, endpoints and
healthy Moss, with a distinct receipt. The observer or this stop command cannot self-certify it.
New-run admission/reset and uncertain-create quiescence need their own reviewed contracts. Only
known-ID initial inspect404 proves absence. No fixture or predicate replaces these real paths.

## Existing-only state and irreversible marker

Files: `scripts/computer-host/recovery.ts`, `scripts/computer-recovery.ts`; narrow additions to
`state.ts` and `operations.ts`; `tests/unit/computer-host-recovery.test.ts` and fixture extensions
only as necessary. No general job framework, new configuration field or public endpoint.

`HostStateStore.openExisting(config): Promise<HostStateStore>` acquires the same exclusive lock,
requires both existing identity/state files and validates their exact current configuration/roots.
Missing or mismatched state fails, without initialization or migration. Both open paths reject
initialization if a terminal marker exists; stop evidence must not become a fresh empty state.

`store.latchStop(): void` irreversibly closes this store's local launch admission before any await.
`store.assertLaunchable(): Promise<void>` refuses that latch and any `stop.json` path, including
malformed, symlinked or partially persisted markers. Seeing any marker permanently latches this
store even if someone later removes it. Enable/recreate check before admission and again before
each create/start after asynchronous work. A failure returns unavailable and invokes the existing
invalidator; there is no configuration override. This is local launch refusal, not remote fencing.

`persistComputerStop(store): Promise<ComputerStopIntent>` first latches, validates roots and writes
one exclusive NOFOLLOW|NONBLOCK0600 single-link regular `stop.json`, bounded16KiB. Exact fields:
schemaVersion1, reason="operator-stop", instanceId, roots and original state snapshot (generation/enabled/resources).
Never truncate, overwrite or remove this file; retain original full IDs/intents after cleanup.
Require file write/fsync and parent directory fsync before any Docker mutation. A failed write,
fsync or validation retains the marker/latch and all remaining resource identities; it is failure,
not durable-stop success. An existing valid marker is revalidated and file+directory fsynced again
before resumed cleanup; mere existence does not acknowledge a previous failed fsync.

Its snapshot binds instance, canonical roots, request generation and each original role/creation
generation/full ID or pending intent. Recovery permits only subsets and pending-null to validated
full-ID resolution at the same role/generation. A known ID, role or generation cannot be replaced,
and current generation cannot precede the snapshot. No terminal marker reset or fresh run here.
The existing root marker also binds owner/config. Unsafe or inconsistent markers block mutation.

## Fixed operations and forced-stop ordering

`inspectComputerRecovery(store, docker)` validates roots, complete exact inventory and unchanged
state and returns a bounded metadata result. It never saves state or performs Docker mutation.
Resolving an intent in memory is inspection only; missing pending names remain unresolved errors.
No missing-image/spec or list error can erase a known ID. It does not claim stopped resources.

`stopComputerRecovery(store, docker)` persists/revalidates/fsyncs the terminal marker first, then
validates the entire inventory before mutation. Persist all resolved full IDs and enabled=false
before stopping resources. Preserve the original request generation; this is root-only terminal
reconciliation, not a new API CAS request. Validate marker compatibility before saving or mutation.
Under the held lock, remove gateway then desktop through the exact fixed adapter. Revalidate roots
and marker before each mutation and save remaining identities only after the adapter acknowledges
removal. On ANY gateway error halt before desktop, retaining unresolved/failed identities. Lost
DELETE acknowledgement is uncertain; a later invocation may reconcile initial known-ID404.
If gateway was initially known absent, complete inventory validation permits stopping the desktop.
Pending gateway404 blocks all cleanup. Never retry a create/start or infer a new identity.

CLI: `computer-recovery <inspect|stop> <private-host-config>` only; exact argument count, same
private config reader/parser, umask077, existing-only store. No shell, exec, arbitrary Docker
selector, browser request or listener. Fixed sanitized stdout result contains only operation,
terminal flag and remaining resource count; no private IDs/paths/raw errors. Failure exits1 with
a fixed sanitized message, success exits0. It closes only its own lock/FDs; it never closes a
running daemon's lock. The root operator must separately meet runtime gates before invoking this
against real Computer resources. Unit tests use a recording Unix HTTP stand-in, never Docker.

## Evaluation, checks and continuation

Phase1 ships alone: existing-only open, immutable stop persistence, exact reconciliation and fixed
forced stop with launch refusal. Kill owner computer-lifetime-fencing: split/reject if this needs
API root privileges, lock stealing, intent erasure, generic commands or removal of runtime gates.
Evaluate native file/Unix HTTP/subprocess behavior before designing the next IPC phase in detail.
Normal disable/recreate and daemon/supervisor terminal wiring remain explicit successor work;
do not describe this slice as all lifecycle terminal paths being integrated or crash recovery.

Inspect installed tooling/cache, then scoped frozen root/API/worker/web/spike plus workspace
dependencies. No DB/foundation commands. Expected0, unpiped with private logs outside ~/Jarv1s:
focused recovery/host/client/observer suites, root `pnpm exec tsc --noEmit`, tests
`pnpm exec tsc -p tsconfig.tests.json --noEmit`, scoped ESLint max-warnings0/Prettier,
`pnpm check:file-size`, `git diff --check`, builtin-only recovery CLI bundle.

Tests exercise native temporary files/locks, real Unix HTTP and actual CLI subprocesses: absent
state never initializes, competing/stale locks refuse, first stop bytes retained across restart,
failed write/file-fsync/directory-fsync blocks mutation and launch, existing marker re-sync failure,
malformed/symlink/FIFO/replaced marker refusal, exact tuple mismatch, pending404 retention, pending
resolution persisted before mutation, known-ID404 only absence, gateway error blocks desktop,
lost remove result retained then reconciled, home retained, no volumes, and launch refusal before
admission/create/start including stop arriving during awaited admission/create. Native executable
inspect and stop must use only fixture Docker, then leave exact owned fixtures/children closed.
Observe intended removed-guard failures for stop durability, marker launch refusal, existing-only
open, tuple binding, pending intent retention and gateway-first halt; restore byte-for-byte.

Before implementation obtain independent read-only security and Spec acceptance of this exact
committed contract. After implementation independent Standards+Spec/security at pinned base,
resolve findings and retain every review/failed attempt. Independently accept final exact evidence
and exact HEAD required green CI before protected actual merge; verify it. Then launch and verify
a fresh isolated successor through herdr-handoff carrying the lifetime dispatch and these limits.

All inherited runtime gates remain: before ANY image/runtime operation a separately committed
independently accepted packet, fresh healthy Moss, RAM/root>=8GiB/data>=30GiB, independently alive
watchdog and first complete healthy sample. Exact labels/PID/start/group; hrtime run<=1800s,
heartbeat<=90s, nominal5s samples/gap<10s/receipt age<5s, bounded logs, home+socket<10GiB;
equality expires. Samples never renew heartbeat; timestamps precede first I/O. Sampled accounting
is not quota/continuous liveness; suspension is not hard real time. Preserve first stop, root trust,
observer five-second finalization, retained uncertain collector PID and both durable/exit acks.
Use adopted exact guest image/protected home, network-none UID1000/2CPU/4GiB/512PIDs and separate
gateway network-none UID1000/0.5CPU/128MiB/32PIDs; RO roots/dropped caps/default profiles/bounded
tmpfs/logs/no gateway home. No unrestricted bridge or production restart/data substitution.
Actual image/Node24/128MiB fit/TigerVNC/fixed lifecycle and independent closure still precede
installed usability; actual owner cookie/Origin/HTTPS/WSS/chat/agent leases and live positive and
hostile/revoked/stale/pressed-input evidence precede #3616 completion. App-map and dev/prod config
accompany product wiring. Reuse accepted r21 persistence; r12/r18 causes unknown. Keep parents open.
No model calls here; later UI derives from records, model only chooses authorized tasks/next input.
