# Bind independent closure init identities to managed capture

Task #3668; part of #3618/#3617/#3616/#3577, with #3619 OPEN. Approved design:
persistent-desktop spec24–27. Base `26c2a366ef41c90e7198a8d2903004fe0ab61b6e`, actual
accepted PR3666 merge. Final predecessor HEAD `1941148bedb6ce029a70e70325666576cc45dcb9`;
required CI40125676434/check120969988895 succeeded at that HEAD. Both independent actual-merge
acceptances are comment6388791091; fresh independent base reviews confirm ordered parents,
tree80aca60f, all16 PR entries, zero concurrent-main entries and complete expected tree.
Full-tree equality to final HEAD was separately verified true. Native successor startup is
independently accepted in comment6388863360. Historical private siblings remain read-only.

Follow the complete [closure-delivery dispatch](../handoffs/2026-10-24-moss-computer-closure-delivery.md)
and inherited gates through actual owner integration. This is ONE internal sampled-init provenance
contract, not a per-run closure configuration publisher, final descendant reconciliation,
prelaunch admission or installed qualification. Keep unavailableAdmission unchanged and every
owner parent OPEN. No Computer image/runtime, Docker mutation, DB or deployment operation.

## Current seams and choice

Graph-indexed current source establishes:

- `scripts/computer-capture/run.ts:19–128` executes actual managed capture under the SAME store
  and sole lifecycle lock, repeats full-ID Docker/init/cgroup observations and persists capture.json.
- `scripts/computer-capture/run.ts:88–112` records run/lifetime binding, actual watchdog/runner,
  init identities, sampled groups, managed provenance and the actual journal start snapshot.
- `scripts/computer-capture/provenance.ts:51–76` pins original config/code/Node/state/marker,
  roots, owned lock, boot and namespace observations. Mutable state/lock are historical after stop.
- `scripts/computer-watchdog/journal.ts:124–141` obtains dev/ino/size/hash of the actual start-only
  journal through its owned descriptor; later collector/sample/stop records append to that inode.
- `scripts/computer-closure/config.ts:57–105,108–244` validates trusted supplied init tuples and
  installed signer but never requires their relationship to actual capture. Revalidation at
  :246–266 reloads actual configuration and pins original files at existing closure boundaries.
- `scripts/computer-closure/records.ts:125–176` binds retained state and original stop intent to
  lifetime full IDs/generations, then consumes the bounded journal; it never opens a store/lock.
- `scripts/computer-closure/run.ts:51–80` rechecks records/deployment before and after observations
  and after receipt persistence, before the final native-success decision.
- `scripts/computer-provision/publication.ts:49–70` caps the actual capture publisher at64KiB.
- `scripts/computer-signing/installation.ts:35–38` strips only lifetime when hashing a template.
  Putting installation-derived delivery settings in that template would create circular authority.
- `scripts/computer-host/operations.ts:97–105` still starts each role before creating the next;
  neither existing-resource health nor this binding supplies the separate BEFORE-launch contract.

Choose mandatory capture consumption in the actual post-stop closure loader. The stronger alternate
watchdog-owned closure-config publisher would require an independently pinned external delivery
request and exact bootstrap composition; it remains real implementation work. Adding an optional
capture check would preserve the existing unbound success path, so this opt-in tool requires it.
Do not change SupervisorConfiguration, signer-template hashing, capture publication or lifecycle.

## Exact input and consumer contract

Add required lowercase SHA256 `captureSha256` to ClosureConfiguration. Require supervisor.capture
and lifetime in the actual closure parser. Capture path is fixed to that pinned root's capture.json;
no independently selectable path or legacy success branch. Old opt-in configurations refuse.
There is no qualified deployed caller/default to migrate. No product/app-map change is needed.

New `scripts/computer-closure/capture.ts` owns the bounded consumer and journal-origin check.
Read through canonical closureFile with64KiB limit after strict trusted root ancestry, root0700
and identity validation. Verify exact independently supplied hash. Reject unsafe/symlink/hardlink/
FIFO/oversize/replaced input through existing private-file checks and original inode+byte rechecks.
The separately committed independently accepted future run packet must pin the capture hash along
with installation hash/public key and exact config/code/Node/anchors; the file chooses no authority.

Validate a closed top-level snapshot envelope with version1, kind=managed-process-snapshot,
coverage=sampled-cgroup-v2, runId, binding, measuredAtMs, finishedAtMs, watchdog, runner, inits,
groups, provenance and journal. Require nonnegative safe monotonic timestamps with finished>=measured.
These are sample timestamps, not publication-fsync/native-completion acknowledgements.
Validate every consumed nested shape; preserve unused descendant/file/lock payloads only as
hash-bound historical data, without claiming independent validation of their full schemas.

Require exact lifetime binding through the canonical lifetime parser (no secret from snapshot),
exact run/runner/watchdog PID/start/group and two distinct roles/full resource IDs. For each init,
validate closed id/role/pid/startedAt/identity, canonical native identity and equality of pid to
identity.pid; require identity equality to the corresponding trusted closure init tuple. Reject
extra/duplicate/missing roles and mismatch of resource ID/generation through the lifetime binding.
Require nonempty parseable Docker StartedAt, without treating it as a monotonic clock authority.

