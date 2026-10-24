# Managed-root Computer process capture

Part of #3618/#3617/#3616/#3577; #3619 stays open. Approved design: persistent-desktop
spec24–27. Base `516bbb811a79115f2a4c331cdd534905bf51ba2a`, actual PR3654 merge.
Independent Security and Spec verified final HEAD `08015463bc384ced35d8f95c2cd3c8eb12b6870c`,
checked source `24a3de6dbf7b47b3c36a8cefe04c238b8f7138ad`, local acceptance6386466835,
supplemental6386640772 and successful CI40110201876 attempt1/check120923674525 at that HEAD.
All14 PR paths match final HEAD; all49 concurrent main source/doc/test paths match first parent.
Full merge-tree equality to final HEAD is false. Historical private evidence remains read-only.

Follow the complete [capture dispatch](../handoffs/2026-10-24-moss-computer-trusted-capture.md)
and inherited contracts. This phase is opt-in internal post-start capture tooling, no installation,
Computer image/runtime operation, launch admission, product wiring or deployment. Keep
unavailableAdmission unchanged and every parent owner issue open.

## Seams and bounded choice

Graph indexing was requested but its scripts coverage is absent; bounded source reads establish:

- `scripts/computer-watchdog/managed-host.ts:66`: actual managed root exclusively opens existing
  HostStateStore before invoking its supervisor. Capture must consume this SAME store.
- `scripts/computer-watchdog/supervisor.ts:408`: actual composition creates an exclusive fsynced
  ObservationJournal before installing the driver. Bootstrap remains under the CLI's native5s
  deadline (`scripts/computer-watchdog.ts:15`). Capture here, before clearing that deadline.
- `scripts/computer-host/state.ts:99`: the store owns the sole lock descriptor; :245 releases
  only that descriptor on failed invocations. Add a narrow read-only owned-lock equality check.
- `scripts/computer-host/docker.ts:80`: exact spec/labels/mounts/images already validated, but
  State.Pid is discarded. Add a running full-ID pair read, never a Docker mutation.
- `scripts/computer-watchdog/trust.ts:238`: actual host /proc processIdentity plus repeated
  readComputerProcess verifies live PID/start/group. :254 validates managed deployment/runner,
  :224 validates host boot/pid/mnt/user namespace anchors. Reuse these paths.
- `scripts/computer-watchdog/journal.ts:122`: inspect correlates the actual open journal inode
  and size; expose its bounded start-only snapshot for actual watchdog/run/runner correlation.
- `scripts/computer-closure/config.ts:28`: current verifier consumes init tuples only; it has no
  descendant census contract. Do NOT wire capture output into successful closure in this phase.
- `scripts/computer-provision/publication.ts:24`: descriptor-pinned exclusive publication already
  supplies file+directory fsync, close and readback. Extend its fixed filename set with capture.json
  and a bounded64KiB limit, keeping all existing publication behavior unchanged.

Choose capture INSIDE the actual managed root over an independent read-only snapshot executable.
The latter could observe lock-path existence but cannot establish that the named watchdog owns
the open lifecycle descriptor without a new authenticated protocol. Co-location preserves the
existing authority/lock and avoids a second root service. No injectable successful admission or
caller-supplied process tuples. Test trust substitutions are explicit fixtures.

New production modules: `scripts/computer-capture/cgroups.ts` for bounded native membership,
`provenance.ts` for pinned managed files/artifacts/namespaces, and `run.ts` for capture/publication.
Focused fixtures/tests: `tests/unit/computer-capture-fixture.ts`, `computer-capture-native-fixture.ts`,
`computer-capture.test.ts` and `computer-capture-trust.test.ts`. Move the existing descriptor mount-ID
helper from closure/observe to watchdog/linux-files for canonical reuse; preserve closure behavior.

## Configuration and actual caller

Add optional `capture` RootIdentity to SupervisorConfiguration. Exact private root-owned0700,
canonical trusted nonwritable ancestry, outside every host/data/docker/monitor root with no overlap
in either direction. Config, Node and artifact must be outside capture. The pure parser accepts a
lifetime-absent capture template for PREPARE; the live supervisor loader and manage require lifetime
whenever capture exists. Only CLI manage mode may consume capture; observe/fence refuse it, collector may
validate the same config but never capture or acquire the lock. Absent capture retains behavior.
The preparation publisher may carry this trusted template field but cannot perform capture.
No dependency, UI, app-map capability, deployment default or required existing setting changes.

