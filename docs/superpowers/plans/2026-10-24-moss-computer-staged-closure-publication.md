# Publish staged Computer closure configuration

Task #3674, under #3618/#3617/#3616/#3577; #3619 stays OPEN. Approved desktop
spec24–27 and the complete [publication dispatch](../handoffs/2026-10-24-moss-computer-closure-publication.md)
remain authoritative. Base71616c7b2fb1d6f768c0f4948bb2a85ae111d99c is accepted PR3669's
actual merge; final HEADf1c877b6ca3bb51f6670a830b97d1d915011176d has successful
CI40133487388 attempt1 and required gate120993449779. Independent baseline reviews
verify ordered parents, tree9d21b2c8, all21PR entries, zero concurrent-main entries,
complete expected tree and separate full-tree equality. Raw release-binding-r5
hashes and live supplemental/actual-merge acceptance remain separate evidence.

## Source and scope

Graph coverage explicitly excludes scripts/, so bounded current source reads establish:

- `computer-capture/run.ts:19–128` publishes actual capture under the SAME managed
  store/sole lifecycle lock, but returns no retained product to its caller.
- `computer-watchdog/supervisor.ts:467–509` captures before starting the driver;
  `computer-host/operations.ts:97–105` already starts the resources before capture.
  This cannot establish first complete healthy sample BEFORE launch.
- `computer-signing/installation.ts:35–38` hashes the parsed supervisor with only
  lifetime removed. Adding installation results to that template is circular.
- `computer-closure/capture.ts:39–132` requires an independent capture hash and
  validates historical run/init/namespace/root/journal shape against supplied tuples.
  Its present caller cannot derive tuples through a canonical validated interface.
- `computer-closure/config.ts:113–244` has the canonical post-stop code/Node/root/
  installation/key validation; `:246–288` retains original file/anchor revalidation.
- `computer-provision/publication.ts:40–147` supplies exclusive bounded publication,
  file+directory fsync/close/readback and original inode/bytes checks.
- `computer-signing.ts:6–42` supplies a standalone original60s timer, signal latch
  and final native callback guard, distinct from watchdog bootstrap.

Choose ONE **staged standalone per-run publisher**, consuming an already completed,
independently accepted capture. This deliberately differs from the stronger watchdog-owned
publisher: no watchdog schema/artifact/template, managed-store interface, bootstrap or
lifecycle code changes. Missing actual producer lineage and independent result acceptance
are external run-packet obligations, never proven by output consistency or file existence.
No launch, Docker mutation, lock acquisition/release, cleanup, image/runtime, DB or deploy.
unavailableAdmission and owner parents stay unchanged. Internal tooling has no app-map or
deployment-default change.

## Independent input authority

New `scripts/computer-closure-publication.ts` accepts EXACTLY requestPath and requestSha256.
There is no default, environment fallback, sibling discovery or optional unsigned branch.
Check strict lowercase64hex external hash against original bounded request bytes BEFORE
parsing or trusting fields. Root ownership is necessary filesystem trust, not approval.
The separately committed independently accepted future exact packet must pin this request
hash, code/Node/anchors/invocation AND exact completed capture hash/actual producer lineage,
existing installation hash AND public key. A request or output cannot select its own authority.

Closed version1/kind=staged-closure-publication request fields:
artifactSha256 (this publisher), supervisorPath, supervisorSha256 (raw exact input),
closureArtifactPath, closureArtifactSha256, nodeSha256, installationPath,
installationSha256, publicKeySha256, captureSha256, netNamespace, cgroupNamespace,
output and receipt RootIdentity. All hashes lowercase64hex; all paths normalized absolute;
namespace syntax canonical; roots exact closed identity shape, UID0/mode0700.
The supervisor remains a separate bounded private input with required lifetime+capture;
parse canonically without live runner/heartbeat checks. Raw input hash differs from the
canonical lifetime-absent signing template hash. Do not add stripping exceptions.

New publication config module loads request and supervisor as canonical private0600
regular files through trusted root ancestry/private0700 input directories, preserving
original dev/inode/bytes. Pin this publisher, verifier and actual process.execPath through
trusted paths, exact bounded hashes and retained metadata. Use current boot/pid/mnt/user
anchors through canonical closure validation and explicit self/PID1 net/cgroup equality.
Never query historical runner/watchdog/init liveness or rerun captureProvenance.

Require output and receipt distinct and disjoint in BOTH directions from every host,
data/dockerData/monitor/capture/signer-output root, and from each other. Also separate
both from request/supervisor/code/Node/installation/key paths. Canonical root identity,
strict trusted ancestry and dedicated0700 are independent guards. Host roots keep existing
inspectRoots/assertRoot permissions, including UID1000 home/socket targets. Empty output
is required before publication; an existing file/partial output refuses with no overwrite,
unlink, retry or evidence erasure. Receipt emptiness/absence success is not inferred.

## Canonical derivation and consumer composition

Refactor existing capture validation into one canonical loadPinnedClosureCapture that
returns validated sampled process projection plus the original capture file/times/journal.
It consumes fixed supervisor.capture/capture.json, exact independently pinned capture hash,
canonical supervisor/run/lifetime/full-ID/role/native identity/namespace/root/time shapes.
No competing parser or caller process tuples. Existing loadClosureCapture delegates to
it then ALSO compares all three independently supplied expected tuples, preserving the
mandatory closure consumer. Unused descendant/file/lock payloads remain hash-bound history,
not complete schemas, final descendants or installed producer proof.

