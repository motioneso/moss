# Today catch-up: important email digest (#3028)

Status: approved design (Ben, 2026-10-04, mockup on the live Today screen).

## Problem

The Catch-up block under Needs you shows "N informational messages" plus the first 180
characters of raw summaries run together. It does not say who wrote, what each email is about, or
what to do with it.

## Outcome

Catch-up lists the few emails since the last briefing that are worth knowing about. Each one shows
the sender, a one-line summary, the time, and actions. The block is absent when nothing qualifies.

## Approved design

- Head: `Catch-up` eyebrow, count caption (`4 emails since 7:00 AM`), `InfoTip` "Why these
  emails?" explaining the rule below.
- Rows: `RowIndex` with a new `density="compact"` option in `@moss/ui`. Three columns: sender
  (with an `Important` or `Waiting on them` badge), summary (wraps to two lines), meta.
- Meta, left to right: time, `Open` (only with a provider link), `Reply`, `Add task`, dismiss
  icon. Optional `Open` sits left so the fixed buttons stay aligned.
- Five rows show; the rest sit behind `Show N more`.
- Foot caption: `Left out N newsletters, receipts and notifications.` (omitted at zero).
- After an action the meta shows `Added to your tasks` or `Dismissed`, with `Undo`.
- Phone: `RowIndex` stacks each row (sender, summary, meta wrapping).

## What counts as important

Built in `buildEmailCatchUp` from the email tool's items. Reuses the connector's triage.

| Rule                                            | Source                |
| ----------------------------------------------- | --------------------- |
| Not already a Needs you action row              | `actionRowSourceRefs` |
| Actionability `fyi` or `waiting_on_someone`     | connector triage      |
| Importance not `low`                            | connector triage      |
| Not mailing-list mail, unless importance `high` | `signals.bulk`        |
| Has a guarded summary                           | connector triage      |
| Not awaiting the Commitments closer look        | `awaitingJudgement`   |
| Received inside the window                      | see below             |
| Not dismissed or added from the digest before   | usefulness feedback   |

- Window start: morning uses the previous succeeded morning run, else 24 hours back. Evening uses
  the start of the local day (the evening section already reads "arrived today").
- Order: importance `high` first, then `waiting_on_someone`, then newest.
- Cap: 8 entries in the payload.
- Reason badge: `important` when importance is `high`, else `waiting_on_them` for
  `waiting_on_someone`, else none.
- `leftOutCount`: in-window, non-action-row items with actionability `noise` or
  `receipt_or_notice`, or that failed the importance or mailing-list rule. Unsorted mail does not
  count.

## Data contract

`BriefingCatchUpDto` (shared) changes shape. Both the type and the JSON schema change together.

```
{ source: "email", itemCount, since: string | null, leftOutCount, asOf, entries: Entry[] }
Entry { id, senderName, summary, receivedAt, reason, cacheMessageId | null, openHref | null }
```

- `id` is `email-digest:` plus a short hash of the message source ref. It is the feedback target
  ref, so a dismissal follows the message into later runs.
- `senderName` is the display name from the sender header, else the address local part.
- `openHref` is the provider link from the email item, kept only when it is `https:`.
- `summaryText` is removed. Runs stored before this change normalize to `catchUp: null` on read.

The email tool output gains `sourceHref` and `bulk` (both already on the internal item or
signals).

## Actions

| Action   | Effect                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Open     | Provider link in a new tab                                                                                                        |
| Reply    | Opens chat with the existing reply prompt for `cacheMessageId`                                                                    |
| Add task | `POST /api/tasks` (title `Follow up with <sender>`, summary as description), then a `more_like_this` feedback signal on the entry |
| Dismiss  | `dismiss` feedback signal on the entry                                                                                            |
| Undo     | Undo endpoint for the signal; Add task's undo also archives the created task                                                      |

- Feedback reuses `app.usefulness_feedback_signals` with target kind `briefing_item`, surface
  `briefing`. The runs route upserts a target for each entry, as it does for briefing items.
- The runs route drops entries whose target has an active `dismiss` or `more_like_this` signal,
  and drops the whole block when no entries remain.

## Privacy

- Entries carry sender display names and guarded summaries. Run payloads are owner-only under RLS;
  the old payload already carried the same summaries.
- Job payloads are unchanged. Feedback targets carry no email content beyond the hashed ref.

## App map

`packages/shared/src/app-map-core.ts` Today entry: rewrite the Catch-up sentence to describe the
digest, its rule and its four actions.

## Tests

- Unit (briefings): eligibility rule, ordering, cap, reasons, window, left-out count, sender name,
  https-only link.
- Unit (web): rows render, absent when empty, actions call the right clients, undo.
- Unit (route): dismissed and added entries drop out; old payload normalizes to null.
- Live proof on dev with real synced email; public screenshots cropped or described.

## Out of scope

- Teaching the email sorter from digest dismissals.
- Creating email-linked suggested tasks from the digest (no create path accepts a source ref).
