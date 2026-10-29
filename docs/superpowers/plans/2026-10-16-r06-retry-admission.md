# R06 slice A: persist admission, leases and dispatch receipts

2026-10-16. Build against [task #3530](https://github.com/motioneso/moss/issues/3530) and the [canonical behavior spec](../specs/2026-10-16-r06-scheduled-read-retry-bound.md), which is the behavior authority. This plan is implementation work, not a record of checks passing. Canonical-document correspondence review must finish before builder assignment.

**Nondeployable prerequisite.** A must not merge/deploy alone or satisfy original R06. Freeze and independently review A's exact commit, then hand its shared paths to [required slice B / #3531](2026-10-16-r06-retry-bookkeeping-cutover.md). Deliver one final product PR after B, verification and live proof. Builders run serially; no overlapping schema/runner ownership.

## Ownership and preflight

Paths below are relative to `~/Jarv1s`. A owns exactly:

- `packages/chat/sql/0324_chat_scheduled_read_attempts.sql` (prospective number; reserve/recheck before code)
- `packages/chat/src/manifest.ts`
- `packages/db/src/types.ts`
- `packages/chat/src/scheduled-reads/repository.ts`
- New `packages/chat/src/scheduled-reads/attempts.ts`
- `packages/chat/src/scheduled-reads/runner.ts`
- `packages/chat/src/scheduled-reads/queue.ts`
- `tests/unit/3138-scheduled-read-worker.test.ts`
- New `tests/integration/r06-scheduled-read-attempts.test.ts`

Other sessions own other paths. Do not revert their edits or expand this lease silently. If another owning path is necessary, name it and amend the lease before building. Do not modify applied migrations, shared jobs payload policy, provider configuration or ordinary reminders.

1. Read project AGENTS/CLAUDE and development standards on the exact build base. Confirm approved canonical docs/task links and no active overlap with B or other schema work. Record base/branch/worktree and scoped clean status in a small private work log. Completion: exact ownership and source correspondence are recorded.
2. Recheck main and open schema PRs for global migration-number collisions. Number 0324 was unused and maximum 0323 on the documentation base; this is not a future reservation. Reserve 0324 before editing, or rename only the prospective new migration and amend this exact lease before code. Completion: one unambiguous forward migration filename and manifest order.
3. Locate/read the required verify-gate skill before any DB/foundation command. If unavailable, record a finite verification blocker; never use the live dev DB as fallback. Coordinate an isolated DB fixture and serialized test window with the coordinator. Completion: documented test target/role/bootstrap and permission to use its isolated gate, or an explicit blocker.

## Build sequence

### 1. Persist the complete local shape

Implement the spec's identity/count/state/token/admitted-version/lease fields plus `recovery_job_id` and watchdog token/generation/job ID slot. Design all shape checks and grants before applying the migration. Backfill existing queued/paused identities as legacy_unknown while preserving their lifecycle/terms/hash/streak. Ready application inserts have only allowed null/count 0 defaults. Owner RLS remains authoritative; the worker alone mutates attempts/receipts.

Update module migration registration and generated DB types. Completion: isolated real migration tests prove legacy quarantine, allowed initial INSERT, denied forged attempt/receipt INSERT/UPDATE and cross-owner denial. A migration/schema edit is prospective until isolated verification; no deployed DB/cutover operation belongs to this slice.

### 2. Implement the one admission/lease module

`attempts.ts` owns locked admission, token validity, DB-clock renewal and transactional queue receipts. Admission checks the current actor/source/lifecycle/identity/version/due/deadline once before I/O, rather than counting every reused load/recheck. Rechecks validate the admitted token without incrementing again. Commit count/token/lease/watchdog together. Failed/null send or commit means zero I/O.

Renew 90-second validity every 20 seconds through unexpired compare-and-set; stop renewal in every worker exit's `finally`. A still-valid matching ordinal 2 duplicate leaves its authority untouched. A stale or expired token cannot renew or dispatch/persist further work. Use short transactions around state changes, never around external calls.

Define metadata-only bookkeeping queue/payload locally with retryLimit 1 and existing retention/deletion values; B supplies its handler/composition. Use existing payload keys, including `step` for validated wake generation and `operationId` for the attempt token. Preserve ordinary source queue classification and set its new retryLimit to 1. Completion: real persisted admission rollback and lease/late-response barrier tests pass, with separate invocation/admission/gateway/generator counters.

### 3. Implement shared transactional recovery dispatch

Both recognized eligible transient ordinal 1 failure and abandoned/invalid/expired ordinal 1 use one transition under the reminder lock. Within that transaction, `sendJob` with `db: scopedJobDatabase(db)` must return the actual durable recovery ID before count 1/retry_pending/old-token invalidation/receipt can commit. Null send aborts unless the exact persisted same job is positively identified in that transaction. Keep receipt through ordinal 2/terminal; reset only for a new identity.

Commit recognized-failure dispatch before returning/throwing. Automatic retry remains permitted and competes for ordinal 2; it is not the recovery guarantee. Direct eligible delivery that already wins ordinal 2 needs no extra dispatch. Preserve terminal behavior for invalid/missing queue metadata, report failure/refusal and ordinal 2 failure.

The current watchdog receipt makes initial admission/successor enqueue atomic: early wake requires token/generation/current job receipt, installs exactly generation+1 with the returned ID, and leaves duplicate old wakes inert. Heartbeat changes only the lease. Admission2 installs its own receipt. Completion: no reachable pending-without-receipt state; queue insertion and receipt/state roll back together; dispatch commit survives acknowledgment loss. B will drive these transitions through the composed handler.

### 4. Fence the existing execution flow

Integrate admitted authority at existing lifecycle checks, before each gateway/generator call and final persistence. An obsolete result cannot update observation/hash/history/message/streak/cadence. Finalization rollback retains consumed admission and persisted watchdog for B's recovery. Do not introduce another report retry or release/reset allowance on cancellation.

Completion: preserve baseline/unchanged/current-source outcomes and original tests; admission 3 and generator call 3 are denied, while gateway calls 3/4 within valid execution 2 remain allowed. Physical handler/watchdog invocations are counted separately. No upstream provider/time/token/cost bound is claimed.

## Required verification and handover

Use real owner-scoped DB state and deterministic source/generator barriers; no real-time sleeps or mocked repository substitute for transaction/RLS claims. A's tests cover newly governed identities, retry metadata reset/re-enqueue, active ordinal 2 duplicate, late ordinal 1 response/renewal, controls/version reuse, lease expiry, admission/watchdog-send rollback, recovery receipt retention/rollback and finalization rollback prerequisites. B owns final composed watchdog/cutover agreement tests.

Observe baseline red for third admission and persistence/fence failures through the ordinary worker interface. Negative controls remove durable count, token/lease finalization guard, active-lease cleanup guard, transactional admission watchdog, transactional recovery enqueue and receipt/generation comparison, each making its relevant test fail. Where the complete witness requires B's handler, record the exact pending B test; do not claim it passed in A. Restore each control before continuing.

Run scoped ESLint/Prettier using repository commands, root `timeout 120s pnpm exec tsc --noEmit --incremental false -p tsconfig.json`, relevant unit tests and isolated migration/owner/RLS/integration tests under verify-gate. Record raw exit codes, exact tests and bounded evidence. Two identical failures require diagnosis before another attempt. The coordinator schedules the final full gate without overlap with N3 runtime work; A does not run live faults, seed/recovery CLI or deployment.

Completion of A means a clean committed candidate, independently reviewed exact commit, migration reservation/schema/grant evidence, tests and remaining blockers recorded. Pass B the shared repository/runner/queue lease only after A freezes. B receives receipt/payload semantics, helper APIs, any pending composed negative controls and the exact commit; do not overlap edits. App-map, release/deployment notes and provider-independent completion remain mandatory B work before the unified PR can merge.

The existing queue adapter returns `Promise<string | null>` and routes `scopedJobDatabase` SQL through the caller's transaction. Static pg-boss 12.18.2 inspection shows `createJob` uses that wrapper, inserts with `RETURNING id` and returns actual ID/null. This supports the design; only real rollback/receipt tests establish the implementation witness. Matching dependency version alone is no lockfile integrity or runtime proof.

Original live UI/source/artifact/provider/usage/async/transport/fault/teardown evidence and R06 dependencies remain outstanding. A is never a runtime acceptance result or permission for later-stage work.
