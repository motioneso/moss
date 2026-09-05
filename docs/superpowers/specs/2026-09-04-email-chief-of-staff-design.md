# Email as chief of staff: one owed item per thread, judged with your context

Date: 2026-09-04. Status: design agreed with Ben section by section in a brainstorming session
(this document is the written form; Ben still reviews the file before a plan is written).
Grounded on dev checkout `c9d48303c` (main plus PRs 2257, 2271, 2270 merged locally).

Ben's direction (2026-09-04, 19:40): "we need the email processing to be smart, and really be
able to tie everything together with the notes, tasks, etc. This is where Moss really becomes the
chief of staff."

## 1. Problem

Today each synced email is judged on its own by the model in `packages/connectors/src/email-extract.ts`
(`extractEmailSignals`): a one-line summary, a verdict (`needs_reply`, `needs_action`,
`time_sensitive`, `waiting`, `fyi`, `noise`), a bulk-mail flag and a sign-in-code skip. PRs #2257
and #2271 tightened the rules so only real obligations get flagged. The verdicts feed the evening
briefing as "email signals" and can suggest tasks (`source-context/email-tasks.ts`).

What is missing:

- The model reads mail cold. It never sees who the sender is to the user (People), what the user
  has written about them (notes), what the user already owes (tasks), or when the user is free
  (calendar).
- Verdicts are per message. A three-message thread yields three flags, not one thing to do.
- A flag is not an action. Nothing drafts the reply, sets the task's due date to when the user's
  part is owed, or clears the item when the user acts, in the app or in Gmail.
- Every message, including ordinary mail that asks nothing, gets a stored summary and verdict.

The Commitments module (`packages/commitments`, spec `2026-06-27-automatic-commitment-extraction.md`)
already stores "candidates": a promise, deadline or obligation with counterparty, due date,
confidence, suggested handling, accept / reject / snooze, a resolution link and per-source
evidence. Its `source_kind` check already allows `email`, but no email source was ever wired, and
candidates reach Today only as lines in the briefing text.

## 2. Decisions (from the session)

| Question                            | Ruling                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Where does this live for the user?  | Today screen first, leading into tasks and calendar; Moss also knows in chat.                                        |
| How much does Moss do on its own?   | Suggest only. Nothing is created in tasks, calendar or Gmail until the user taps. Auto modes stay a later opt-in.    |
| What closes an item?                | All three: an in-app action; a reply from the user seen in Gmail on sync; the linked task completing.                |
| Actions in version one              | Draft reply, make task, snooze, dismiss. "Hold time on the calendar" is deferred.                                    |
| Which mail gets the full treatment? | Two passes. A cheap gate on every message; a reasoning-tier pass only on threads the gate says might be owed.        |
| First-pass selectivity              | The gate is not a summariser. Ordinary mail (bulk or not) that asks nothing gets no summary or verdict, just "seen". |
| How does Moss know in chat?         | A tool only. No standing context injection. Relevance-matched nudges are a later follow-up.                          |
| What does dismiss teach?            | Optional reason. Only "not something I owe" teaches, per sender.                                                     |
| Where is it built?                  | Grow the Commitments module into the store (approach A), not a new store in email or a new module.                   |
| Today card shape                    | Layout B: a list, every row collapsed until tapped; tapping expands it with the "why" and the actions.               |

Model tiers are requested as capabilities ("cheapest", "reasoning"); the router picks the user's
configured model. No provider or model name appears anywhere (hard invariant).

## 3. The two passes

### 3.1 First pass: the gate (cheapest tier, every message)

Replaces today's per-message summary-and-verdict as the first thing that happens to a synced
message. Inputs: sender, subject, body, arrival date, today's date, bulk-mail flag, sign-in-code
result, and two new facts: the thread id, and whether the sender is known (a People match, or the
user has replied to this address before). Output is one of three:

- **nothing** — ordinary mail, bulk or not: newsletters, receipts, notices, routine back-and-forth
  that asks nothing of the user. Marked as seen. No summary, no verdict stored.
- **worth_knowing** — the user would want to glance at it but it asks nothing: a shipment landed,
  a payment went through, a friend's news. A one-line summary is stored; nothing else.
- **maybe_owed** — someone might be waiting on the user or a date might bind them. The message's
  thread is queued for the second pass. No verdict is stored at this stage.

