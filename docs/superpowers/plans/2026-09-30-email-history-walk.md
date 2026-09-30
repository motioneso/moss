# Email backlog walk by change history, plus the judgement-requested marker (#2804)

Issue #2804, fix 4 and the companion marker from the comment on PR #2806. Tier: sensitive
(sync/import). Fixes 1 to 3, 5 and the retry cap already shipped (#2806, #2819).

## Seams checked (branch at 6da12ddee)

- Backlog walk: `runGoogleEmailPhase` with phase `email` lists `newer_than:30d older_than:1d` through
  `GoogleEmailReadProvider.listMessageKeyPage` (`packages/connectors/src/email-read-provider.ts:62`)
  and `google-sync-phases.ts:599-680`. Phase chaining and the final `markSyncFinished` are in
  `sync-jobs.ts:450-520`. No Gmail history call exists yet (`grep historyId` hits only message-level
  revision ids).
- Per-account state: the only per-account sync columns are the `last_sync_*` health columns
  (`packages/connectors/sql/0099`). Nothing stores a Gmail mailbox position.
- Repeat judgement asks: `sortFetchedEmails` returns `rejudgeThreadRefs` for unchanged hand-offs
  (`google-sync-phases.ts:364-420`), sent by `requestRejudgements` (`:509`). Judgement results live in
  a commitments table that the connectors package must not query (module isolation), so the marker
  sits on the email row.
- Next migration number after `0247`; the coordinator assigns landing order, so the number is taken
  at build time from current main.

## Decisions

### D1. Mailbox position column (new migration, connectors-owned)

`app.connector_accounts.email_history_id text NULL`. Additive. Holds the Gmail mailbox position
captured at the START of the last backlog walk that finished with no email errors. Metadata only,
never content. No new setting and no screen change, so no app-map change.

### D2. Change-history backlog walk

- New `GoogleApiClient.getProfileHistoryId(accessToken)` (Gmail `users.getProfile`) and
  `listHistoryPage({ accessToken, startHistoryId, pageToken })` (Gmail `users.history.list`, types
  messageAdded, labelAdded, labelRemoved), returning changed message ids, the next page token and the
  newest history id.
- `runGoogleEmailPhase(phase "email")`: when the account has a stored position, list changed ids from
  history instead of `messages.list`; fetched messages still go through `sortFetchedEmails`, so an
  unchanged message is skipped as today. Ids outside the 30-day window are dropped using the fetched
  message's received date.
- Full walk (no stored position, or Gmail answers 404 because the position expired): today's
  behavior. The walk captures the mailbox position before its first page and saves it only when the
  whole walk ends with `errors.length === 0`. A partial or failed run leaves the old position, so
  nothing is ever skipped because of a bad run.
- Position is carried across continuation chunks in the existing continuation payload (small string),
  saved in `sync-jobs.ts` next to `markSyncFinished`.
- Escape hatch: a failed history call falls back to the full walk for that run (logged, bounded).

### D3. Judgement-requested marker

`app.email_messages.judgement_requested_at timestamptz NULL`, reset to NULL when a new revision is
saved (same place `analysis_attempts` resets). `listSyncMarkers` returns it; the sync asks for a
thread judgement again only when the marker is NULL or older than 6 hours, and stamps it when it
asks. A lost request still heals after 6 hours, but an unchanged hand-off no longer costs a queued
job and a thread read on every 15-minute run.

## Tests (each observed failing without the change)

1. Unit: history walk fetches only ids the history page names; a run with a stored position calls
   `messages.list` zero times. Fails on current code (always lists).
2. Unit: 404 from history falls back to the full walk and ends with a saved new position.
3. Unit: a run with email errors does NOT save the position. Fails if saved unconditionally.
4. Unit: changed message (new revision) in history is analysed; unchanged one is not sent to the model.
5. Integration (scratch database via verify-gate): position column round trip under the worker role
   and RLS (owner-only rows untouched by another actor).
6. Unit + integration: an awaiting hand-off stamped less than 6 hours ago yields no rejudge request;
   older, or NULL, does; a changed revision clears the stamp.

## Verification

`pnpm format:check && pnpm lint && pnpm typecheck`, then the full gate through the `verify-gate`
skill only. Never piped.

## Unverified by design

No Gmail account is available, so live history behavior (real history ids, expiry 404 shape,
real quota) is unproven. The PR body says code-complete, unverified on live mail; tests use a fake
Gmail client.

## Kill gate

After D2 tests pass: if Gmail history cannot express "changed within the window" without
re-fetching more than the list walk does, stop and report instead of building D3.