Validate provenance boot and pid/mnt/user/net/cgroup namespace shape; compare boot and existing
pid/mnt/user/net anchors to the trusted closure configuration. Compare provenance roots with actual
deployment roots. Validate groups namespace net/cgroup shape and equality with provenance. Require
actual self/PID1 net/cgroup anchors equal the recorded values using canonical captureNamespaceAnchors.
No live init/runner/watchdog/heartbeat lookup, current state-file hash equality or current lock
existence/ownership requirement is introduced. Never re-run captureProvenance after stop.
Unused sampled descendant arrays do not enter absence checks or prove final descendant completeness.

Validate closed journal dev/ino/size/hash (safe positive inode, nonnegative device, bounded positive
size and SHA256). Retain the capture file snapshot and parsed journal/timestamp binding in the
actual ClosureDeployment. During readClosureRecords, require retained journal dev/ino match capture,
and the exact first newline-terminated start-record prefix has the captured size/hash. Parse that
prefix's existing startedAtMs and require startedAt<=measured<=finished<startedAt+5000. Existing
closureCollectors still checks run/runner/watchdog, all appended records and stop. Appended final
journal size must NOT equal the captured start-only size. A byte-identical replacement inode refuses.

Revalidation rechecks original capture inode/bytes and repeats actual loader binding and namespace
checks alongside existing config/key/installation/code/Node/root checks at ALL existing boundaries.
Capture hash is transitively signed through configSha256. No new signer authority, receipt success
predicate, lock acquisition/release, Docker operation, cleanup, retry or time extension is added.
The signed record remains init-based sampled absence plus journal collectors, never all descendants.

## Verification and limits

Update affected closure/signing fixtures for the required fields. Explicitly label manually
constructed capture/deployment fixtures as lower-level cases excluded from publisher provenance.
New `tests/unit/computer-closure-capture.test.ts` and a focused composition fixture execute actual
captureManagedProcesses publication, actual signer publisher and actual mandatory closure loader
over native child identities, real files/journal/fsync/crypto and private Unix Docker fixtures.
Disclose existing root/runtime/namespace/cgroup/heartbeat/Node projections. Exercise a positive
retained post-stop journal append/state transition/lock disappearance without live-process queries.
Existing actual-loader tests retain all-recorded-processes-exited coverage. No fixture qualifies
installed root trust, actual Node24/image/128MiB fit, runtime admission or owner delivery.

Test missing capture/root/hash, wrong hash, run/binding/runner/watchdog/init PID/start/group/full-ID,
duplicate/missing role, boot/namespace/root mismatch, malformed envelope/consumed fields/times,
journal prefix/hash/inode mismatch, allowed append, capture replacement after load, unsafe/oversize
files, original deadlines/signals and unchanged post-stop behavior. Observe intended executable
assertion failures when each newly claimed protection is removed; retain exact patches/logs and
restore production byte-for-byte before final checks. Failed reviews/executions remain retained.

Native production CJS nonroot refusal stays silent exit2. Bundle actual modified closure code with
builtin-only dependency verification. Existing native closure/capture/signing suites remain in the
affected behavior batch; their inherited projections and limits remain explicit. No new native
timer or successful completion claim is introduced by this read-only binding contract.

Expected0, unpiped private logs: all affected Computer unit suites;
`pnpm exec tsc --noEmit`; `pnpm exec tsc -p tsconfig.tests.json --noEmit`; scoped ESLint zero
warnings and Prettier; `pnpm check:file-size`; `git diff --check`; builtin-only signing/watchdog/
host/provision/closure CJS bundles and `pnpm build:computer-gateway <new-private-output>`.
Dependencies/cache inspected; scoped frozen offline root/API/worker/web/spike/workspace install.
No foundation/DB, Computer runtime/image/Docker mutation, browser or TCP server operation.

Kill owner computer-closure-delivery: reject/split if this needs a second lock, live post-stop
authority, invented tuples, relaxed trust, a successful injectable predicate or calling sampled
capture final descendant closure. Evaluate this phase before detailed further runtime planning.
No UI/model calls; later feedback renders records and models propose authorized tasks/input only.

Commit exact plan, then independent read-only Security+Standards/Spec acceptance BEFORE implementation.
Exact source reviews/corrections, final local evidence acceptance, required final-HEAD green CI and
supplemental acceptance precede protected actual merge. Verify actual parents/tree/all PR and
concurrent-main paths and separately full-tree equality. Continue full owner delivery through
verified fresh isolated successors; preserve actual native identity/title/routing/start acknowledgement.

All inherited runtime gates remain: separate committed accepted exact packet BEFORE any Computer
operation; fresh healthy Moss/resources RAM/root>=8GiB/data>=30GiB; independently alive watchdog AND
first complete healthy sample BEFORE launch;1800s/90s/5s/gap<10s/age<5s/equality/first-I/O timestamps/
actual bounded logs+home+socket<10GiB/root trust/namespaces/full labels+IDs+PID/start/group/independent
closure. Reuse accepted r21, r12/r18 causes unknown. Per-run closure publisher, final descendants,
prelaunch ordering, reset/new-run/uncertain-create quiescence, installed Node24/128MiB/TigerVNC/fixed
lifecycle, trusted API leases/dispatch, sole receiving writer/predecoder/epochs/pressed releases/
Fence/fresh authorization and real owner cookie/Origin/HTTPS/WSS/concise chat/hostile/live acceptance
remain. No production deployment. A prerequisite merge never completes actual owner delivery.
