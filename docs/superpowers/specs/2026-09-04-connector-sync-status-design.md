# Connected accounts: sync status that explains itself

**Status:** Proposed design

**Date:** 2026-09-04

**Owner:** Ben

**Task issue:** [#2239](https://github.com/motioneso/moss/issues/2239)

**Related:** `packages/connectors` (sync jobs, schedules, repository), the Connected accounts
settings pane in `apps/web/src/settings/settings-personal-data-panes.tsx`, and the health
mapping in `apps/web/src/settings/settings-connector-sync.ts`.

## Context

Every connected account (Google, IMAP) is synced by a background job. Google runs every 15
minutes per user, IMAP every 15 minutes per account, and a sweep every 30 minutes re-queues
Google calendar accounts that fell behind. Each run writes one summary onto the account row:
when it started and finished, an overall status (`success`, `partial`, `failed`), one error code
(`auth-error`, `calendar-error`, `calendar-item-error`, `email-error`, `email-message-error`,
`no-active-connection`), and a small counts object (calendar events written, calendar events
reconciled, email messages written, email failures, escalations, whether the run was cut short).

The Connected accounts pane turns that into one badge and, sometimes, one alert line: Synced,
Syncing, Partial sync, Message cap reached, Sign-in expired, Connection error, Awaiting first
sync. Ben's words on 2026-09-04: "I see it all the time but the information isn't useful and
Moss doesn't know why either."

What is wrong with it today, all observed on the dev instance on 2026-09-04:

- The row never says when the last run happened, what came in, or where to see it.
- "Awaiting first sync" showed for hours. The real cause was that no background worker was
  running for the current checkout, so the queued job sat in the created state forever. Nothing
  on screen, and nothing Moss could read, distinguished "queued and waiting" from "broken".
- When the first run finally happened it wrote 23 calendar events and 148 emails, but 26
  messages failed (Google refused them one by one) and the run was cut short by the message
  cap. The row showed only "Partial sync" and "26 email messages failed", with no reason and no
  hint that the next run would carry on.
- The AI step that reads new mail was deferred because the saved Claude login had expired.
  That is a separate prerequisite problem, but the sync row gave no clue.
- There is a manual sync route for Google (`POST /api/connectors/google/sync`) but no button;
  a code comment in the pane says "there is no manual sync anymore".
- Moss has live Gmail and Calendar tools, but no tool that reads sync status, so when a user
  asks "why is my calendar out of date" it cannot answer from evidence.
- Only the latest run survives. A partial run followed by a clean one erases the evidence.

## Goals

- Show, per account, when the sync last ran, what came in by kind, where that data is visible,
  what failed and why in plain words, what happens next, and a short history of recent runs.
- Make "queued but no worker picked it up" a distinct, visible state, on screen and to Moss.
- Give the user a Sync now button that works for every provider, with honest feedback.
- Let Moss read the same status through a tool, and start a sync through a tool, so it can
  answer "is my mail up to date" and "why not" from the same facts the screen shows.
- Keep one source of truth for the human explanations, shared by the screen and the tool.
- Keep the shape provider-agnostic: Google and IMAP today, any future provider without a
  screen change.
- Warn outside Settings only when a failure takes away something the user can do, and say
  exactly what is not working, why, and where to fix it. Never a generic "sync failed".
- Keep the app map truthful in the same PR.

## Non-Goals

- Changing how a sync works, its schedule, its message cap, or its continuation lineage.
- Showing message subjects, senders, or event titles in the status. Counts only.
- A general job dashboard or worker admin screen. The worker signal here is scoped to what a
  user needs to understand their own account.
- Fixing the expired-AI-login problem itself (tracked separately in #2232 and PR 2233). This
  spec only surfaces it as a reason.
- Cross-user or admin views of run history. The admin metadata pane keeps its current summary.
- Push notifications or chat interruptions when a sync fails. The Today notice is shown when
  the screen is opened; a proactive hook can build on the run table later.

## Resolved Decisions

### 1. Keep a short run history, not just the last result

A new owner-only table records one row per completed run (a continuation chain counts as one
run and updates its row). The account row's existing `last_sync_*` columns stay as the summary,
so the admin-safe view and every current reader keep working unchanged. Retention is the most
recent 20 runs per account, pruned on write; no time-based sweep is needed.

### 2. Explanations live in one shared place

The human wording for every status, error code, and count combination moves out of the web
pane into a shared, dependency-free module in `packages/shared` (`connector-sync-explain.ts`).
The web pane, the new API response, and the Moss tool all call the same function. The web file
`settings-connector-sync.ts` becomes a thin adapter over it. This is what makes "Moss doesn't
know why either" go away: it reads the same sentences the user reads.

### 3. "Waiting for the background worker" is a first-class state

The API already reads job state to decide whether a sync lineage is in flight. The new status
endpoint extends that: if the newest sync job for the account has been in the created or retry
state for longer than a grace period (2 minutes) and nothing is active, the status is
`waiting-for-worker` with the time it was queued. Screen wording: "Queued 41 minutes ago, but
the background worker has not picked it up. If this keeps happening the worker may not be
running." Moss gets the same code and sentence. No heartbeat table is added; job age is enough
evidence and needs no new writer.

### 4. Sync now is per account and provider-agnostic

A new route `POST /api/connectors/accounts/:id/sync` queues the right job for that account's
provider (Google or IMAP) under the same rate limit as the existing Google route. The old Google
route stays for compatibility. The button is disabled while a run is in flight or queued, and
the pane's existing 2-second refresh while in flight is reused so the row updates itself.

### 5. Next run is computed, not stored

Both providers run on a fixed every-15-minutes schedule in UTC. Each provider exposes a small
pure function that returns the next scheduled time from the schedule expression, and the API
includes it only when a schedule is actually registered for that account or user. If no
schedule exists (for example after a revoke), the field is null and the screen says "Not
scheduled" instead of guessing.

### 6. Where the data lands is declared, not hard-coded in the screen

Each provider declares which data kinds it syncs and where the user sees each: calendar to the
Calendar screen (`/calendar`) and Today; email to email actions on Today and to the assistant's
mail tools. The status response carries these as `{ kind, label, count, seeAt }` entries, so a
future provider adds a kind without touching the pane.

### 7. Counts only, never content

Run rows and the status response carry numbers, codes, and timestamps. No subject, sender,
event title, message id, or token material. Per-message failures are counted, and the reason is
given as a class ("Google refused 26 messages one at a time; usually a message this account is
not allowed to read"), not a list.

### 8. Moss gets two tools

`connectors.syncStatus` (risk `read`, permission `connectors.view`) returns the same status
object as the endpoint for one account or all of the caller's accounts. `connectors.syncNow`
(risk `write`, permission `connectors.manage`) queues a run and returns the queued state. Both
are read-or-benign, so per the standing ruling that installing a module grants normal use, no
confirmation prompt is required.

### 9. Warn outside Settings only about lost abilities, named one by one

Ben's ruling, 2026-09-04: a notice outside Settings must say what is NOT working, for example
"Cannot create tasks from email" or "Calendar is out of date since 2 pm", with the reason and a
fix link. Not "sync failed".

Each provider declares a small capability map: the user-facing abilities it feeds, and which
sync phase or prerequisite each one depends on. The status code derives a "what is not working"
list from that map. Today shows one line per lost ability; the settings row shows the same
sentence; the Moss status tool returns the same list. A failure that takes nothing away (a
partial run whose next run will catch up, a stale-but-recent calendar) produces no notice
outside Settings.

## Open Questions for Ben

1. Twenty runs of history per account, or seven days? Twenty is simpler and enough to see a
   pattern; seven days keeps a quiet account's history longer.
2. Should Moss be allowed to press Sync now on its own (decision 8), or only report status and
   tell the user to press the button?
3. Should the deferred AI mail step ("Claude login expired, 12 messages not yet read by Moss")
   appear in the sync row with a link to Assistant settings, or stay only in Assistant settings?
   This spec assumes yes, as a reason line with a link.

## Architecture

### Storage and repository

New migration in `packages/connectors/sql/` (next free number after 0180) creating
`app.connector_sync_runs`:

| column | type | notes |
|---|---|---|
| id | uuid | primary key |
| connector_account_id | uuid | references `app.connector_accounts`, cascade delete |
| owner_user_id | uuid | copied from the account for RLS |
| trigger | text | `scheduled`, `manual`, `sweep` |
| started_at | timestamptz | |
| finished_at | timestamptz | null while in flight |
| status | app.connector_sync_status | `success`, `partial`, `failed` |
| error_code | text | null or one of the existing codes |
| counts | jsonb | same shape as `last_sync_counts` |
| job_id | text | pg-boss id of the root job, for support |

RLS: FORCE ROW LEVEL SECURITY, owner-only select and insert, same pattern as
`0022_connectors_owner_only.sql`. Index on `(connector_account_id, started_at desc)`. No admin
policy; the admin pane keeps using the account summary.

Repository additions in `packages/connectors/src/repository.ts`: `recordSyncRunStarted`,
`recordSyncRunFinished` (upsert by job id, then prune beyond 20), `listSyncRuns(accountId,
limit)`. `markSyncStarted` and `markSyncFinished` keep writing the summary columns; the job
code calls both so the two never disagree. Continuations reuse the root run id carried in the
job's `runId` field, which already exists.

### Explanations (shared)

`packages/shared/src/connector-sync-explain.ts` exports one pure function:

```
explainConnectorSync(input: {
  providerType, status, lastSyncStartedAt, lastSyncFinishedAt,
  lastSyncStatus, lastSyncError, lastSyncCounts,
  pending: { state: "queued" | "active" | "waiting-for-worker", since } | null,
  nextRunAt, deferredAi: { count, reason } | null
}) => {
  code: "revoked" | "syncing" | "queued" | "waiting-for-worker" | "sign-in-expired"
      | "connection-error" | "partial" | "capped" | "first-run-pending" | "synced"
      | "not-scheduled",
  tone: "forest" | "amber" | "red" | "neutral",
  label: string,        // short badge text
  summary: string,      // one sentence: what happened and when
  reason: string | null,// why, in plain words, when something failed
  next: string | null,  // what happens next
  canReconnect: boolean,
  canSyncNow: boolean
}
```

Wording table (the source of truth for tests):

| code | label | reason / next |
|---|---|---|
| synced | Synced | "Last run 12 minutes ago: 3 calendar events, 40 emails." / "Next check at 14:45." |
| partial | Partial sync | error-code sentence below / "The next run will retry what failed." |
| capped | More to fetch | "Stopped at the message cap; 148 emails so far." / "Continues automatically in the next run." |
| sign-in-expired | Sign-in expired | "Google no longer accepts the saved sign-in." / "Press Reconnect." |
| connection-error | Connection error | provider-agnostic sentence / "Press Reconnect, or check the server can reach the provider." |
| syncing | Syncing | null / "Started 20 seconds ago." |
| queued | Queued | null / "Waiting for the background worker to pick it up." |
| waiting-for-worker | Waiting for worker | "Queued 41 minutes ago and not picked up." / "The background worker may not be running." |
| first-run-pending | First sync pending | null / "Scheduled for 14:45." |
| not-scheduled | Not scheduled | null / "Reconnect to schedule syncing." |
| revoked | Revoked | null / null |

Error-code sentences: `auth-error` "The provider rejected the saved sign-in."; `calendar-error`
"Calendar could not be read."; `calendar-item-error` "Some calendar events could not be saved.";
`email-error` "Mailbox could not be read."; `email-message-error` "<n> messages could not be
read; usually the provider refused them one at a time."; `no-active-connection` "There is no
active connection for this account." Unknown codes fall back to the code with dashes replaced
by spaces, as today.

### API contracts

Shared types in `packages/shared/src/connectors-api.ts`.

`GET /api/connectors/accounts/:id/sync-status` (permission `connectors.view`, owner only):

```
{
  accountId, providerType,
  explained: <output of explainConnectorSync>,
  lastRun: { startedAt, finishedAt, status, errorCode, counts } | null,
  pending: { state, since, jobId } | null,
  nextRunAt: string | null,
  landed: [ { kind: "calendar", label: "Calendar events", count: 23, seeAt: "/calendar" },
            { kind: "email", label: "Emails", count: 148, seeAt: "/today" } ],
  deferredAi: { count, reason: "assistant-login-expired", seeAt: "/settings?section=assistant" } | null,
  notWorking: [ { ability, since, reason, fix: { label, path } } ],
  runs: [ { startedAt, finishedAt, trigger, status, errorCode, counts } ]   // newest first, max 20
}
```

`GET /api/connectors/sync-status` (permission `connectors.view`): the same object for every
account the caller owns, without `runs`, for Today and for the tool's all-accounts form.

`POST /api/connectors/accounts/:id/sync` (permission `connectors.manage`, owner only, rate
limited like the Google route): queues the provider's sync job for that account and returns
`{ queued: true, jobId }`, or `{ queued: false, reason: "in-flight" | "revoked" }`.

All three routes are declared in the connectors manifest, or the server refuses to start.

The `deferredAi` field is filled from the existing email-extraction deferral count in the run's
counts (the escalation and retryable-error path already increments a counter) plus the reason
the AI router reported. It carries no prompt or message content.

### Worker detection

The status route reuses the jobs package helper that reads pg-boss job state with the root
connection and asks for the newest job on the account's queue whose singleton key is the
actor (Google) or the account id (IMAP). State mapping: `active` is `syncing`; `created` or
`retry` younger than 2 minutes is `queued`; older is `waiting-for-worker`; none is null. The
grace period is a constant in the connectors package, not a setting.

### Capability map and lost-ability notices

Each provider module exports a declared, static map. Google's:

| ability (user words) | depends on | stale after |
|---|---|---|
| Calendar on the Calendar screen and Today is current | calendar phase succeeded | 1 hour since the last good calendar phase |
| Tasks and follow-ups are created from new email | email phase succeeded and the assistant's mail-reading step ran | 1 hour since the last good email phase |
| Moss can answer about recent email | email phase succeeded | 1 hour |

IMAP declares the two email abilities only. A provider with no calendar declares no calendar
line, so nothing about calendars is ever shown for it.

The shared explain module gains a second pure function, `deriveNotWorking`, which takes the
capability map, the run facts, the pending state, and the deferred AI reason, and returns a
list of:

```
{ ability: "Cannot create tasks from email",       // what is not working, Ben's phrasing
  since: "2026-09-04T14:00:00Z",                    // when it last worked, or null
  reason: "the assistant's Claude login has expired",
  fix: { label: "Log the assistant in", path: "/settings?section=assistant" } }
```

Rules for deriving the list, tested one per row:

| situation | not working |
|---|---|
| calendar phase failed, or no good calendar phase within the stale window | "Calendar is out of date since 2 pm", reason from the error code or "the sync has not run", fix Reconnect or Sync now |
| email phase failed, or no good email phase within the stale window | "Tasks are not being created from email" and "Moss cannot see recent email", same reason and fix |
| email phase good but the assistant's mail-reading step was deferred | "Tasks are not being created from email", reason "the assistant's Claude login has expired", fix Assistant settings |
| sign-in expired | every ability in the map, reason "Google no longer accepts the saved sign-in", fix Reconnect |
| waiting for worker past the grace period | every ability whose stale window has passed, reason "the background worker has not picked up the sync", fix Sync now |
| partial run, next run will retry, stale window not passed | nothing |
| revoked account | nothing (the user chose this) |

Each line is one sentence in the form "<ability>, since <time>, because <reason>." followed by
the fix link. The `since` time is the finish of the last good phase, shown in the user's time
zone as "since 2 pm" or "since yesterday".

The list is part of the sync-status contract as `notWorking: [...]` and is what Today,
the settings row, and the Moss tool all read.

**Today.** A new small block at the top of Today, rendered only when any connected account has
a non-empty `notWorking` list, using the existing Today card styling and a jds Badge with the
`red` tone. One line per lost ability, deduplicated across accounts, each with its fix link. It
reads from a new `GET /api/connectors/sync-status` (all of the caller's accounts) so Today makes
one request. Today is a core screen; the block is declared in the core app-map entry for Today
in the same PR.

```
(●) Not working right now
    Calendar is out of date since 2 pm, because Google no longer accepts the saved sign-in.   Reconnect
    Tasks are not being created from email since 2 pm, because the assistant's Claude login has expired.   Log the assistant in
```

**Settings row.** The same sentences appear in the "What failed" area of the expanded row, and
the first one replaces the summary line while the list is non-empty, so the row and Today never
disagree.

### Moss tools and app map

Two tool entries in `packages/connectors/src/manifest.ts` beside the live Gmail and Calendar
tools:

- `connectors.syncStatus`: input `{ accountId?: string }`, output the sync-status contract for
  one or all accounts, including the `notWorking` list so Moss can say "tasks are not being
  created from email because the assistant login expired" instead of "sync failed".
  `risk: "read"`, `permissionId: "connectors.view"`, not external content.
- `connectors.syncNow`: input `{ accountId: string }`, output the sync route's response.
  `risk: "write"`, `permissionId: "connectors.manage"`.

The connectors manifest gains a `features` block with `connectors.sync_status` (description of
what the row shows and that Moss can read it), `errors` for `waiting-for-worker`,
`sign-in-expired`, and `assistant-login-expired` with `remediations` pointing at
`/settings?section=connected` (Reconnect, Sync now) and `/settings?section=assistant` (log the
assistant in), and the new migration in its migration list. The core app-map entry `connected`
in `packages/shared/src/app-map-core.ts` gets one extra sentence: each account shows when it
last synced, what came in, what failed and why, and a Sync now button. The core `today` entry
gets one sentence: Today lists any ability that is not working because a connected account or
the assistant login has a problem, with a link to fix it.

### Settings screen

The Connected accounts pane keeps the current row layout and adds an expandable detail area.
The row's badge comes from `explained.tone` and `explained.label` (jds Badge with `dot`, tones
`forest`, `amber`, `red`, `neutral`; `red` is new for waiting-for-worker and sign-in-expired).
The summary sentence replaces the current alert line. A quiet small Button toggles the detail
area; a secondary small Button is Sync now. New authored classes live in
`apps/web/src/styles/settings-panes.css` next to the existing `acct__*` rules and use only
`tokens.css` values. No new component is invented.

Collapsed row (unchanged shape, better words):

```
[G]  Google
     google · Live connection   (●) Partial sync
     Last run 12 minutes ago: 23 calendar events, 148 emails; 26 messages could not be read.
     [Email access  ◉]  [Calendar access ◉]                 [Details]  [Sync now]  [Revoke]
```

Expanded row:

```
[G]  Google
     google · Live connection   (●) Partial sync
     Last run 12 minutes ago: 23 calendar events, 148 emails; 26 messages could not be read.

     What came in
       Calendar events   23   See them on Calendar and Today
       Emails           148   Used by email actions on Today and when you ask Moss about mail

     What is not working
       Tasks are not being created from email since 2 pm, because the assistant's Claude
       login has expired.   Log the assistant in

     What failed in the last run
       26 messages could not be read; usually Google refused them one at a time.

     What happens next
       Stopped at the message cap. Continues automatically in the next run, at 14:45.

     Recent runs
       14:31  Scheduled   Partial   23 events, 148 emails, 26 failed
       14:16  Scheduled   Failed    Waiting for worker (not picked up)
       13:58  Manual      Synced    2 events, 5 emails
       13:45  Scheduled   Synced    0 events, 3 emails

     [Email access  ◉]  [Calendar access ◉]           [Hide details]  [Sync now]  [Revoke]
```

Waiting-for-worker row:

```
[G]  Google
     google · Live connection   (●) Waiting for worker
     Queued 41 minutes ago and not picked up. The background worker may not be running.
     Next check at 14:45.                                  [Details]  [Sync now]  [Revoke]
```

The runs list is a plain authored list with three fixed columns (time, trigger, result) and one
free-text column; on a phone the free-text column wraps under the result. Times use the user's
time zone from Profile, as the rest of settings does. All wording comes from the shared explain
module; the pane adds no sentences of its own.

Pressing Sync now shows the existing toast pattern: "Sync queued" on success, or the reason on
`queued: false`. The row flips to Queued at once through the existing in-flight refresh.

### Data model and RLS summary

- `app.connector_sync_runs`: owner-only (FORCE RLS, select and insert for the owner; delete for
  prune runs under the owner scope from the job). No admin policy.
- `app.connector_accounts`: unchanged.
- Job payloads: unchanged shape, metadata only.

## Testing

- Unit: `explainConnectorSync` against the wording table, one case per code plus the unknown
  error code fallback and the worker grace boundary.
- Unit: repository prune keeps exactly 20 newest runs; continuation updates the root run row.
- Integration (gate): Google and IMAP jobs write both the summary columns and a run row with
  matching status and counts; a failed auth writes `failed` / `auth-error` in both places.
- Integration: sync-status route returns `waiting-for-worker` for a 3-minute-old created job
  and `queued` for a 30-second-old one; a revoked account returns `not-scheduled` with
  `canSyncNow` false.
- Integration: per-account sync route queues a Google job for a Google account and an IMAP job
  for an IMAP account, and refuses while a lineage is in flight.
- Unit: `deriveNotWorking` against the rules table, including the "partial but not stale"
  case producing an empty list and the IMAP map producing no calendar line.
- Web: Today shows the block only when a list is non-empty, one line per ability, deduplicated
  across two accounts with the same lost ability.
- Tool: `connectors.syncStatus` returns the same object as the route for the same actor and
  refuses another user's account id.
- Web: pane renders each code's label, summary, and next line; Details toggles the runs list;
  Sync now disabled while queued or syncing.
- Live-path proof on dev, recorded on the PR: stop the worker, connect or Sync now, watch the
  row reach Waiting for worker; start the worker, watch it run and show counts and the runs
  list; expire the assistant login and see "Tasks are not being created from email" on Today
  with the Assistant settings link; ask Moss "is my calendar up to date" and see it quote the
  same status and the same not-working line.

## Exit criteria

- Every connected account row states when it last ran, what came in by kind with where to see
  it, what failed and why in plain words, and what happens next including the next run time.
- A queued job that no worker picks up within 2 minutes is shown as Waiting for worker, and
  Moss reports the same, so the 2026-09-04 "Awaiting first sync forever" case is diagnosable
  from the screen alone.
- Sync now exists for Google and IMAP accounts, is disabled while a run is queued or in flight,
  and gives a toast either way.
- The last 20 runs per account are visible under Details.
- Outside Settings, the only sync-related notice is the Today block, it appears only when an
  ability is lost, and each line names the ability, the time it stopped, the reason, and a fix
  link. No generic "sync failed" text exists anywhere in the product.
- Today, the settings row, and the Moss tool produce byte-identical not-working sentences for
  the same facts.
- `connectors.syncStatus` and `connectors.syncNow` are declared in the manifest and return the
  same facts as the screen, using the same sentences.
- Human wording exists in exactly one module, and the web health mapping no longer contains its
  own copies.
- The connectors manifest features, errors, remediations, and migration list, and the core
  `connected` app-map entry, match the shipped behaviour in the same PR.
- Live dev proof recorded on the pull request as described under Testing.

## Hard invariants honored

- Private by default: run history is owner-only under FORCE RLS; no admin policy.
- Secrets never escape: run rows, status responses, tool output, and job payloads carry codes,
  counts, and timestamps only.
- Metadata-only job payloads: the per-account sync route sends the same payload shapes as today.
- Provider-agnostic: the status shape, the tools, and the screen know only `providerType` and
  declared data kinds; the AI deferral reason names no model or provider.
- Module isolation: Calendar and Today are referenced by path in `seeAt`, not by import.
- Never edit an applied migration: one new file in `packages/connectors/sql/`.
- No new required setting or env var: the worker grace period is a constant.
- App map truthfulness in the same PR.

## Slice plan (one session each, shared worktree and PR)

1. **Record and explain.** Migration, repository functions, job code writes run rows, shared
   explain module with the wording table, the capability maps, `deriveNotWorking`, and unit
   tests. The web pane switches to the shared
   module with no visible change yet. Gate green.
2. **Status and control.** Sync-status route with worker detection and next-run time,
   per-account sync route, both Moss tools, manifest features/errors/remediations, app-map
   sentence, integration and tool tests.
3. **Screen and proof.** Expandable row, runs list, Sync now, the Today block, authored CSS,
   web tests, then the live-path proof on dev including the stopped-worker and expired-login
   cases, recorded on the PR.

## Self-review

- Every column, code, route, queue, and file named above exists on main today or is declared
  new in this spec; the observed dev facts are from the 2026-09-04 live session.
- The worker state is derived from job age, which the API can already read, so no new
  background writer or setting is introduced.
- Content never enters the status path; only counts and codes.
- Notices outside Settings follow Ben's 2026-09-04 ruling: only for a lost ability, naming the
  ability, the time, the reason, and a fix; derived from a declared map, not hand-written per
  screen.
- Open questions are ones only Ben can settle (retention, Moss pressing Sync now, AI deferral
  placement); none block slice 1.
