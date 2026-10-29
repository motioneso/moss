# Managed-root Computer process capture evidence

Part of #3650/#3618/#3617/#3616/#3577; #3619 stays open. Internal opt-in tooling only.
[Accepted plan](../../superpowers/plans/2026-10-24-moss-computer-trusted-capture.md),
[capture dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-trusted-capture.md),
[exact manifest](2026-10-24-trusted-capture.json) and
[next dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-bootstrap-health.md).

## Exact source and scope

Base `516bbb811a79115f2a4c331cdd534905bf51ba2a`. Accepted bounded plan `c1061a6011b584be17b9b449eab33ff2b524edf4`.
Checked source `440aa5074818dc8cc20303e82aa1de4181b5728b`; production scripts byte-for-byte equal
`7e6ffb2dc0394a78f6a72c765ceee30e195bd05f`. Later final evidence commits contain documentation only;
source and final PR HEAD are different roles. The JSON binds every changed source/test/plan/handoff
file, all final command log hashes, native artifacts and receipts, intended controls and review
reports. Independently accepted Security + Standards/Spec source R6; prior failed rounds retained.

The actual manage caller passes its SAME managed store/sole lifecycle lock into capture after
exclusive journal creation and before driver installation. Repeated native host identities,
full-ID Docker running PID/start, bounded recursive cgroup-v2 descendants and pinned managed
provenance produce an exclusive private sampled snapshot. File+directory fsync/close, source
rechecks and byte readback complete within the original absolute5s bootstrap bound. The awaited
handoff and native acknowledgement recheck equality before retiring that timer. Failure retains
lock/output/state/journal; no Docker mutation, lock reacquisition or launch admission is added.

## Executed checks

All12 final unpiped commands exit0 at the checked source: 649 tests across30 Computer suites
(including54 capture tests across2 suites), root and test TypeScript, scoped ESLint/Prettier,
file-size and diff checks, four builtin-only Node24-target CJS bundles (watchdog/host/provision/
closure), and gateway context build. These are tooling/context builds, not image builds or runtime
qualification. Original final-r1 passed649tests but failed root fixture typing and lint; corrected
R6 fixture imports/type shadowing/piped-stream types pass the complete final-r3 batch. Final-r2 passed all649tests and both type checks but retained one unused type-only import; removing it leaves emitted fixture JavaScript byte-identical, with equality receipt retained. The final batch uses two isolated file workers.

All26 intended removed-protection controls exit1 at assertion failures, never syntax/import/setup
failures, with byte-for-byte source restoration. Controls cover repeated process/journal/metadata/
lock pins; Docker running-state, recursive cgroup membership/duplicates/mount/namespace/full-ID/
host/init/depth/entry checks; fsync/close; signal/equality/handoff/native timer; output bounds,
exclusive output and byte readback. Production bytes are identical across these controls and final
source. Only test corrections/types changed after early controls. The initial malformed foreign-ID
patch and false-green readback attempt are retained in failed-attempt manifests and do not count
as intended failures. Named patch/log files contain the latest corrected executions; earlier
attempt manifests preserve original outcomes and hashes, not an assertion that overwritten raw
logs still exist. Corrected readback uses equal-length tampering after creation metadata to remove
the earlier size-check confounder. All final accepted control logs/patches exist and are hash-bound.

## Native completion and limits

The actual production bundled CJS runs under disclosed OS root/group/runtime/namespace/cgroup/
heartbeat/Node projections with Unix Docker fixtures. Four source/artifact-bound native receipts
record actual native UID/GID, Node, real timer observations, exit2/no signal and empty stdout/stderr.
File persistence elapsed5017.526ms and directory persistence5007.577ms,
both at the original5s deadline despite repeated TERM/INT (observed bounds4900<=elapsed<6800ms).
Positive continuation elapsed380.658ms acknowledges actual native acknowledgeStartup
and capture presence after driver installation; it deliberately fails without an installed
receiver. Boundary elapsed773.355ms injects exact deadline equality and proves no
continuation acknowledgement. Cleanup timer clears cannot satisfy the guarded observation.
Each mode retains lock/output and permits only GET Docker observations. Bare unprojected production
CJS refuses actual nonroot execution silently with exit2 in the final trust suite.

These receipts do not qualify installed root/group/code/signing/closure provenance, actual
Node24/image/128MiB fit, a first complete healthy sample, continuous/final descendant closure,
new-run/reset/uncertain-create or runtime admission. No actual Computer image/runtime operation,
Docker mutation, database, browser/TCP server, installation or deployment occurred. Existing
unavailableAdmission is unchanged. All owner parents remain OPEN. Final exact local acceptance,
final-HEAD required green CI + supplemental acceptance, protected actual merge verification and
verified fresh isolated successor are separate gates recorded on the PR. No CI claim transfers
from an earlier source commit or from the unrelated PR3656.
