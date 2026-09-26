# Email refresh completion contract

**Status:** Proposed addendum; coordinator review pending. Do not build this contract until the
coordinator records approval.

**Parent design:** [Morning briefing and plan review](2026-09-10-morning-briefing-flow.md),
approved and locked September 10, 2026.

**Build issue:** [#2709 — Email refresh completion contract for morning briefing](https://github.com/motioneso/moss/issues/2709).

**Related design decision:** Ben approved the pictured P9 degraded-briefing treatment on
September 25 in [the #2521 discussion](https://github.com/motioneso/moss/issues/2521). That ruling
settles the reader-shell, schedule, plan-action, delayed-email, and unavailable-report treatment.
This addendum specifies the connector API and durable completion signal behind its existing
**Refresh email** action; it adds no screen or visual decision.

## Purpose and boundary

The approved flow says Refresh demonstrates recovery from delayed email, but the reference uses a
simulated refresh. The production path needs to report when message ingestion has actually finished
before the reader asks for another morning briefing run.

This addendum defines an owner-scoped Google and IMAP email refresh request, durable status, and the
handoff condition for the already approved CTA. It does not add OAuth, calendar refresh, a mailbox
client, a new briefing-run API, or new visual states. It preserves the existing scheduled Google
and IMAP sync behavior.

## API contract

### Request

```http
POST /api/connectors/email-refresh
Content-Type: application/json

{"idempotencyKey":"<client-generated UUID>"}
```

The route derives the actor only from the authenticated `AccessContext`. The body accepts no actor
ID, account ID, provider, scope, or account list. The key is generated once for one refresh intent
and reused for HTTP retries. A later intentional refresh uses a new key.

The service selects the actor's current connector accounts in one owner-scoped snapshot. It queues
only accounts that are active and email-enabled: Google requires an active account with a Gmail
read scope and an enabled email feature grant; IMAP requires an active account and an enabled email
feature grant. Ineligible accounts are not included in the result. If no account is eligible, the
service persists a terminal `failed` attempt with `no-eligible-accounts`, queues no provider work,
and the client keeps the existing briefing.

### Accepted response

```json
{
  "refreshId": "<stable UUID>",
  "enqueued": true,
  "deduped": false
}
```

The route returns `202` for the request whether provider work was newly queued or coalesced with an
existing attempt. `enqueued` is true only when this request created provider jobs. `deduped` is true
when the same owner/key already identifies an attempt or an active owner refresh was coalesced.
Neither field means that email is current. The status resource is authoritative.

For a retry with a previously used idempotency key, return its original `refreshId` even after that
attempt reaches a terminal state. Concurrent refresh requests for the same actor join the active
attempt rather than creating another parent attempt. A new explicit refresh after the active attempt
is terminal gets a new ID when sent with a new key.

### Status read

```http
GET /api/connectors/email-refresh/:refreshId
```

The owner-only response is bounded to the refresh and per-account metadata:

```json
{
  "refreshId": "<stable UUID>",
  "status": "running",
  "createdAt": "<ISO timestamp>",
  "startedAt": "<ISO timestamp or null>",
  "completedAt": null,
  "accounts": [
    {
      "accountId": "<owner-scoped UUID>",
      "providerType": "google",
      "status": "running",
      "startedAt": "<ISO timestamp or null>",
      "completedAt": null,
      "counts": { "emailUpserted": 0, "emailFailures": 0 },
      "errorCode": null
    }
  ],
  "errorCode": null
}
```

`accounts` contains one entry for every account selected when the request was created. Counts are
aggregate-only. Timestamps are UTC ISO strings. A missing refresh ID and a refresh owned by another
actor both return the same not-found response. The route verifies ownership of the parent and every
included account under the authenticated actor's normal data context.

The response never includes subjects, snippets, message IDs, provider text, credentials, raw errors,
or other actors' accounts. `errorCode` is limited to `no-eligible-accounts`, `no-active-connection`,
`auth-error`, `email-error`, `email-message-error`, `email-needs-config`, and `enqueue-failed`; it
never contains provider output. The public status values are `queued`, `running`, `succeeded`,
`partial`, and `failed`.

## Durable attempt model

Add connector-owned SQL tables in a new migration; do not edit an applied migration or store this
state only on `connector_accounts` or in pg-boss rows.

- A refresh parent records its stable ID, owner ID, aggregate status, bounded error code, and
  creation/start/completion timestamps. A unique partial constraint permits at most one active
  refresh per actor.
- An idempotency-key row maps each `(owner_user_id, idempotency_key)` to its refresh ID. When a
  different request key coalesces with an active attempt, persist that key as another alias to the
  same ID so a retry after completion still resolves to the same attempt.
- One child row per selected connector account records the refresh ID, account ID/provider type,
  status, dispatch state, bounded aggregate counts/error code, and start/completion timestamps.
- Owner RLS protects parent and child reads and writes. Workers update rows only after entering
  `withDataContext(toAccessContext(job), ...)`. Database constraints prevent duplicate child rows
  for one refresh/account pair and preserve the owner relationship to each account.
- The records outlive pg-boss job retention. Completed-job cleanup must not delete refresh rows.
  Terminal rows contain only metadata and aggregate counts.

Persist the parent and child rows before queueing provider work. The child rows are also the durable
dispatch outbox: a row stays pending until its per-account job is accepted or found already queued
under its deterministic `refreshId`/account singleton key. A dispatcher retries pending rows after
process restart; if sending succeeds but recording dispatch completion fails, the same singleton
key prevents a second live job. After bounded enqueue retries, persist `enqueue-failed` as that
account's terminal outcome.

The job carries only the actor ID, account ID, manual trigger, and refresh ID in the already allowed
metadata-only `idempotencyKey` field. Its queue singleton key combines the refresh and account IDs.
The client request's idempotency key is separately mapped to the refresh ID in the durable request
key table. Do not put messages, credentials, mailbox configuration, or raw provider errors in a job
payload.

### State aggregation

Each account moves from `queued` to `running` and then to one terminal state. Map the existing
connector sync result `success` to refresh `succeeded`; preserve `partial` and `failed`.

- The parent is `queued` before any account worker starts and `running` once any account is running.
- It becomes terminal only after every selected account is terminal.
- All account results `succeeded` yields parent `succeeded`.
- All account results `failed` yields parent `failed`.
- Any `partial` account result, or a mix of successful/partial and failed account results, yields
  parent `partial`.
- A request with no eligible accounts is a persisted terminal `failed` attempt with
  `no-eligible-accounts` and an empty `accounts` array.

Only `succeeded` and `partial` authorize the consumer to request a new briefing run. `failed`
retains the previous report and plan choices. In particular, the client must never interpret
`202`, `enqueued`, a running job, or a recent account-level sync timestamp as completion.

## Provider work to reuse

The existing Google sync worker starts with calendar when calendar is enabled, then runs the email
phases. The email-only refresh must select the Gmail/email phase directly and skip calendar reads,
writes, reconciliation, and calendar freshness updates. Reuse the existing Google email fetch,
extract, persist, and action-projection path rather than creating a second email sync
implementation. Keep scope and feature-grant checks in the owner-scoped path.

IMAP already has a message sync worker used by its schedule. Reuse that worker and `runImapSync`
for the manual trigger, carrying the refresh ID as metadata so the worker can record the matching
account outcome. Do not change the recurring schedule or create a parallel IMAP ingestion path.

The account list is a snapshot for this refresh. If an account is revoked or no longer active by
the time its job runs, record a bounded failed outcome for that account. Do not make a credential
available to the route or put it on the job.

## Briefing handoff

The P9 reader waits on the status resource until all targeted accounts are terminal. On
`succeeded` or `partial`, it starts one run through the existing
`POST /api/briefings/definitions/:id/run` path, sends `refreshId` as that run's idempotency key, and
polls the `runId` returned by the accepted request. The run starts only after the connector workers
have recorded completion, so the new report reads the post-ingestion source state. Retries reuse
the same refresh ID as the briefing idempotency key; they never generate another key for that
refresh.

The existing manual-run route deduplicates the briefing job for a repeated idempotency key, but a
duplicate in-flight request returns `409 RUN_IN_FLIGHT_CODE` without the original `runId`. The
reader must retain the first accepted `runId` and must not start a second run after that conflict.
If P9 must recover the run ID after a lost `202` response or a reader reload, that needs a separate
briefings API contract; this connector addendum does not claim to solve it.

The connector implementation owns the durable email-refresh contract and connector manifest
declaration. The P9 reader implementation owns the CTA, pending/partial/failure copy, and Today
app-map declaration. Both slices are required before the approved CTA is considered wired and
verified.

## Verification required before release

- Unit tests cover request parsing, safe response serialization, aggregate state transitions, and
  metadata-only provider job payloads.
- Protected database proof covers durable status after pg-boss job cleanup, owner isolation,
  feature-grant/account eligibility, per-account outcomes, and concurrent request/job deduplication.
- Google integration proof demonstrates that email refresh does not write or reconcile calendar
  data; scheduled Google sync still follows its existing calendar and email phases.
- IMAP integration proof exercises the existing worker as a manual trigger and verifies the
  scheduled path remains unchanged.
- The P9 reader tests prove it waits for terminal refresh status, starts at most one briefing run
  for one refresh ID, selects that run when ready, preserves the previous report and plan choices
  on total failure, and retains the post-refresh source timestamp.
- Before either product slice is considered done, record a live UI proof from the real refresh
  action through terminal connector status to the selected new briefing run. Use executable
  assertions and bounded text evidence for the path.
