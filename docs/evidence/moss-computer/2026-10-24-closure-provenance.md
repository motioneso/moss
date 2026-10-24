# Root-pinned Computer closure signer evidence

Task #3664; part of #3618/#3617/#3616/#3577, with #3619 open. Internal opt-in tooling.
[Corrected plan](../../superpowers/plans/2026-10-24-moss-computer-closure-provenance.md),
[preceding dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-closure-provenance.md),
[exact manifest](2026-10-24-closure-provenance.json) and
[next dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-closure-delivery.md).

## Accepted source and actual composition

Base `6cffffed4baaafa5b333992a98eadc4803d6bbf2`, actual PR3663 merge with independently accepted
parents/tree/all9 PR entries and zero concurrent-main entries. Full-tree equality was separately
true for that base merge. Initial plan `cb16fa9fb63c2aa025fc1cd18a2bf1760933154c`; corrected plan
`48daab600e64f9fcc800f55a16adced0a390c387`. Both independent Security and Standards/Spec reviews
accepted before implementation; source R1 findings required the documented guest-root correction.
Both source R2 reports accept the six exact production hashes. Checked source `d81ed344c9f725e43dbe9f349546ef89a14bd82d`;
production bytes equal `0d2ba4b414937e34c6b40feea43c4f8e92987a89`. Subsequent evidence commits
change documentation only. Checked source, final PR HEAD and actual protected merge are separate
identities. Required CI belongs to the final PR HEAD, never silently to a merge SHA.

The actual root signer publisher requires a private, closed, lifetime-absent request with
independently supplied installer/verifier/Node hashes, supervisor template and boot/pid/mnt/user/net
anchors. It pins trusted existing executable paths; it does not copy/install executable code.
It generates a native Ed25519 key, then exclusively publishes private PKCS8 PEM and installation
manifest through the existing canonical descriptor-pinned publisher. File and directory fsync,
close and inode/metadata/byte readback remain required. Partial files persist; retry refuses
nonempty output. No state store, lifecycle lock, Docker, admission or reset authority is introduced.
The original60s native timer starts before I/O, signals latch failure, and the actual final Promise
callback independently refuses equality/interruption before exit0.

Actual loadClosureDeployment now requires the independently pinned installation path/hash and
checks the original template without lifetime, verifier path/hash, actual Node path/hash, boot,
namespaces, key/SPKI and fixed private output children. Revalidation binds installation inode/bytes
alongside config/key/code/Node/root checks. The manifest is a delivery record, not native completion
or independent installed acceptance. A later accepted installation/run packet must independently
pin request/code/Node/anchors and resulting installation hash AND public key. Post-stop loading
still works after recorded processes exit, without a runner liveness or heartbeat requirement.

Source R1 incorrectly applied strict root-owned target checks to every host mount root. Both
reviewers rejected it: existing desktop UID1000 requires writable home/socket mounts. The corrected
plan/source retain canonical inspectRoots permissions/ancestry and assertRoot identity checks for
host roots, reserving strict root trust for private installation/code/config/key and trusted
supervisory roots. Actual publisher/mandatory-loader tests exercise projected UID1000 home/socket
success, unsafe host ancestry and separate signer-prepublication/consumer-postload replacement
refusals. Output remains disjoint from host/data/docker/monitor/capture and receipt roots.

## Executed checks and retained corrections

All13 fresh final-r3 unpiped checks exit0 at the checked source: **723 tests across31 Computer suites**,
including52 signer and8 actual closure-trust tests; root/tests TypeScript; scoped ESLint zero
warnings; changed-file Prettier; file-size/diff; five builtin-only Node24-target CJS bundles
(signing/watchdog/host/provision/closure); fresh gateway context build. Two isolated file workers
ran Computer tests. Production and checked source hashes match before/after the batch.
These are internal packaging/context builds, never Computer images or runtime operations.

