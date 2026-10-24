# Computer terminal stop/reconciliation prerequisite evidence

Part of #3618/#3616/#3577. This is internal opt-in tooling; parent owner issues remain open.
Base `e6f0c388297e31b065f3dc93b651a8dede318d95` is the actual PR #3645 merge.
The [plan](../../superpowers/plans/2026-10-24-moss-computer-lifecycle-recovery.md) and
[lifetime dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-lifetime-fencing.md)
limit this slice. Machine-readable hashes/commands are in [the evidence JSON](2026-10-24-lifecycle-recovery.json).
Raw private logs remain outside ~/Jarv1s; only sanitized summaries/hashes are published.

## Implemented and independently reviewed source

The fixed `computer-recovery <inspect|stop> <private-host-config>` command opens only existing
validated state with the existing exclusive lock. Inspect performs no writes/Docker mutations.
Stop latches locally before I/O, fsyncs one immutable stop marker and its directory before
mutation, advances request CAS, disables state and reconciles complete exact inventory. Resolved
full IDs are saved before gateway-first removal and retained after cleanup/restart. Gateway error
halts before desktop; only initial known-ID inspect404 proves absence. Pending-name404 remains
unresolved. No create retry, lock stealing, terminal reset, home deletion or volume deletion.

Normal mutations refuse terminal stores. Docker create/start and normal remove check terminal
state after internal asynchronous inspection and immediately before mutation. State publication
validates terminal constraints, renames synchronously and publishes local state without an await
between these steps, then fsyncs the directory. A typed terminal conflict allows only a compatible
disabled save of a late create ID. Failed persistence remains failure.

Plan `c6bfeee3c` security R1 blocked ID erasure/CAS omissions; amended exact plan
`c9c22664f70f6dc0a70d73a3210b9930a58c99d6` received independent security and Spec R2 acceptance.
Source `3eb847bb952840659e5f57e233cfbe3eb75b1bab` received Standards acceptance but security/Spec
R1 blocked state-save and normal-disable races. Three native regressions failed at the intended
assertions against that source. Corrected source
`1762b346100c2f84aafc1a273efb9d4f290b3407` received independent Standards, Spec and security
R2 acceptance with zero remaining blockers. Commit
`2889b3d4a74dbee8d92f3f9b7b8eec6614c41572` adds the same-byte marker-replacement regression;
implementation files are unchanged. Every review round and failed attempt is retained by hash.
Final exact evidence acceptance is separate and recorded on the PR before merge.

## Executed checks and adversarial controls

All fixture tests use native temporary files, real private Unix HTTP and actual recovery CLI
subprocesses against a recording Docker stand-in. They perform no real Docker/image operation.
Coverage includes missing existing state, live/stale lock refusal, immutable first marker,
write/file-fsync/directory-fsync failures, held fsync, resumed marker re-sync, malformed/symlink/
FIFO/mode/hardlink markers, tuple mismatch, pending-name404, resolved pending IDs persisted before
mutation, lost DELETE acknowledgements, gateway-first halt, home retention, fixed arguments and
sanitized CLI output. Launch races cover asynchronous admission/create/start, final synchronous
checks, save root/file-fsync boundaries, late-ID retention and snapshot publication during dirfsync.
Same-byte marker replacement during cleanup inspection prevents every actual mutation.

The JSON records exact final commands, exit codes and log hashes for root/tests TypeScript,
scoped ESLint/Prettier, file-size, diff validation, builtin-only recovery bundle and focused
host/client/recovery/observer suites: 289 tests passed across 10 files (36 recovery tests). An initial successful check batch overlapped source corrections
and is retained as non-final evidence; the second batch pins the tested commit. The local Node
executable is v22.22.2. Bundling targets Node24 metadata only; actual Node24 execution is unqualified.

Twenty deliberate removed-protection controls each exited1 at an intended assertion. The JSON
records the exact selectors, mutation patch/log hashes and byte-for-byte restoration. Controls
cover existing-only open, file/directory fsync, mutation-before-write failure, existing-marker
re-sync, terminal launch refusal, tuple binding, pending intents, CAS advance, gateway-first halt,
terminal ID retention, post-inspect start refusal, final synchronous guard, late state publication,
normal-disable guard, late-ID fallback and exact ID retention, marker inode replacement, volume
removal flags and fixed CLI vocabulary. The late-ID retention control specifically failed the
full-ID resource assertion; the directory-fsync omission advanced state before a later state-file
fsync failure, failing unchanged-state evidence. All original source was restored after each run.

## Limits, CI and continuation

No actual image/runtime, DB/foundation, server, production or home-persistence requalification
operation occurred. No new product/app-map capability, dependency or deployment setting.
unavailableAdmission remains unchanged. This command is usable after clean daemon lock release;
it does not implement automatic crash recovery, root-to-receiver lifetime IPC/acknowledgement,
normal terminal disable/recreate integration, supervisor/daemon integration, new-run/reset or
uncertain-create quiescence. Local command success is not independent Computer resource closure.

Actual image/Node24/128MiB/TigerVNC qualification, fixed lifetime integration and independent
resource/PID/start/group/endpoint/healthy-Moss closure remain gated. Before any image/runtime
operation require a separately committed independently accepted exact packet, fresh healthy Moss
and resource floors, independently alive watchdog and first complete healthy sample, with all
inherited isolation/deadline/root-trust gates. Reuse accepted r21 persistence; r12/r18 causes remain
unknown. Real owner cookie/Origin/HTTPS/WSS/chat/agent leases and live positive/hostile paths still
precede owner completion. No production deployment is authorized.

The actual main ruleset requires `CI gate`. Exact final PR HEAD green CI and independent
supplemental CI/evidence acceptance must be recorded on the PR before protected actual merge.
Verify the merge and execute the committed
[successor dispatch](../../superpowers/handoffs/2026-10-24-moss-computer-terminal-integration.md),
including isolated launch, durable routing/session UUID and handoff-read execution acknowledgement.
