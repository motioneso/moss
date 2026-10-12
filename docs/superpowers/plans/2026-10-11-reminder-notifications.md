# Reminder notifications (#3134)

Status: approved by the coordinator; implementation in progress.
Branch: scheduled/3134-reminder-notifications.
Base: integration/scheduled-proactive, inspected at 99b83b531.
Part of #3134. Sensitive delivery behavior; live proof required.

Approval conditions: keep lookups and deferral under normal per-user row security, with no
security-definer function or bypass. Keep urgent notification behavior unchanged and prove it
with a test. Describe every shared push behavior change in the PR. The existing shell has no URL
that opens Main chat or selects its reminder (apps/web/src/shell/app-shell.tsx:185); use /today and
declare that destination gap in the PR. The approved kill gate and stop condition below still apply.

## Outcome and limits

A due reminder remains readable immediately in Main chat and also signals through the existing
notification bell and enabled browser or phone push. Quiet hours hold outward delivery until the
saved local boundary. Current module mutes, sensitivity and device switches win. Notification
failure retries delivery only, without repeating the reminder or its chat message.

No new screen, settings key, task exception, source scanning or migration. Task-specific quiet-hours
allowances remain #3145. Settings task management remains #3133. Do not touch Settings screens or
chat request handling. Any discovered need for a migration goes to the coordinator before code.

## Verified seams and gaps

- Due reminder delivery already locks and checks owner, state, version, due time, deadline and Main
  identity: packages/chat/src/reminders/deliver.ts:74. It reserves one assistant message, marks the
  reminder delivered and signals live arrival in the same transaction: that file at line 104.
- Queued delivery currently stops there; no notification creation or enqueue follows live arrival.
- Reminder jobs are transactionally enqueued with actor and resource identifiers:
  packages/chat/src/reminders/deliver.ts:58. Job keys are allowlisted:
  packages/jobs/src/pg-boss.ts:101. The new job needs no new allowed keys.
- Owner cancellation and delivery share row locking. Delivered cancellation dismisses context;
  acknowledgement is a different state: packages/chat/src/reminders/cancel.ts:61 and
  packages/chat/src/reminders/repository.ts:259. Acknowledgement must not suppress a deferred alert.
- Notifications create through an actor-scoped public repository; module mutes are already checked:
  packages/notifications/src/repository.ts:249. Normal urgency already computes local quiet-hours
  deferral: that file at line 268. Its event key reuses a row but resurfaces it, so retry must first
  find an existing row, rather than repeatedly call create.
- Canonical quiet-hours resolution is already injected by
  packages/module-registry/src/built-in-module-helpers.ts:60. Preserve its unresolved legacy behavior;
  do not choose between conflicting preferences in this slice.
- Push jobs contain identifiers only and use the notification transaction. Deferred notifications
  share one summary job at the boundary: packages/jobs/src/push-jobs.ts:41 and
  packages/notifications/src/repository.ts:341.
- Push sends track delivered payloads per device and retry temporary failures after commit:
  packages/notifications/src/push-worker.ts:99 and line 206. Preserve this behavior.
- Current individual push delivery reads the notification and active devices, but does not recheck
  module mute, sensitivity, current quiet hours or source lifecycle: that file at line 277.
  Summary delivery counts an unread cohort without those checks: that file at line 337.
- Worker composition can inject owning-module public APIs without reverse imports:
  packages/module-registry/src/index.ts:2121 and line 2375. No notification-to-chat import is needed.
- The browser already displays real push through its service worker:
  apps/web/public/service-worker.js:109. No alternate notification display will be built.

## Implementation decisions

### 1. Separate reminder execution from notification creation

Files: packages/chat/src/reminders/deliver.ts, a new
packages/chat/src/reminders/notifications.ts, packages/chat/src/reminders/repository.ts,
packages/chat/src/jobs.ts, packages/chat/src/index.ts, packages/chat/package.json, pnpm-lock.yaml,
and packages/module-registry/src/index.ts.

- Add queue chat.notify-reminder with the existing bounded push retry policy. Its payload is
  actorUserId, resourceId, version and idempotencyKey. The key derives from the reserved result
  message identity; no reminder text enters the job.
- Enqueue it in the existing chat delivery transaction after the reserved message is stored.
  Queue failure rolls that transaction back. Notification creation and channel failure occur in
  separate jobs after chat commits, so neither can mark a delivered reminder failed or rerun it.
- Add the public handler runReminderNotificationJob(scopedDb, payload, notificationsRepository)
  and registerReminderNotificationWorker(boss, dataContext, notificationsRepository, workOptions?).
  Compose the repository with the existing quiet-hours, preferences and push queue ports.
- Re-read the owner-visible reminder and its reserved stored result at execution. Require delivered
  state, matching version and result identity, and context other than dismissed. Missing, cancelled,
  failed, expired, deleted or mismatched work sends nothing. An acknowledged result remains eligible.
- Serialize creation attempts with an actor/resource advisory transaction lock, then use a public
  notification lookup by module and event key. An existing row ends the job without rewriting the
  row, clearing its read mark or scheduling another push.
- Create module chat, title "Reminder from Moss", body from the persisted assistant result,
  normal urgency, and same-origin href /today. Metadata identifies kind, reminderId and messageId;
  eventKey is the reserved message identity. Do not let reminder wording set urgency or recipients.
- Add the owning-module public function isReminderNotificationActive(scopedDb, notification),
  returning true for unrelated notifications and checking the reminder/result for this kind.
  Notifications consume this through an injected callback, never by reading chat tables.

