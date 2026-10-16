# Scheduled Tasks checks: one shared recovery and truthful interruption handling

2026-10-16. Canonical behavior contract for [admission task #3530](https://github.com/motioneso/moss/issues/3530) and [required bookkeeping/cutover task #3531](https://github.com/motioneso/moss/issues/3531). This document specifies intended behavior; it does not report implemented, deployed or accepted behavior. Canonical-document correspondence review precedes builder assignment.

Implementation proceeds through two serial plans: [A: admission](../plans/2026-10-16-r06-retry-admission.md), then [B: bookkeeping and cutover](../plans/2026-10-16-r06-retry-bookkeeping-cutover.md). A is a nondeployable prerequisite. Both slices, independent implementation review and required live proof belong in one final product PR; A must not merge or deploy alone.

## Problem and scope

One-time and recurring scheduled Tasks checks currently rely on queue retry metadata, which does not durably bound executions across restart or re-enqueue. An interrupted last execution can also leave an occurrence without its final failure/history/cadence effects. Existing pending occurrences have no complete historical attempt ledger, so upgrade cannot safely assume that they have never run.

Add a local durable admission and recovery protocol to scheduled reads. Ordinary reminders, baseline/unchanged/hash comparison, current source authority checks, failure thresholds, owner controls and existing cadence/downtime policy retain their behavior. This is not a global provider budget, general scheduler, workflow engine, replay UI or new user setting.

Technical correspondence was examined at source object `966527c413adc752def72f45ce0c54e660ca0615`. Documentation is based on main `70562d7df460737497124bf83c27849025ef372c`; the queue adapters, reminder transactional enqueue and locked pg-boss version match the fixed source. Builders must recheck correspondence against their exact base before code. Paths are relative to `~/Jarv1s`.

## Identity, allowance and observability

The occurrence allowance key is `(owner, reminder ID, reservedMessageId)`. Lifecycle version fences authority and never resets the allowance. A new queue job ID, retryCount=0, edit, pause/resume, restart or redelivery retains the same consumed allowance while reserved identity remains the same. Only genuine recurrence advancement creates a new identity with a fresh allowance.

A newly governed occurrence admits initial execution ordinal 1 and at most one shared recovery ordinal 2. Admission persists before source/model I/O. Uncertain admitted work is never refunded. Queue retry, explicit recovery job and other already-permitted deliveries compete for the same ordinal 2; a recovery job receipt does not reserve a separate allowance for that job. A wrong or obsolete identity cannot initialize a new allowance.

Keep separate counters for physical execution-handler invocations, watchdog invocations, admitted executions, Tasks gateway calls, generator calls, explicit recovery enqueues, watchdog successor enqueues, history rows, streak increments, messages, notifications and next-occurrence enqueues. Stable message/result identity alone does not establish bounded work.

At the inspected worker seams, two admissions imply at most four Tasks gateway calls and at most two report-generator calls, including discarded generation after validation-read failure. A valid second execution can make gateway calls 3/4. Deny execution admission 3 and generator call 3; do not deny gateway call 3 merely because it is third. These counts establish no upstream HTTP/provider/token/cost/whole-turn/time/concurrency cap. Activity rows are an incomplete denominator.

## Local ledger and authority

Extend `chat_scheduled_reads` with:

| Field                                                      | Meaning                                                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `attempt_message_id`                                       | Current governed or quarantined reserved occurrence identity                                                |
| `attempt_count`                                            | Persisted governed admissions, constrained to 0..2; legacy count 0 is not historical zero                   |
| `attempt_state`                                            | Closed vocabulary: `ready`, `running`, `retry_pending`, `bookkeeping_pending`, `legacy_unknown`, `terminal` |
| `attempt_token`                                            | UUID authority for the current admitted execution, nullable when inactive                                   |
| `attempt_version`                                          | Lifecycle version admitted under that token                                                                 |
| `attempt_lease_until`                                      | DB-clock validity deadline for that token                                                                   |
| `recovery_job_id`                                          | Actual durable queue-job ID for the one explicit recovery dispatch, nullable until assigned                 |
| `watchdog_token`, `watchdog_generation`, `watchdog_job_id` | Current local watchdog receipt: token, monotonically advancing wake generation and actual durable job ID    |

Use a new forward module migration, closed state/column-shape constraints, narrow worker-only mutation grants and existing owner RLS. Application INSERT may initialize only ready/null/count 0 state; it cannot forge count, execution authority or receipts. A ready row may bind its current reserved identity only under the locked admission gate. All worker operations use the actor's `DataContextDb` and existing reminder lock; no runtime admin/RLS bypass.

A committed `retry_pending` row has count 1, no active execution token/lease, and non-null `recovery_job_id`. Fresh governed identities have no recovery receipt. Once assigned, retain that receipt through ordinal 2 and terminal completion of the same identity; clear it only for a genuinely new identity. A running row has its admitted identity/count/token/version/lease and matching watchdog receipt. Terminal state retains consumed count/provenance; no transition replenishes uncertain allowance. Legacy state must remain distinguishable from measured ready/count 0 until retirement.

## Admission, renewal and fences

Under the reminder lock, check actor/source attachment, current reserved identity/version, queued lifecycle, due time and deadline. A matching valid running lease returns in-flight without count/token/outcome mutation. An eligible ready occurrence can admit ordinal 1; an eligible retry_pending occurrence or authoritatively invalid/expired ordinal 1 can admit ordinal 2 through the ordinary worker gate. Direct eligible delivery that wins ordinal 2 before recovery dispatch needs no explicit recovery enqueue. Count 2 and legacy_unknown never admit execution.

Admission atomically increments the count once, installs token/admitted-version/lease and enqueues its delayed bookkeeping watchdog with the current receipt. Use `sendJob(..., { db: scopedJobDatabase(db), startAfter: ... })` inside the same transaction and persist the actual non-null returned job ID. Commit before I/O. Failed send, null/suppressed send or commit failure permits no admission and no source/generator call. A null send can count only if the exact already-persisted same job is positively identified in that transaction; guessed IDs are insufficient.

Use DB time, a 90-second lease and renewal every 20 seconds. Renewal is a short compare-and-set matching owner/identity/token/ordinal/admitted-version/current version and requiring the previous lease to remain unexpired. It cannot revive an expired token. Stop renewal in `finally` on every worker exit. These are scheduling constants, not a whole-job deadline: valid renewal may continue while I/O is pending.

At each existing lifecycle recheck, before every new source/generator dispatch and during final persistence, require the current matching unexpired token/identity/ordinal/version. A late invalid response cannot dispatch more work, update observation/hash, append history, post a message or affect streak/cadence. Cancellation is best effort; persisted validity is authoritative. No DB transaction stays open across external I/O. A denied duplicate/third admission cannot replace, revoke or cancel an active valid ordinal 2. Lease expiry proves loss of local authority, not process death, upstream cancellation or provider settlement.

## One recovery-dispatch transition

One local owner-scoped transition under the reminder lock owns explicit recovery dispatch. Both an eligible recognized transient ordinal 1 source failure and recovery of abandoned/invalid/expired ordinal 1 call this same transition. There are no independent enqueue paths. Current identity, lifecycle, due/deadline and version rules still apply; valid ordinal 2, count 2, legacy_unknown and terminal state cannot enter it.

In one transaction, enqueue one ordinary scheduled-read recovery job, obtain its actual durable job ID, retain count 1, enter retry_pending, invalidate the old execution token/lease and persist `recovery_job_id`. Queue acceptance, receipt and state commit together. Use the existing transaction adapter and metadata-only payload; there is no send-after-commit gap. Failed enqueue/receipt write/invalidation/commit leaves the preceding committed state, count 1 and prior watchdog unchanged. Stop the old worker's renewal on exit; its unrenewed lease eventually expires.

Recognized eligible transient ordinal 1 failure commits this transition before returning or throwing to queue machinery. Retain source queue retryLimit 1 and existing failure classification/queue-metadata eligibility. Missing/invalid retry metadata uses the existing terminal-failure path. Report failure/refusal gains no new retry reason. Ordinal 2 failure uses existing terminal completion. Correctness does not depend on automatic pg-boss retry arriving: it and the explicit job compete for ordinal 2. A committed dispatch survives process death before queue acknowledgment. If a recognized-failure outcome/dispatch transaction rolls back, the consumed admission and prior watchdog remain available for recovery.

## Bookkeeping queue and watchdog receipts

Add `chat.scheduled-read-bookkeeping`, retryLimit 1, with the owning queue's retention/deletion policy. Register it even when execution/report provider dependencies are unavailable. Its dependencies are DataContextRunner, boss and existing notification/completion dependencies; its handler has no Tasks gateway, report generator or AI adapter.

Execution watchdog payload contains `actorUserId`, `resourceId`, `version`, `idempotencyKey=reservedMessageId`, `operationId=attempt token` and `step=wake generation`. `step` is an existing permitted metadata key; validate it locally as a small nonnegative integer. No shared jobs whitelist change is needed. Legacy seed wakes omit operationId and are accepted only against the exact legacy_unknown identity and their current seed receipt. Persist actual seed job receipts so bounded seed reruns cannot duplicate committed work; the same local watchdog slot may carry the legacy receipt with no execution token.

Every wake locks/reloads the owner-scoped row. Require the current identity and receipt token/generation/job ID for expiry/successor processing. A stale identity/token/generation, terminal row or old ordinal 1 receipt after ordinal 2 is a no-op. Cleanup may inspect the same identity's current control version; an old payload version never grants result authority or restores old controls.

An early wake with a still-valid matching lease atomically enqueues exactly one successor at the persisted lease expiry and replaces the receipt with generation+1 and its actual job ID. Duplicate old generation then does nothing, even when the token and renewed expiry are unchanged. Heartbeats only renew the lease; they do not enqueue watchdogs. Failed successor send/commit leaves the old receipt unchanged. Ordinal 2 installs its own token/receipt with a later generation so old wakes cannot displace it.

An eligible abandoned ordinal 1 with no recovery receipt invokes the shared dispatch transition. A retry_pending row with its receipt does not enqueue again. An expired/invalid ordinal 2 goes only to bookkeeping completion. Support recovery uses these same persisted gates, with no separate allowance or resend mechanism.

## Bookkeeping-only completion and controls

Under the current owner/reminder lock and exact occurrence identity, prove no currently valid matching execution lease exists. Enter bookkeeping_pending and fence old authority in the same transaction as final effects. Use current lifecycle/version and the shared existing finalization behavior:

| Current lifecycle/timing                     | Required disposition                                                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queued and due, within deadline              | Failed outcome; one failure-streak increment; one failed recurring history/result effect and one cadence advancement/next enqueue as applicable                                    |
| One-time queued and due                      | Failed source outcome and existing one-time failed-result path; no invented report generation                                                                                      |
| Future due                                   | Defer/schedule bookkeeping until saved due; no early failure or cadence advancement                                                                                                |
| Paused                                       | Preserve pause and consumed/unknown allowance; no message, history, advancement or automatic resume. Normal owner resume re-enters the gate with the same identity/current version |
| Queued and deadline passed                   | Existing expired/no-message behavior; end schedule without invented source failure or failure-streak increment                                                                     |
| Paused and deadline passed                   | Stay paused until normal owner control; resume then applies current expiration check                                                                                               |
| Terminal/cancelled/deleted or newer identity | No resurrection, result or continuation; deletion cascades state                                                                                                                   |

Retain the existing third-consecutive-failure guidance/notification policy. Add neutral static interruption and unknown-state messages. Do not say that a source read failed, a retry occurred or a report was generated when the fact is unknown. Bookkeeping makes zero source/generator calls and does not probe source access. Rollback leaves no partial history/streak/message/cadence/enqueue/terminal effects; retry is idempotent. Controls and current locking decide races; cleanup cannot undo pause/delete or a newer occurrence.

A committed ordinal 2 followed by crash or finalization rollback is a required recovery case. So is recognized first source failure followed by an interrupted final admission. Neither is excluded as a multiple-fault scenario. A valid ordinal 2 duplicate remains in-flight; cleanup waits for invalidity/expiry rather than inferring abandonment from count 2.

## Finite infrastructure boundary

Recovery can complete once a due watchdog can run and commit against available DB/queue infrastructure. Finite retries do not promise delivery during indefinite outage or explicit queue deletion. Exhausted bookkeeping is a visible technical failure and supports bounded owner/occurrence recovery through the same bookkeeping interface after infrastructure restoration.

If recovery delivery is positively established as exhausted without ordinal 2 admission, bounded provider-independent recovery may retire that interrupted occurrence under the same truthful controls. Absence of an acknowledgment or an unexpired lease is not proof of exhaustion. Never erase a receipt, refill allowance or silently enqueue another execution. Healthy delivery of the committed recovery job suffices for the missing-automatic-retry case. No global scanner, unlimited resend or provider-dependent recovery is selected.

## Legacy quarantine and operational cutover

The forward migration marks the exact current reserved identity of every existing queued or paused scheduled read `legacy_unknown`, with no new execution allowance. Preserve state, terms, due/deadline, version, reserved ID, source snapshot/hash and failure streak. It neither appends history nor rotates identity. Governed count 0 records no governed admissions and says nothing about historical calls. Terminal/deleted rows remain inert. No pre-upgrade lifetime cap is claimed.

Apply the controls table above to legacy rows: due queued identities retire as truthful bookkeeping failure; future queued identities wait until saved due; paused identities remain paused until owner resume; queued expired identities use existing expiration; terminal/deleted identities do nothing. Unknown retirement performs no source/report I/O and never updates the preserved source hash. Only genuine recurring advancement produces a new governed identity. A one-time legacy check receives no automatic replacement schedule; normal owner chat controls remain available.

The operational procedure is separately scheduled by the coordinator, never run merely to implement this contract:

1. Freeze scheduled-read writes/producers and stop all old API/worker executors and their restart controllers. Verify process exit plus closure of their DB sessions/transactions with bounded version/process/session witnesses. Queue pause alone is insufficient. If any old executor can continue, stop before migration/new execution.
2. Apply the new forward module migration while old executors remain absent. The migration role performs schema/backfill; runtime operations still use worker credentials and per-actor DataContextDb/RLS. Old jobs may retain retryLimit 2 metadata; the new admission gate remains authoritative.
3. Keep regular execution disabled while a bounded seed consumes an exact finite actor/reminder/expected-occurrence manifest. Schedule legacy queued bookkeeping at max(DB now, saved due); defer paused rows. Persist exact job and seed receipts, including deferred/terminal/failed counts, so only unfinished work is retried. Read metadata only, never Tasks/source content/model data.
4. Start only new-version normal/bookkeeping composition after seed completion. Verify queue definitions, recovery registration and continued absence of old processes/controllers. Stop on source/schema/ownership mismatch or missing seed. Old-version rollback against the ledger is unsafe: stop executors and require a separately reviewed data/protocol strategy.
5. Qualify legacy due/future/paused/expired/terminal and fresh post-cutover fixtures before rollout. Keep historical unknown separate from measured new counts. Local process/session quiescence does not prove upstream settlement; that evidence remains separate.

The supported adapter is `scripts/recover-scheduled-read-occurrences.ts`, with seed/recover modes, exact finite metadata manifest, bounded count, expected identities and a fail-on-partial receipt. Use the worker DB role and a DataContextDb per actor. It calls module-owned seed/recovery interfaces, with no Tasks/AI imports, private-content enumeration, arbitrary actor grant or unauthenticated endpoint. Executing it is deployment/recovery work outside builder verification.

## Required agreement witnesses

Exercise ordinary `runScheduledReadJob` / `registerScheduledReadWorker` plus local `runScheduledReadBookkeepingJob` / `registerScheduledReadBookkeepingWorker` against real owner-scoped persisted-state fixtures and deterministic external adapters. Test clock/lease fixtures and barriers replace wall-clock sleeps. Fake repository returns do not prove persistence, transactionality, grants or RLS.

The decisive recovery test must:

1. Admit ordinal 1 and its watchdog, then produce an eligible recognized transient source failure. Commit explicit recovery dispatch and suppress automatic retry entirely.
2. Read real rows: count 1, retry_pending, invalid old authority and one actual recovery job identified by its receipt. Deliver the old watchdog twice; no new recovery enqueue or receipt/count change.
3. Deliver the explicit job and hold valid ordinal 2 at a barrier. Replay that job, ordinary retry and old wakes. Total admissions remain 2; ordinal 2 token/lease remains valid and unchanged; no execution 3; one explicit recovery enqueue.
4. Complete ordinal 2 with supported terminal source failure. Observe exactly one applicable failed result/history/streak/cadence/next enqueue. Replay after completion/advance; no extra effects.

Required variants: fail after send but before receipt/state commit, proving no job/receipt/pending commit and then one successful original-watchdog dispatch; dispatch commit followed by process death before acknowledgment; renew lease then deliver the same current watchdog generation twice early, proving one successor receipt/job. Also cover admission/watchdog rollback, final-admission crash/finalization rollback, active-final-token duplicates, late ordinal 1 responses/renewals, paused/future/deadline/terminal races, source refusal/revocation, unchanged/baseline/two-change behavior, real migration legacy matrix, seed idempotency, app INSERT/grants and cross-owner denial.

Negative controls must fail when removing each protection: durable admission bound, token/lease finalization fence, active-lease cleanup guard, transactional admission watchdog, transactional recovery enqueue, receipt/generation comparison. Restore each protection before further verification. Finalization rollback must leave one eventual whole completion transaction, never a fake terminal run.

## Acceptance limits and retained evidence

Canonical documentation and deterministic adapter tests do not establish a live protocol. Required verify-gate skill and isolated fixture setup precede all DB/foundation commands; absent skill is a finite blocker. The coordinator serializes gates/runtime work with other active validation.

Original R06-P1/P2 daily-loop/source-authority dependencies, exact routine binding, preview/provider/context/available-usage correspondence, two changed live runs, quiet/stop/revocation and truthful installed source/artifact evidence remain required. Preserve N1 total-call/time/transport/async/fault/evidence/teardown and provider settlement holds. Same-DB shutdown is not an independent Tasks-source transient. No new provider selection/configuration or later-stage work follows from this contract. Existing Stage3/Q05/T0 and deferred proof states remain unchanged; Stage4 remains NOT_ACCEPTED until its separate acceptance conditions are met.