`manageDeployment` passes the existing store to the actual supervisor composition, which invokes
`captureManagedProcesses(deployment, store, watchdog, startedAtMs, journal)` after journal create
and before driver start. Reject missing store, foreign configuration, or watchdog != actual self.
Use retainFailedLock on managed open: failure never removes a newly acquired lock. Capture never
opens/closes/unlinks/reacquires that lock, writes state, creates/starts/removes containers, or retries.

The CLI native absolute5s bootstrap timer includes capture, hashing, persistence and close. Anchor
measuredAtMs before first capture I/O; reject at startedAtMs+5000 equality and after each stage.
Capture TERM/INT latch failure without extending timer; transfer signal handling to the driver
without an asynchronous gap. Capture does not start lifetime, renew heartbeat or claim healthy
sample. Bootstrap/first-complete-healthy-sample-before-launch is separate accepted future work.

## Actual process and provenance observations

Require exact enabled current lifetime binding, both retained distinct full IDs/creation generations,
no pending intents/stop marker, canonical roots/marker/state and owned lock. Pin config/state/marker
bytes+inode, Node/artifact metadata+hash, Docker socket metadata and namespace anchors throughout.
Read the actual start-only journal through its open descriptor and correlate exact run/runner/
watchdog/start time, path inode and hash; do not accept caller-supplied journal provenance.
The controlled exclusive journal open becomes O_RDWR so the start-only snapshot reads the SAME
open descriptor; exact bytes/size/inode and pending/record counts must agree before and after.
Capture checks the existing terminal abort/latch too: the host service may already be listening,
and a disable arriving during bootstrap must refuse capture rather than complete its snapshot.

Read complete exact inventory and repeat full-ID running inspect for gateway and desktop. Require
State.Status=running, Running=true, positive safe host State.Pid, no Restarting/Paused/Dead and a
nonzero parseable StartedAt. Repeated full-ID observations must equal, including StartedAt/Pid.
Observe each init's actual host PID/start/group via canonical /proc helpers.

Container-init tuples alone do not cover descendants. Require native host cgroup v2 at fixed
/sys/fs/cgroup (actual statfs magic), canonical root-owned nonwritable ancestry. Require actual
self/PID1 cgroup namespace links equal and stable before/after: cgroup namespace changes reinterpret
the proc paths. Record that anchor alongside net. Pin the fixed cgroup mount descriptor identity and
its Linux fdinfo mnt_id; require every traversed directory AND opened cgroup.procs file to have that
same mount ID. Device/statfs equality alone cannot exclude same-device bind mounts. Each init's bounded
/proc/PID/cgroup has exactly one unified0:: absolute canonical nonroot path whose final component
is the exact full ID or docker-FULLID.scope. Refuse same/overlapping groups and host runner/watchdog
membership in either container subtree. Enumerate each subtree's actual cgroup.procs recursively,
descriptor-pinned NOFOLLOW directories, depth<=8, <=256 total entries/directories per subtree,
<=512 desktop and<=32 gateway process IDs. Bound each proc/cgroup/control-file read to16KiB.
Refuse noncanonical/lossy names, mount/device crossing, symlinks and malformed/duplicate PIDs.
Every process must be live and its actual /proc cgroup equal the enumerated directory; record
PID/start/group including processes which called setsid or moved into child cgroups. Require init
membership. Repeat the whole census and require exact directory identities, membership and tuples.
Recheck Docker State.Pid/start, native init identities, host namespace, files, roots and lock.
Unstable/unsupported/inaccessible observations fail, never fall back to init-only success.

This is a bounded repeated sample, NOT continuous descendant coverage. Processes born or moved
after this sample, exiting descendants and final pre-stop reconciliation remain separately
accepted lifecycle/closure work. The existing closure verifier is unchanged and cannot treat this
receipt as descendant-complete proof. No continuous absence, quota or installed provenance claim.

## Durable output and failure

Require empty capture root, then exclusive root0600 capture.json (<=64KiB). Closed schema contains
version1, kind=managed-process-snapshot, coverage=sampled-cgroup-v2, run/binding (NO secret), initial
and finished monotonic sample times, actual watchdog/runner/init/descendant identities, cgroup
directory identities, host boot/pid/mnt/user/net/cgroup anchors, owned-lock identity, config/artifact/Node/
state/marker/journal hashes and metadata. Net anchors of self/PID1 must agree before/after.
No raw config bodies, secret, key, environment, process command line or private error string.
Paths and raw snapshot stay private; public evidence contains hashes/sanitized summaries.

Use canonical exclusive publication and actual readback after file+directory fsync and closes.
Recheck all pinned sources, repeated observations, stop/signal/deadline and publication after close.
Receipt existence alone is not success; native process continuation/start acknowledgement and
independent accepted evidence remain required. Failure retains partial output, journal, state,
resource identities and lock. No deletion, overwrite, reset, recovery or timer renewal.