### 2. Recheck queued outward delivery through the existing push workers

Files: packages/notifications/src/repository.ts, packages/notifications/src/push-worker.ts,
packages/notifications/src/index.ts, and packages/module-registry/src/index.ts.

- Extend PushWorkerDependencies with the existing preference, quiet-hours and push queue ports,
  plus isNotificationActive(scopedDb, notification): Promise<boolean>. Production injects all
  ports and the public chat lifecycle function for both individual and summary workers.
- Both workers filter by current module enablement, sensitivity and source lifecycle before
  choosing devices. Device selection continues to use listActiveForDelivery. Keep send failures,
  per-device success markers and the after-commit retry outcome intact.
- Add public repository operations findByEventKey(scopedDb, moduleId, eventKey),
  listUnreadDeferred(scopedDb, releaseAt) and deferDelivery(scopedDb, notificationId, releaseAt).
  All use the existing actor-scoped context; lookup does not require the row to be visible yet.
- If a notification is now inside quiet hours, compute its new boundary with the existing
  computeDeferredUntil and resolveTimezone functions, move its deferred_until and enqueue the
  existing summary transactionally. Do not send early. On summary release, re-read and filter the
  exact unread cohort before counting it; a muted or dismissed reminder cannot count toward a push.
- Preserve existing urgent behavior for unrelated notifications. Reminders always use normal
  urgency. One eligible deferred reminder still uses the existing summary display at the boundary.
- Do not change the global meaning of event-key upserts. The reminder worker's lookup prevents
  retry from resurfacing an already-created notification.

### 3. Contracts, tests and proof

Files: packages/chat/src/manifest.ts, tests/integration/chat-reminder-notifications.test.ts,
tests/integration/chat-reminders-delivery.test.ts, tests/unit/push-worker.test.ts,
tests/uat/specs/3134-reminder-notifications.uat.spec.ts, and
.claude/skills/coordinate/uat-trigger-map.tsv. Update existing push integration tests if their
cohort expectations change. New public exports and the chat workspace dependency are included.

Add chat feature metadata describing enabled delivery, quiet-hours hold, cancellation and failure
recovery through existing notification controls. No screen or setting declarations are invented.

Behavior tests must prove:

1. One due run stores one chat result and queues only identifiers. Retry and concurrent notification
   workers create one notification and one delivery job; reading it then retrying preserves read state.
2. Notification creation failure leaves delivered chat intact; retry succeeds without another message.
3. Quiet-hours chat is readable immediately, its notification is deferred to the saved local boundary,
   and release produces one existing summary. Check a non-UTC zone and changed quiet hours before send.
4. Current module mute, sensitivity and inactive devices prevent sends, including changes after enqueue.
5. Cancellation before due, dismissal after chat delivery, missing result, stale version, deletion and
   another owner's payload cannot initiate delivery. Acknowledgement does not cancel a deferred alert.
6. Temporary push failure retries only the failed channel. Successful devices and the chat result are
   not repeated. Remove lifecycle and mute guards temporarily and observe their negative tests fail.

The UAT spec uses real UI requests, the installed worker and the existing service worker. It creates
reminders in Main chat, reads and replies to a quiet-hours result before release, and checks actual
notification rows and browser display, then repeats with Chat muted and a disabled device. No network
interception or fabricated responses. A real signed-in configured cheapest model answers a follow-up.

Claim a shared-range port with devports for sched-3134 and use an owned disposable install built from
this branch. Consult the local proof README without modifying or reusing the standing proof instance.
If authentic browser push or real-model sign-in cannot be demonstrated, disclose the missing evidence
and report code-complete, unverified; a notification row alone is not proof of browser delivery.

## Determinism, verification and stop condition

Reminder wording, saved state, notification identity and interruption decisions come from records
and deterministic application code. This slice adds no model job or prompt. The existing model only
answers ordinary chat and the proof follow-up; it does not decide delivery authority.

One implementation phase, including its live UAT, fits this slice. After the first working delivery,
the kill gate is that chat remains delivered through an injected notification failure and retry.
If it cannot, or completing the source lifecycle check requires new storage or a broader scheduler,
stop and ask the coordinator to re-slice before expanding scope. Coordinator owns that decision.

Verification commands are unpiped; expected exit is 0 for each:

- pnpm exec vitest run tests/unit/push-worker.test.ts
- scripts/run-gate.sh start --gate test:integration
- scripts/run-gate.sh wait --follow (one background wait; read its terminal exit code)
- scripts/run-gate.sh start, then one background scripts/run-gate.sh wait --follow for the full gate
- pnpm format:check; pnpm lint; pnpm typecheck; pnpm check:file-size (each checked separately)
- The live UAT runs through the disposable install's existing harness; record the exact invocation,
  exit code, notification identity, release boundary and bounded assertions on the PR.

Before push, fetch and rebase origin/integration/scheduled-proactive, never origin/main. Commit by
explicit path, push the branch and open the PR against integration/scheduled-proactive with
"Part of #3134" and Release note Category: N/A. Read CI, post live proof or its honest absence,
stop owned processes by PID, remove disposable artifacts, release the port, and report the PR to
the coordinator. No board, milestone, merge or docs/coordination changes.

Implementation evidence: the initial scoped gate passed 18 tests, including the kill gate. Later scoped
coverage passed 23 tests. Removing the source dismissal filter made two integration tests fail;
it was restored before the final gate. The gate runner accepts a script name, not command arguments;
scoped runs used a temporary local test script, removed before closeout.