All29 final removed-protection controls fail at their intended executable assertions and restore
production byte-for-byte. Coverage includes request code/Node hashes, net/no-lifetime/output
separation/input inode, mandatory manifest hash/template/verifier/Node/net/public-key/output-parent/
installation inode, independent signer and closure host-root identity comparisons, library deadline/
signal, actual native callback deadline/signal and original timer, PEM-only byte representation and
4096byte bound, closed request/installation schemas and fixed key child, file/directory fsync and
close. Hash-bound patches/logs/restoration and exact test-source hashes are in the manifest.
Grouped code/Node removal yields3 failing assertions, byte-representation removal2, others1.

Local R1 found the signer host-root negative was confounded: it completed publication before root
replacement, so nonempty output could independently explain failure. The prior23 control results
and13-check/721-test batch remain retained but are superseded for final acceptance. Corrected
separate tests replace the signer root BEFORE any publication, assert empty output, and separately
replace a closure root AFTER successful load. Removing only each relevant snapshot comparison
now causes its intended assertion to fail. Both local R1 reports and the original test commit,
patches/logs/check manifest/native receipts remain retained. No production protection was weakened.

The subsequent final-r2 batch was interrupted during the reported server failure. Its raw
capture/capture-trust logs contain timeout failures, including severe scheduler stalls; no completed
checks.json exists and that batch is excluded from acceptance. All logs and a separate interruption
record remain retained and hash-bound. Fresh final-r3 uses at most two concurrent checks, records
completions incrementally, and supplies the final results below without weakening test timeouts.

Initial signer execution retained11 failed/23 passed tests: frozen parsed objects were mutated and
nested filesystem spies recursively called the same mock. Request provenance negatives were also
changed to exercise the actual loader after mutation rather than merely original-request byte
revalidation; directory-close injection was limited to publication after key creation. The retained
initial TypeScript rounds include readonly test assignments, native callback this/cleanup typing,
and missing visual-chat-runtime-spike dependencies caused by a wrong install filter. Corrected
scoped frozen offline install links all51 workspace projects without package/lock changes. Final
root/tests types and tests pass. Failed executions/reviews are preserved rather than overwritten.

## Native execution and limits

Five raw source/artifact-bound projected native receipts execute unchanged production signer CJS.
The positive exits0 after actual key/manifest persistence; its installation is then consumed by
the actual mandatory closure loader in the parent. Held key-file/directory fsync cases send TERM,
INT and TERM under a disclosed2s scaling of the original60s timer and exit2 at 2003.473356/2004.732366ms
from that timer, with no native exit signal. The safety SIGKILL does not satisfy these assertions.
Callback equality/interruption cases each reach the actual final Promise callback with helper
result0, inject there through a disclosed wrapper, and require native exit2. Removing only the
corresponding native guard changes the observed result to0 and fails the intended assertion.
Removing the native timer's failure exit likewise produces0 instead of required2.

All five receipts show empty stdout/stderr and the same signer artifact as the separately built
builtin-only bundle. A sixth separate unprojected execution records actual nonroot UID, native
Node, argv/artifact/times and silent exit2. Raw private receipts retain actual argv/UID/version,
artifact/preload hashes, streams, timing, callback IPC and repeated signal sends. Public evidence
retains hashes/sanitized facts, never request/key bodies or private paths.

Ownership/mode/runtime/PID1 visibility and Node bytes are explicitly projected in signer fixtures;
the actual publisher crypto, filesystem publication and mandatory consumer run. The existing
closure-trust suite additionally projects its inherited runtime/namespace checks. Directly
constructed lower-level ClosureDeployment fixtures intentionally bypass installed loading and
are excluded from publisher-to-loader provenance proof. Native execution is Node22; Node24 bundle
metadata does not qualify actual Node24/image/128MiB fit or installed root trust.

No actual root installation, Computer image/runtime, Docker mutation, DB, browser, TCP server or
deployment occurred. unavailableAdmission is unchanged and owner parents remain OPEN. Per-run
closure configuration delivery/capture binding, final descendant reconciliation, prelaunch health
ordering, reset/new-run/uncertain-create quiescence, actual Node24/128MiB/TigerVNC/fixed lifecycle,
API leases/dispatch and real owner HTTPS/WSS/chat/hostile live acceptance remain separately gated.
Independent exact local acceptance, final-HEAD required green CI and supplemental acceptance,
protected actual merge and verified fresh isolated successor remain release gates. A prerequisite
never finishes actual owner integration.