The bar for `maybe_owed` is the #2271 one (a real obligation from a person or institution the
user deals with; urgent wording is not evidence), but the cheap model is allowed to be unsure:
when it cannot tell, it says `maybe_owed` and lets the reasoning pass decide. The sign-in-code
skip, the bulk flag and the #2271 fyi and noise lists are inputs to this answer, not separate
outcomes. A known sender is a reason to lean `maybe_owed`, never a gate.

Existing `signals` columns stay for compatibility with briefings; the gate writes `fyi` for
`worth_knowing`, `noise` for `nothing`, and leaves the verdict empty for `maybe_owed` until the
second pass fills it.

### 3.2 Second pass: the judgement (reasoning tier, per thread)

Queued per thread, not per message, with a short debounce (a few minutes) so several messages
arriving together produce one judgement. The job payload is the actor id, the thread id and an
idempotency key (metadata-only rule). Queue name and handler live in the Commitments module; the
email module's sync raises the request through a declared public API, never by writing
Commitments' tables.

Gathered before the model call, each through the owning module's public API and each optional
(a failed lookup is dropped and the "why" says so):

- the thread's messages inside the sync window (email module);
- the People entry for the sender and recent notes that mention them (People, notes search);
- the user's open tasks that look related by title or counterparty (tasks);
- the user's calendar for the next two weeks, only when the thread is about meeting or a date
  (calendar).

The model answers one question: does this thread create something the user owes? If yes: what,
who is waiting, when the user's part is due (the reply or step, never the event date, per
#2271's rule), which of the four actions fit, and two or three "why" lines. If no: the thread is
recorded as judged at this message id and is not re-judged until a newer message arrives.

The second pass cannot promote a message the gate called `nothing`; it only runs on
`maybe_owed` threads.

## 4. The item

One Commitments candidate per email thread (`candidate_signature` derived from owner + thread id
so re-judgement updates rather than duplicates). New fields on the candidate, all owner-only under
the module's existing RLS:

- **counterparty link**: People id when matched, else display name and address only;
- **owed by**: `due_local_date` already exists; its meaning is "when the user's part is owed";
- **proposed actions**: a small JSON list, at most four, each pre-filled: reply (the facts and
  slots it would use, not a finished draft: the draft is generated fresh at tap time), task
  (title, due date, list), snooze (suggested return date), dismiss;
- **why**: up to three short lines; any quote from the email is capped at one sentence;
- **thread link and last judged message id**: back-reference into the email module; a newer
  message on the thread re-opens the judgement and updates this candidate;
- **stale flag**: set when `due_local_date` is more than 14 days past with no action.

Not stored: the email body, recipient lists, or any note content beyond the "why" lines. Chat- and
note-sourced candidates keep working unchanged and simply have no proposed actions yet.

## 5. Today card and actions

Agreed mockups, kept with this spec:

- `assets/2026-09-04-email-chief-of-staff/01-today-card-layout-options.html` (Ben chose B, with
  every row collapsed by default rather than the top one open);
- `assets/2026-09-04-email-chief-of-staff/02-row-expanded-and-actions.html` (approved as shown).

Card "You owe people", with the open count. Each row: title, who is waiting (avatar when a People
match exists), owed-by date. Tapping a row expands it: source line ("from email, 2 messages"),
the "why" block, the four action chips, and links "Open thread" and "Open <person> in People".
Only one row is open at a time.

- **Draft reply**: opens a sheet with an editable reply. Free slots are pulled from the calendar
  at tap time. Buttons: Send, Save as Gmail draft, Cancel. Send and Save use the existing
  `email.sendReply` / `email.draftReply` tools under their existing confirmation tiers. Either one
  resolves the item with the message id.
- **Task, due <date>**: creates the task at once in the user's default list through tasks' public
  API, swaps the chip for "Task made · open", links the task id on the candidate. The item stays
  open until the task completes or the thread is answered.
- **Snooze**: Moss's suggested date plus tomorrow / next week / pick a date. Uses the existing
  snooze.
- **Dismiss**: a sheet with an optional reason: "Not something I owe" (teaches, section 7),
  "Already handled" (clears only), "Not now" (clears; the item comes back if they write again).
  Dismiss with no reason just clears.

Design-system rules apply: `jds-*` primitives, `tokens.css` typography, the audit for invented
classes. The mockups are wireframes for shape and flow, not styling.

