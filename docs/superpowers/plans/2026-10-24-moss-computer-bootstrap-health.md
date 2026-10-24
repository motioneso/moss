# Computer bootstrap requires durable first health

Task #3662; part of #3618/#3617/#3616/#3577, with #3619 open. Approved design:
persistent-desktop spec24–27. Base `8786e0a3cd802f9a5e1395628248be5cddc0ad31`, actual
PR3658 merge; accepted final HEAD `635080cf3a7f556dc340baf03539427011be6708` and checked
source `440aa5074818dc8cc20303e82aa1de4181b5728b`. Fresh receipts confirm CI40115207223
attempt1 and required successful CI gate120938353588 at final HEAD, local6387167399,
supplemental6387369693 and actual-merge6387393956 acceptance. All21 PR paths match final
HEAD and all59 concurrent-main paths match first parent; full-tree equality is false.

Follow the complete [bootstrap dispatch](../handoffs/2026-10-24-moss-computer-bootstrap-health.md)
and inherited contracts. This bounded slice changes internal existing-resource observation only.
No Computer image/runtime operation, installation, launch admission, product wiring or deployment.
Keep unavailableAdmission unchanged and all owner parents open. A prerequisite never finishes
actual owner delivery.

## Seams and choice

Graph indexing completed but explicitly excludes scripts; bounded source supplied these seams:

- `scripts/computer-watchdog.ts:13–18` fixes startup time before I/O and owns the native absolute5s
  timer; acknowledgeStartup currently checks equality then clears it.
- `scripts/computer-watchdog/supervisor.ts:434–486` creates the actual journal, performs optional
  managed capture, installs the driver and immediately calls started, before any healthy sample.
- `scripts/computer-watchdog/supervisor.ts:324–385` runs the fixed collector, durably records its
  identity before releasing input, validates its result using canonical policy, awaits sample
  persistence and checks freshness before starting the lifetime channel.
- `scripts/computer-watchdog/supervisor.ts:58–143` spawns only the pinned Node/artifact; exact
  bounded correlated output with native exit0 is required before its result resolves.
- `scripts/computer-watchdog/observe.ts:151–199` anchors measurement time before first I/O,
  revalidates code/config/namespaces/state/roots, collects readiness/logs/resources/identities and
  rechecks before returning. No alternate successful sample provider belongs in production.
- `scripts/computer-watchdog/journal.ts:164–216` appends samples with actual file+directory fsync;
  inspect correlates its owned descriptor with the path and expected size at :122–138.
- `scripts/computer-watchdog/lifetime.ts:40–68` starts the asynchronous authenticated channel only
  when policy is healthy; activation acknowledgement is separate from startup health.
- `scripts/computer-watchdog/managed-host.ts:66–77` passes the existing HostStateStore and sole
  lifecycle lock into supervisor composition. Never reacquire, steal or release it for health.
- `scripts/computer-closure/config.ts:23–36,99–122` consumes independently provisioned init tuples,
  signer pin and root-owned installation. Sampled capture is not final descendant closure and no
  installed signer/provenance publisher exists here. Leave this boundary separate.

Choose to move native startup acknowledgement into the driver's actual first durable healthy
sample continuation. A separate synchronous observation would duplicate collection, lose the
independent child/tick boundary and risk using a second sample as authority. An installed timer
or declared callback alone proves no health. Retain the existing collector and journal pipeline.

This sample concerns already recorded resources. Lifetime-enabled observation requires the pair
already running; it cannot satisfy the separate BEFORE-launch watchdog/sample gate. A later
independently accepted prelaunch/launch contract must resolve that ordering; do not launch now.
Signing installation/provenance, final pre-stop descendant reconciliation, new-run/reset and
uncertain-create quiescence remain separately accepted work.

## Exact bootstrap contract

The native timer starts once before configuration I/O and stays referenced across journal creation,
optional capture, driver installation, collector spawn/identity persistence, actual collection,
sample validation and sample persistence. No renewal, replacement timer or grace period. Equality
at startedAtMs+5000 refuses acknowledgement. The driver's existing one-second ticks and independent
terminal finalization remain active; the native bootstrap bound can expire before finalization.
TERM/INT and managed terminal abort remain irreversible; repeated signals cannot extend either.

Add an optional `started?: () => void` notification to the driver's input solely to retire the
native bootstrap timer. It is an output notification, never an admission/health predicate.
Actual superviseDeployment always supplies the native caller's acknowledgement. Remove its
immediate started call. Absent notification preserves direct driver test/library behavior.

