# Mandatory sampled capture binding evidence

Task #3668; internal tooling in PR #3669. [Accepted plan](../../superpowers/plans/2026-10-24-moss-computer-capture-binding.md),
[exact manifest](2026-10-24-capture-binding.json), [prior dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-closure-delivery.md)
and [continuation](../../superpowers/handoffs/2026-10-24-moss-computer-closure-publication.md).

## Exact boundary

Base26c2a366ef41c90e7198a8d2903004fe0ab61b6e, planf70e3c77e3ec52f62ce60d06db33bf24bc1b97ee,
checked sourcede5a12bd095a58cc8e8624b23c42ad1cc0b50bad. Independent Security and Standards/Spec
accepted the exact plan before implementation and exact source R1 without blockers. Source hashes,
private report hashes, commands/exits, artifacts and retained correction logs are in the manifest.
Subsequent documentation does not change checked production bytes. Checked source, final PR HEAD
and actual protected merge are separate identities; required CI belongs to final PR HEAD.

The actual closure parser requires captureSha256, supervisor.capture and lifetime. It reads only
the fixed private capture.json through bounded canonical file checks and matches run/lifetime,
runner/watchdog and both init PID/start/group/full-ID tuples. It validates consumed envelope,
namespace/root/journal/timestamp shapes; unused descendant/file/lock payloads remain hash-bound
history without full schema or final-descendant validation. Actual self/PID1 net/cgroup and trusted
pid/mnt/user/boot anchors and deployment roots must match. Revalidation preserves original capture
inode/bytes alongside existing configuration/key/installation/code/Node/root checks.

Retained journal dev/inode and exact first newline-terminated start-prefix size/hash bind origin.
Later collector/sample/stop appends are permitted; the final journal size need not equal start size.
Actual start time enforces startedAt<=measured<=finished<startedAt+5000. Existing collector/run/state/
stop validation remains. No live recorded-process/heartbeat lookup, historical state hash comparison,
lock existence/ownership requirement or new lifecycle authority is introduced after stop.
Capture hash is transitively signed via the trusted configuration hash, never self-selected authority.

## Executed verification

All 13 final-r1 unpiped checks exit0 with restored checked bytes: **773 tests across 32 Computer
suites**, root/tests TypeScript, zero-warning scoped ESLint, changed-file Prettier, file-size/diff,
five builtin-only Node24-target CJS bundles and a fresh gateway context build. The repository keeps
test files sequential; the command caps workers at two. These are packaging/context builds, never
Computer images/runtime.

All 33 removed-protection controls produce intended executable assertion failures (42 failing
assertions), retain exact patches/logs and restore production byte-for-byte after each case.
Coverage includes mandatory capture root/hash, byte/hash/envelope/type/run/time/native identity/
lifetime/role/full-ID/init-PID/StartedAt/boot/root/namespace bindings, journal shape/size/hash/inode/
device/prefix/strict bootstrap window, actual records consumption and original capture inode/bytes
revalidation. Composed/redundant revalidation checks are removed together where needed. Canonical
unchanged lifetime/private-file/runtime guards retain their affected tests and inherited controls;
this does not claim each reused guard was independently reimplemented or newly isolated here.

The actual captureManagedProcesses publisher and actual signer publisher feed the mandatory loader,
readClosureRecords and deployment revalidation after real journal append, disabled-state transition
and release of the fixture's original owned lock. That positive does not execute full observeClosure
absence success. Existing actual-loader coverage separately retains all-recorded-processes-exited
behavior. Native production CJS under actual nonroot Node22 silently exits2; raw execution and artifact
hashes are retained. No new timer/native completion contract is introduced by this read-only binding.

Initial affected tests retained 96 passes/one failure: a guest-root projection happened after constructing
the historical capture. The fixture now constructs it after the projection. The first new suite
retains 50 failures in an inherited nested boundedFile spy before reaching loader validation; capturing
the prior mock implementation fixes the recursion. The next focused run refused an unprojected new
receipt root; measuring it through the existing projected fixture I/O fixes that fixture boundary.
Then the focused actual composition and all 50 new tests passed. No production guard was weakened.

## Limits and remaining gates

Fixtures disclose OS ownership/runtime/PID1/namespace/cgroup/heartbeat/Node byte projections. Native
execution is Node22; Node24 target metadata does not qualify actual Node24/image/128MiB fit. Explicitly
constructed lower-level capture/deployment fixtures bypass installed loading and are excluded from
actual publisher provenance. The accepted contract proves historical sampled-init provenance only.

No installed root trust, per-run closure configuration publisher, final pre-stop descendants,
prelaunch admission, reset/uncertain-create quiescence or actual owner delivery is established.
No Computer image/runtime, Docker mutation, DB, browser, TCP server or deployment operation occurred.
unavailableAdmission is unchanged and owner parents remain OPEN. Exact local-evidence acceptance,
required final-HEAD green CI and supplemental acceptance, protected actual merge and independently
verified fresh isolated successor remain release gates. Continue full owner delivery under every
inherited runtime/resource/time/storage/trust/isolation/identity gate.