Factor current closure loading's post-stop input validation into shared loadClosureInputs
(configuration, fixed intended configPath, verifierPath), returning existing inputs except
the config-file snapshot. The actual loader still independently reads/parses its config
and delegates; its mandatory contract and revalidation boundaries remain unchanged.
The new publisher uses this same validator BEFORE creating output. This avoids copying
installation/key/root/code/Node logic or writing a config merely to preflight trust.

Read/hash/parse existing installation with independently pinned installationSha256 and
publicKeySha256; derive ONLY its canonical fixed key path. No new signer/key generation.
Construct the unchanged exact ClosureConfiguration from parsed supervisor, capture-derived
three tuples and externally pinned verifier/net/receipt/installation/key/capture authority.
Canonical parse and shared actual input validation establish consistency, not producer
lineage. Pin and validate the actual retained journal's start prefix using assertCaptureJournal;
allow later append, disabled state and absent owned lock. Do not call readClosureRecords or
observeClosure to pretend publication is successful absence.

Publish ONLY fixed output/closure.json, canonical JSON, root0600, <=16KiB. Extend the existing
exclusive filename union narrowly. Retain the actual ProvisionPublication and recheck
request/supervisor/installation/key/capture original dev/inode/bytes, code/Node/socket/root
anchors and journal origin around existing publication awaits. After exclusive file+directory
fsync/closes/readback, execute actual loadClosureDeployment plus revalidateClosureDeployment
on the generated file, check exact published hash/dev/inode/bytes, then repeat original input
and publication validation before return. The output contains the receiver secret and remains
private; never print request/config/key bytes to public evidence or stdout/stderr.

## Native completion and verification

Standalone original60s timer begins before first I/O; this is a separate staged operation,
never a refreshed watchdog5s allowance. TERM/INT latch failure without renewing the timer.
Check safe nonnegative monotonic time/no rollback/equality<60000 and interruption around
awaited phases and at the actual final Promise continuation. Return0 only after all durable
checks; otherwise silent2, retaining partial output. A completed native operation and output
hash are delivery facts only. Independent result/run-packet acceptance still pins resulting
config and capture/installation/public-key authority; self-written output proves no approval.

Use actual capture -> actual signer -> staged publisher -> mandatory closure loader and
revalidation fixtures, including journal append/state-disable/original owned-lock release.
Retain distinct actual-loader all-recorded-processes-exited tests. Disclose OS/root/runtime/
PID1/namespace/cgroup/heartbeat/Node projections and constructed lower-level fixtures.
Native CJS tests execute real publisher/fsync/readback/final continuation under disclosed
projections, exercise original timer held file/directory I/O with repeated signals and actual
final callback equality/signal injection. Native nonroot refusal remains silent2 on Node22;
target Node24 metadata does not qualify actual Node24/image/128MiB fit.

Cover malformed/missing/extraneous argv/request authority, unsafe/private files, wrong raw
hash/installation/public-key/code/Node/namespace/capture bindings, swapped original inode/
bytes, both-direction output/receipt root separation and0700, canonical role/full-ID derivation,
deadline/rollback/signal races, held I/O/exclusive create/no retry and byte-identical retention.
Observe intended executable assertion failures with each new claimed protection removed;
retain exact patches/logs and byte restoration, including independent directory-mode and
root-overlap controls. Retain rejected reviews/executions/corrections.

Expected0, unpiped private logs: affected Computer suites (workers<=2), root/tests TypeScript,
zero-warning scoped ESLint, changed-file Prettier, file-size/diff, builtin-only signing/watchdog/
host/provision/closure/new-publication CJS and gateway context builds. Inspect dependencies/cache
then scoped frozen offline root/API/worker/web/spike/workspace install. No foundation/DB command.
Commit this exact plan and obtain independent read-only Security+Standards/Spec acceptance BEFORE
implementation. Source/correction/local-evidence acceptance, exact final-HEAD required green CI
and supplemental acceptance precede protected actual merge. Verify actual parents/tree/allPR/
concurrent-main entries/complete expected tree and separately full-tree equality. Verify a fresh
isolated successor's actual native UUID/name/route/preserved acknowledgement; historical siblings
read-only. Keep small private LIVE.md and clean committed/pushed work; continue actual owner delivery.

Kill/split owner computer-closure-publication: no second lock, self-selected authority, invented
tuple, mutable historical liveness/state/lock prerequisite, bootstrap renewal or staged publication
relabelled watchdog-owned/closure/owner acceptance. Evaluate this phase before further runtime plans.
All inherited exact-packet/resource/time/storage/trust/isolation/identity/closure gates remain:
fresh healthy Moss RAM/root>=8GiB/data>=30GiB, independently alive watchdog AND first complete
healthy sample BEFORE launch,1800s/90s/5s/gap<10s/age<5s/equality/first-I/O/bounded actual logs+
home+socket<10GiB. Reuse accepted r21; r12/r18 causes unknown. Actual installed Node24/128MiB/
TigerVNC/fixed lifecycle, final descendants, prelaunch/reset/uncertain-create, API leases/dispatch,
sole receiving writer/predecoder/epochs/pressed releases/Fence/fresh authorization and real owner
cookie/Origin/HTTPS/WSS/concise chat/positive/hostile/live acceptance remain. No production deploy.