The driver invokes this notification exactly once, only in the first sample continuation after:

1. Actual fixed native collector's identity was durably journaled before collection; exact bounded
   run-correlated output and successful native process/stream close produced the result.
2. Canonical policy accepted the complete sample. Original measuredAtMs is retained; no sample
   renews runner heartbeat. All existing identity/resource/health/log/stop checks stay in force.
3. Actual sample append and file+directory fsync completed, then the actual journal descriptor/path
   inspection completed. Neither a record's existence nor pending persistence can acknowledge.
4. After the awaited work, terminal/abort state, policy healthy status, original sample age<5s
   and original bootstrap elapsed<5s are rechecked. The bootstrap guard also runs before persistence.
5. Existing lifetime startup occurs only after this durable healthy boundary. Recheck terminal,
   policy/freshness/bootstrap immediately before the notification; its native acknowledgeStartup
   independently rechecks exact deadline equality before clearing the original timer.

Set the one-shot latch before invoking the notification. Throwing notification enters existing
irreversible failure/finalization; no subsequent sample, heartbeat, signal or cleanup can call it
again. Terminal state or a held/failed collector, identity write, sample write, fsync or inspection
cannot acknowledge. Cleanup clearing the native timer is never a successful acknowledgement.
Guard bootstrap checks only while first notification remains pending; later samples keep their
existing lifetime/policy bounds rather than a permanent five-second run limit.

No new configuration, receipt schema, key, dependency, setting or required deployment default.
Journal schema and managed capture order remain unchanged. Successful acknowledgement means only
first sample completion; it is not receiver activation, continuous health, closure or admission.

## Verification and kill gate

Cache inspected; scoped offline frozen root/API/worker/web/spike/workspace install required.
No foundation/DB, actual Computer Docker/image/runtime, browser, TCP server or installation.
No UI/model calls; later feedback comes from records and models propose authorized tasks/input.
Kill owner computer-bootstrap-health: split/reject if this requires launch admission, a second
lock, fabricated tuples/samples, timer renewal, weakened trust or calling sampled closure complete.
Evaluate this phase alone before planning installed provenance or prelaunch admission.

Focused driver tests exercise unacknowledged initial installation, held identity/sample/inspection,
unhealthy/malformed sample, policy expiry/age/bootstrap equality after awaits, signal/abort during
persistence, throwing notification, exactly-once acknowledgement and later healthy samples beyond
five seconds. Execute actual superviseDeployment wiring, not only the detached driver.

Native fixture composition executes the production builtin-only CJS plus its actual separately
executed collector and observeComputer, with disclosed OS ownership/runtime/namespace/Node and
resource projections and private Unix Docker/readiness fixtures. Never replace collector output
with a healthy object. Record native timer creation, actual guarded acknowledgeStartup invocation,
journal first sample and completion streams/exit/timing. Positive health is bounded fixture proof,
not installed delivery. Update prior capture continuation fixtures to reflect the stronger
acknowledgement; preserve their capture persistence/equality coverage. Held first sample file and
directory persistence and held collection must silently exit2 near the original5s despite repeated
signals; positive acknowledgement must follow actual durable sample, never final cleanup. Native
nonroot CJS refusal stays silent exit2. Disclose Node22 versus Node24-target metadata.

Observe intended assertion failures when each newly claimed protection is removed; retain patches,
logs and failed rounds, restore byte-for-byte, then execute the final green batch. Expected0,
unpiped private logs: focused bootstrap and all affected Computer behavior suites;
`pnpm exec tsc --noEmit`; `pnpm exec tsc -p tsconfig.tests.json --noEmit`; scoped ESLint with
zero warnings/Prettier; `pnpm check:file-size`; `git diff --check`; builtin-only watchdog/host/
provision/closure CJS bundles and `pnpm build:computer-gateway <new-private-output>`.
Evidence binds exact checked source, native receipts, all commands/exits/logs and restored bytes.

Commit this contract and obtain independent read-only Security+Standards/Spec acceptance BEFORE
implementation. Retain failed reviews/corrections. Then exact source review, final local evidence
acceptance, exact final HEAD required green CI and supplemental acceptance precede protected merge.
Verify actual parents/tree/all PR and concurrent-main paths, then a fresh isolated successor's
actual native UUID, durable routing and preserved execution acknowledgement. Clean pushed tree;
stop owned resources. All runtime/installed-provenance/Node24/128MiB/TigerVNC/fixed lifecycle/
owner HTTPS/WSS/chat/API-leases/Fence/independent-live gates remain in the inherited dispatch.