## Verification, kill gate and continuation

Kill owner computer-trusted-capture: reject/split if this requires runtime admission, second lock,
invented tuples, relaxed cgroup/provenance checks or claiming sampled descendants as complete
closure. Phase1 ships alone before final lifecycle capture/closure installation is planned.
No UI/model calls; later feedback renders records and models propose only authorized task/input.

Inspect dependencies/cache, scoped frozen install root/API/worker/web/spike and workspace deps.
Tests use actual temporary files/locks/journal/publication, actual native child PID/groups and Unix
HTTP Docker fixtures. Root/runtime/namespace/artifact/cgroup mount and membership are disclosed
OS fixtures; no real container or installed root provenance is claimed. Execute actual managed
composition with capture, not only a detached helper. Native CJS refusal stays silent exit2.
Exercise descendant with distinct group, changed Docker PID/start, foreign/duplicate/overlapping
cgroup, changed descendant membership/start/group, journal/config/state/lock/root replacement,
unsafe/oversize input/output, late stop, equality/signals, failed/held file/directory fsync and close,
exclusive output and absent-store/unmanaged mode refusal. Native held bootstrap persistence must
exit2 at the original absolute5s bound with lock/output retained and zero Docker mutations.
Observe intended assertions fail with each claimed new protection removed; retain failed rounds
and patches/log hashes, restore byte-for-byte, then execute final green checks.

Expected0, unpiped private logs: focused capture plus all affected Computer behavior suites;
`pnpm exec tsc --noEmit`; `pnpm exec tsc -p tsconfig.tests.json --noEmit`; scoped ESLint with
zero warnings/Prettier; `pnpm check:file-size`; `git diff --check`; builtin-only CJS watchdog,
host/provision/closure bundles and `pnpm build:computer-gateway <new-private-output>`.
No foundation/DB, actual Computer Docker/image/runtime, browser/TCP server or installation.

Commit this exact contract and obtain independent read-only Security+Spec acceptance BEFORE code.
Then independent Standards+Spec/security source review/corrections, exact local evidence acceptance,
exact final HEAD required green CI and supplemental acceptance precede protected actual merge.
Verify actual merge/concurrent deltas and fresh isolated successor's native UUID/durable routing/
preserved handoff-read execution acknowledgement. Leave a clean pushed tree and owned resources closed.

All inherited gates remain: separately committed independently accepted runtime packet; fresh
healthy Moss/resources RAM/root>=8GiB/data>=30GiB; independently alive watchdog AND first complete
healthy sample BEFORE launch; hrtime1800s/heartbeat90s/sample5s/gap<10s/age<5s/equality/first-I/O
timestamps/bounded logs+home+socket<10GiB; exact labels/IDs/PID/start/group/namespaces and independent
closure. Reuse accepted r21; r12/r18 causes unknown. Preserve exact guest/gateway images, isolation/
limits and API privilege separation; actual Node24/128MiB/TigerVNC/fixed lifecycle, signing/closure
installation/provenance, new-run/reset/uncertain-create quiescence, API leases/dispatch and real
owner cookie/Origin/HTTPS/WSS/approved chat/hostile live acceptance remain. Preserve sole writer,
predecoder bounds/epochs/pressed releases/Fence/fresh post-Fence auth. No production deployment.
A merged prerequisite never finishes actual owner delivery.

## Plan review ledger

R1 at ccddc93aa: Security and Spec identified a PREPARE-template/live-lifetime contradiction,
missing cgroup namespace interpretation anchor and insufficiently explicit same-device mount
identity. Correction distinguishes pure parser from live loader, adds cgroup namespace equality
and descriptor mount-ID checks, and identifies the exact new modules. Security also identified
that the actual journal descriptor was write-only; controlled O_RDWR enables same-FD readback.
All failed review reports remain private. Exact amended-commit acceptance is required before code.

Source R1 at9abed395: Security found capture's final clock check preceded the Promise handoff;
the native callback could clear a now-expired bootstrap timer. Correction rechecks equality
before driver installation, before invoking the start callback and inside the actual native
timer-clear acknowledgement. A regression executes actual capture then crosses equality in its
awaited continuation; a separate native OS-clock fixture crosses equality inside that callback.
Spec requested positive native continuation evidence; corrected native tests acknowledge the
actual driver's bootstrap-timer retirement after capture, then deliberately fail without an
installed receiver. That acknowledgement is not native run success or closure qualification.
Both R1 reports and all failed fixture runs remain private.