## 6. Closing the loop

All three triggers land on the existing resolved status with a `resolution_ref` naming what
resolved it:

- **In the app**: Send / Save (message id), Task made then task completed (task id; a subscriber
  on a task status-change notification exposed through tasks' public API, added in slice 2 if
  tasks does not yet publish one; never a query on tasks' tables), Dismiss (reason if any).
- **From Gmail, on every sync**: for each open email candidate, a message from the user on the
  thread newer than the last judged id resolves it as "you replied". A newer message from the
  other side re-queues the second pass for the thread, which updates the same candidate.
- **Ageing**: stale items (section 4) drop off Today but remain on the Commitments page. Nothing
  auto-dismisses silently.

## 7. Moss in chat

`commitments.list` grows to return proposed actions and "why" lines and gains a filter for open
email-sourced items. Moss takes the four actions through the existing `commitments.accept`,
`commitments.reject`, `commitments.snooze` and the email draft / send tools, under today's
confirmation tiers. No standing context injection.

## 8. Learning from dismiss

The Commitments module keeps a per-owner, per-sender-address count of "Not something I owe"
dismissals. At two, the gate is told that mail from this sender has been ruled not an obligation,
and that sender's mail caps at `worth_knowing`. The rule is shown as one toggle on the sender's
People entry ("Moss flags mail from this person as things you owe: off") and undoing it clears
the count. Reason-less dismissals and the other two reasons teach nothing.

## 9. Settings and app map

- Existing email behaviors "Include in briefings" and "Capture tasks" stay.
- New email setting, on by default: "Judge flagged email with your notes, tasks and calendar".
  Off means the gate still runs and `maybe_owed` threads get a plain verdict without context and
  no proposed actions.
- The per-sender toggle lives on the People entry.
- Both, and the new Today card and its actions, are declared in the app map in the same PR
  (`packages/shared/src/app-map-core.ts` for the Today card; the email, commitments and people
  manifests for their settings and behaviors).

No new required environment variable or hand-edited settings file (Ben's ruling, 2026-09-01).

## 10. Failure handling

- Reasoning-tier model unavailable or erroring: the thread job retries with backoff; no candidate
  is written from a partial answer.
- People / notes / tasks / calendar lookup fails: the second pass runs without that context and
  the "why" notes what it could not see.
- Malformed model answer: treated as "no item", logged with bounded fields only (never the prompt
  or the answer text), consistent with the module's existing warn logger.
- Drafts are generated at tap time, so a slot that has since been booked is never offered.
- The dev sync only refetches the last 30 days; a thread older than that cannot be re-judged and
  is left as is.

## 11. Testing

Unit:

- the gate on the #2271 spot-check set (promotion, ticket drop, policy update, sign-in notice, a
  genuine obligation with an unsubscribe link) plus "ordinary mail from a friend that asks
  nothing" (expected: `nothing`, no summary stored);
- the thread debounce: three messages within the window produce one job;
- one candidate per thread across re-judgements; a newer message from the other side updates,
  not duplicates;
- each of the three closing triggers;
- the dismiss-learning threshold and its undo;
- payloads carry only ids and keys; no body text reaches the queue, logs, or the candidate beyond
  the capped "why" lines.

Live proof on dev against Ben's real inbox, recorded on the PR: before-and-after counts in the
style of #2271, plus the five spot checks and at least one full loop (item appears on Today, reply
drafted and sent, item resolves) and one Gmail-side close (reply sent from Gmail, item resolves
on the next sync).

## 12. Build slices

Three session-sized slices sharing one branch and one PR (Ben's ruling, 2026-08-25). A new
milestone and a `task` issue precede the build.

1. **Judgement**: gate rework in the connectors extraction, the per-thread queue and second pass
   in Commitments, candidates written with proposed actions. No UI. Proof: candidates visible on
   dev for real threads, with correct owed-by dates.
2. **Today card and actions**: the card, expand-on-tap, the four actions with their sheets, and
   all three closing triggers.
3. **Moss, learning, settings**: tool changes, dismiss learning and the People toggle, the new
   email setting, app map entries, release note.

## 13. Out of scope

Holding time on the calendar from an item; auto-creating tasks or events (later opt-in);
relevance-matched nudges in chat; standing context injection; thread summaries; any change to the
OAuth scopes (gmail.modify already covers drafts and sends).
