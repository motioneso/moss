# Managed Computer terminal lifecycle evidence

Part of #3618/#3617/#3616/#3577. Base `2f3ff6ae6c631c45225b92fd8682a178ece6279f`
is the verified PR #3649 merge, matching its accepted tree and24 source hashes. Final local and
CI acceptance comments6384345154/6384478718 reconcile with run40094799674 and successful required
CI gate120877071207; supplemental app-action run40094799707 succeeded at that same head.
All five parent owner issues remain open. The [plan](../../superpowers/plans/2026-10-24-moss-computer-host-terminal-integration.md)
and [host dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-host-terminal-integration.md)
bound this slice. [JSON](2026-10-24-host-terminal-integration.json) records exact commands, exits,
source/artifact/patch/log hashes and retained review rounds. Raw evidence remains outside ~/Jarv1s.

## Result and authority boundary

Explicit opt-in watchdog manage mode co-locates the existing-resource host control service with
its trusted root supervisor under the canonical sole lifecycle lock. Runner and collector remain
distinct; the actual authenticated Unix lifetime supplies receiving authority. Startup requires
exact enabled binding and refuses a stop marker. Observe/fence do not silently acquire management.

Normal disable/recreate and autonomous root termination converge on one irreversible action.
Enable changes no CAS/state or resources. Recreate cleans existing resources, reports prerequisite-
unavailable and never restarts. The standalone host tool persists terminal intent but cannot clean
without an actual root outcome. No installed executable retains the old tuple-erasing stop path.

Lifecycle latch/immutable stop persistence starts independently of signed receiving stop and root
journal/collector finalization. Cleanup requires both the same actual supervisor invocation's
complete successful outcome and separate lifecycle file+directory durability. Canonical recovery
preserves IDs, generations, pending intents and first stop evidence, advances request CAS and
removes gateway before desktop. State publications and Docker mutations recheck marker/current
state/deadline after awaited work; equality refuses mutation. Managed lifecycle has an absolute
120s bound. Root outcome2 exits the process immediately at the inherited absolute5s bound even
when lifecycle fsync is held; it never waits for120s. Failure retains lock/evidence/identities;
settled success drains responses and releases the lock.

This is internal existing-resource tooling. unavailableAdmission, normal API deployment and product
app-map capabilities remain unchanged. Local cleanup does not independently prove resource/PID/
start/group/endpoint closure or healthy Moss. Per-run trusted config provisioning after create and
before start, new-run/reset and uncertain-create quiescence remain implementation work. No lock
stealing, marker reset, create retry, invented ID, home or volume deletion is introduced.

## Independent source review and corrections

Plan95fccada4 securityR1 required prompt managed process exit2 on actual failed root finalization.
The exact amendment6aba9e221 received independent security and Spec acceptance before source work.
Source36b477fce received Standards acceptance; independent security/SpecR1 blocked state publication
without a post-await lifecycle deadline check, and native tests holding roots validation instead
of actual fsync. A native file-fsync equality regression failed the unchanged-state assertion
against that source before correction. Every failed review/execution round remains hashed in JSON.

Corrected production source `0644b9a35e7723dad3fe166468f16770e3abc75d` received independent
Standards, Spec and securityR2 acceptance with zero remaining blockers. Canonical HostStateStore
save now consumes the same mutation guard after awaited temporary-file I/O, then synchronously
checks deadline/state immediately before rename/local publication. Both reconciliation saves use
it. Final checked source `8e4cc7bd5bbb3423548472a45a1b269d5fc4a296` changes only tests after that
production acceptance: actual file/directory fsync-held acknowledgements and lower/upper root
process timing bounds, including autonomous heartbeat EOF. Exact final local evidence acceptance
is a separate gate recorded on the PR; source review alone does not certify author execution.

## Executed checks and sensitivity controls

Final restored source passed501 tests across25 Computer suites, including21 managed tests.
Root and tests TypeScript, scoped ESLint zero warnings, changed-file Prettier, file-size, whitespace,
builtin-only watchdog/host bundles and gateway context build all exited0. Node execution was
v22.22.2; Node24 bundle metadata does not qualify actual Node24 or128MiB fit.

Native Unix requests drive actual root/lifetime/receiver/core to recording Docker cleanup, including
separate native process composition, active pressed-input retirement and drained successful response.
Coverage includes owner/CAS denial, enable immutability, recreate without restart, autonomous EOF,
failed/held lifecycle file/directory fsync, missing root acknowledgements, equality before cleanup
and during state/inspection I/O, same-byte marker replacement before publication, gateway failure,
retained identities, canonical lock contention and bounded root process failure. Both actual native
fsync holds acknowledge entry; the root exits2 after4500ms and before6500ms while they remain held.
The file case begins with autonomous heartbeat EOF before subsequent repeated real TERM signals.

All15 deliberate removed-protection controls exited1 at intended assertions; no generic test timeout
counts as proof. Every source byte was restored and hashed after each control before final checks.

| Removed protection                                                                        | Observed intended failure                          |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Owner check                                                                               | Owner-denied result mismatch                       |
| Request CAS                                                                               | Stale-generation result mismatch                   |
| Enable immutability                                                                       | Durable state bytes changed                        |
| Receiving fence, root durability, collector exit, successful root outcome (four controls) | Cleanup promise resolved instead of rejecting      |
| Lifecycle expiry                                                                          | Cleanup resolved at equality                       |
| Post-await publication deadline                                                           | Durable state bytes changed at equality            |
| Publication marker revalidation                                                           | Same-byte replacement allowed state publication    |
| Stop-file fsync                                                                           | Managed run resolved instead of rejecting          |
| Stop-directory fsync                                                                      | Request CAS advanced despite failed durability     |
| Gateway failure halt                                                                      | Desktop mutation occurred after gateway failure    |
| Autonomous root terminal hook                                                             | Actual lifecycle-fsync-held acknowledgement absent |
| Immediate failed-root exit                                                                | Process remained alive beyond root bound           |

First test attempts had an incorrect host-binding auth fixture call, then controller opening before
owner takeover; corrected fixtures follow established receiving tests. An intermediate root typecheck
caught an implicit-this annotation; final checks include its correction. These failed attempts are
retained and are not final evidence. Tests disclose synthetic auth/readiness/Docker/root-ownership/
namespace/collector-journal and library Fence fixtures. They do not establish installed root trust,
real Computer health/inventory/TigerVNC, image/Node24/128MiB fit, independent closure or live owner
HTTPS/WSS/chat. No Computer image/runtime/Docker operation, DB/foundation command, TCP server,
browser, installation, production action or persistence requalification occurred.

## Merge and continuation gates

Exact final PR HEAD required CI gate and independent supplemental CI/evidence acceptance precede
protected actual merge. Docs-only finalization requires scoped formatting/whitespace/source-equality
checks and its own exact green CI; local evidence does not substitute for those receipts. Verify
actual merge and execute the [closure successor dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-closure-integration.md)
in a fresh isolated worktree, verifying durable agent name, actual session UUID and handoff-read
execution acknowledgement. The full inherited runtime/resource/health/auth/closure gates remain;
reuse accepted r21 persistence, with r12/r18 causes unknown. No production deployment or runtime
admission follows. A merged prerequisite never finishes actual #3616 owner delivery.
