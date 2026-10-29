# R06 slice B: finish interrupted checks and cut over unknown occurrences

2026-10-16. Build against [task #3531](https://github.com/motioneso/moss/issues/3531) and the [canonical behavior spec](../specs/2026-10-16-r06-scheduled-read-retry-bound.md), which is the behavior authority. This is a plan, not a verification/deployment result. Canonical-document correspondence review precedes builder assignment.

Start only after [slice A / #3530](2026-10-16-r06-retry-admission.md) is committed, independently reviewed and frozen. A alone must not merge or deploy. B completes the same original contract; deliver one final product PR after both slices, gate, review and required live proof. Work is serial, with explicit handover of shared paths.

## Ownership and entry criteria

Paths are relative to `~/Jarv1s`. B owns exactly:

- `packages/chat/src/scheduled-reads/repository.ts`, only after A's handover
- `packages/chat/src/scheduled-reads/runner.ts`, only after A's handover
- `packages/chat/src/scheduled-reads/queue.ts`, only after A's handover
- New `packages/chat/src/scheduled-reads/completion.ts`
- New `packages/chat/src/scheduled-reads/bookkeeping.ts`
- New `packages/chat/src/scheduled-reads/cutover.ts`
- `packages/chat/src/jobs.ts`
- `packages/chat/src/scheduled-reads/report.ts`
- `packages/chat/src/reminders/features.ts`
- New `tests/integration/r06-scheduled-read-recovery.test.ts`
- New `tests/integration/r06-scheduled-read-cutover.test.ts`
- `tests/integration/3138-repeating-scheduled-read.test.ts`
- `tests/integration/3151-scheduled-read.test.ts`
- New `tests/unit/r06-scheduled-read-bookkeeping.test.ts`
- New `scripts/recover-scheduled-read-occurrences.ts`
- New `tests/unit/r06-scheduled-read-recovery-cli.test.ts`

Other sessions own other paths; retain their edits and amend an exact necessary lease before expanding. Schema/manifest/types/attempts.ts remain A's frozen work; return any required correction through coordinated ownership rather than overlapping edits. No new provider configuration, ordinary reminder changes or shared jobs whitelist edit.

Before code, record A's exact commit and migration reservation, helper/payload/receipt contracts, test results and pending composed negative controls. Read AGENTS/CLAUDE, development standards and required verify-gate skill on the exact base. Locate isolated owner-scoped migration/queue fixtures and coordinator's serialized verification window. Missing verify-gate is a finite test blocker, never authority to use live DB. Completion: shared path handover and isolated gate target are explicit.

## Build sequence

### 1. Share truthful completion

Extract existing finalization into `completion.ts` and route ordinary and bookkeeping completion through it. Preserve current source/hash/baseline/unchanged behavior, one-time failure path, owner controls, recurring history, failure threshold/notification and cadence/downtime semantics. Bookkeeping first proves no valid matching execution authority under the reminder lock and fences it in the same transaction as final effects.

Add static interruption and unknown-history text in `report.ts`. It must not assert a failed source read, performed retry or generated report where unknown. Preserve failed rather than quiet/delivered outcome for due interrupted work. Paused, future, deadline-expired and terminal cases follow the spec table without synthetic queued state or history.

Completion: whole transaction rollback leaves no partial history/streak/message/advance/enqueue/terminal effect; retry produces one eventual completion. A valid ordinal 2 stays in-flight; final-admission crash/rollback can finish without another execution.

### 2. Compose the provider-independent bookkeeping worker

Expose local `runScheduledReadBookkeepingJob` / `registerScheduledReadBookkeepingWorker` and bounded `recoverScheduledReadOccurrence`. Dependencies include DataContextRunner/boss and existing completion/notification support, with no Tasks gateway, report generator or AI adapter. Register queue and handler in `jobs.ts` even when source/report providers are unavailable. Queue retryLimit 1 and retention/deletion match the spec.

Drive A's one shared recovery transition and current watchdog receipt. Expired eligible ordinal 1 with no recovery receipt dispatches once; retry_pending+receipt does not resend. Current early wake advances generation/actual job ID once; duplicate old generation and old ordinal 1 after ordinal 2 do nothing. Expired/invalid ordinal 2 reaches only shared bookkeeping completion. Current controls/identity always win; cleanup can use current control version without authorizing an old payload's execution.

Exhausted bookkeeping remains a visible technical failure. Bounded support recovery uses the same gates. Explicit recovery delivery may retire without ordinal 2 only after exhaustion is positively established; absent acknowledgment/unexpired lease does not establish it. No receipt erasure, allowance refill, silent execution resend or global scanner.

Completion: composed real-state tests prove zero source/generator dependencies/calls for bookkeeping, one terminal transaction and immunity of active ordinal 2 to duplicate/old wakes.

### 3. Implement bounded seed/recovery and the selected CLI

`cutover.ts` exposes `seedScheduledReadCutover` accepting exact actor/reminder/expected-occurrence metadata plus DataContextRunner/boss. Seed legacy queued rows at max(DB now, saved due); preserve paused/deadline/terminal dispositions. Persist actual seed job receipts and idempotent per-entry results so partial rerun touches only unfinished work. Do not enumerate private source content or make source/model calls.

The selected script `scripts/recover-scheduled-read-occurrences.ts` takes mode `seed` or `recover`, an exact finite metadata manifest, explicit invocation bound and expected identities. Use worker DB credentials with per-actor DataContextDb and the module operations. No Tasks/AI imports, raw privileged runtime bypass, arbitrary actor grants or public HTTP route. Reject malformed/oversized manifests, unknown mode and mismatched identities before effects. Emit a bounded metadata receipt with successful/deferred/terminal/failed entries and nonzero exit on partial failure; preserve completed receipts for safe continuation. Recovery mode cannot grant execution or refill allowance.

Completion: unit tests prove parsing, bounds, receipt/partial failure and no-provider dispatch; isolated integration tests prove actual seed persistence/idempotency and owner boundaries. Implement the command without executing it on real schedules. Deployment cutover remains a separate coordinator-owned operation.

### 4. Prove the recovery dispatch agreement

Use the spec's decisive real queue-row test: recognized transient ordinal 1, commit explicit recovery receipt, suppress automatic retry entirely, old watchdog twice, deliver explicit recovery, hold valid ordinal 2, replay duplicates/old wakes, release deterministic terminal failure. Assert one explicit recovery enqueue, two admissions, valid ordinal 2 untouched and one applicable result/history/streak/cadence/next enqueue.

Add the three required variants: send succeeds then state/receipt commit fails (no persisted job/pending/receipt, original watchdog later succeeds once); dispatch commit then process death before acknowledgment (same durable recovery); renewed lease and duplicate early watchdog generation (one successor receipt/job). Keep physical invocations, admissions, gateway/generator calls, recovery/successor jobs and final effects as independent counters.

Retain final-admission crash and finalization-rollback, recognized first failure followed by final interruption, active ordinal 2 duplicate, late ordinal 1 result/renewal, pause/resume/edit/future/deadline/terminal, source refusal/revocation and existing quiet/baseline/two-change coverage. Actual DB fixtures prove grants/RLS and migration policy; deterministic clock/ledger fixtures and barriers avoid sleeps.

Completion: all required protection-removal negative controls fail, including transactional recovery enqueue and receipt/generation comparison, plus A's count/token/active-lease/admission-watchdog controls. Restore each protection. Neither fake repository return values nor fabricated terminal history count as agreement.

### 5. Prove the conservative upgrade and prepare rollout instructions

Build legacy fixtures with the pre-migration schema and apply A's new migration in isolation. A null historical outcome, future due time or absence of runs must not yield fresh allowance. Prove the complete due/future/paused/deadline/terminal matrix, preserved terms/version/identity/hash/streak, seed partial retry and new governed identity only after genuine recurrence advancement. One-time unknown occurrence has no automatic replacement.

Prepare the final product PR's deployment instructions from the canonical cutover sequence: freeze all old writers/producers, stop old API/workers/controllers, verify process and DB session/transaction quiescence, migrate while absent, bounded owner-scoped seed before new execution, start only new composition and qualify the matrix. Document unsafe old-version rollback and stop-on-missing-seed/source/schema/ownership mismatch. Process exit is not upstream cancellation evidence. Do not stop shared processes, migrate installed data, seed queues or change rollout/provider settings during implementation.

Update `reminders/features.ts` through the owning app map in the same product PR for shared recovery, interrupted bookkeeping, pause/cadence preservation and conservative legacy retirement. No new screen/setting is selected. Include the skipped unknown current occurrence impact in reviewed release/deployment notes. Draft release note: Fixed; “Task check recovery”; “Scheduled task checks share one recovery attempt and record interrupted checks without running them again.” Completion: app-map assertions and deployment/release notes match the exact final behavior.

## Verification, final review and retained holds

Run scoped ESLint/Prettier using repo commands, root `timeout 120s pnpm exec tsc --noEmit --incremental false -p tsconfig.json`, relevant unit/CLI tests and real isolated owner/RLS/migration/queue integration tests under verify-gate. Record raw exit codes and bounded evidence. Two identical failures require diagnosis. The coordinator serializes the final full gate with N3/runtime activity; do not run overlapping acceptance/fault work.

Freeze the final exact commit for independent review of both slices together, including migration/grants, transaction/receipt semantics, handler registration without providers, CLI bounds, app map and preserved behavior. A green gate/review is code-complete verification only. Required live UI/installed source/provider/fault/restart/history/control evidence must be recorded on the unified product PR before merge or Done. Coordinator owns that scheduling and execution.

No tests in this plan establish upstream HTTP/token/cost/whole-turn/time/concurrency enforcement or complete activity usage. Original R06 daily-loop/source-authority/routine/preview/provider/context/available-usage dependencies, two changed live runs, quiet/stop/revocation and N1 transport/async/fault/evidence/teardown/provider settlement holds remain. Same-DB shutdown is not an independent Tasks-source transient. Stage4 remains NOT_ACCEPTED until its separate acceptance conditions pass; no later-stage/Moss Computer work is authorized by completing this slice.
