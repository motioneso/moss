# Chat repairs and relative-reminder reslices

Date: 2026-10-09. Integration: `integration/scheduled-proactive` in `~/Jarv1s`.
Source inspected: `fd134e7f1c65de402f661f8f2c899f814d60ea75`.
Status: five native tasks published; none implemented by this reslicing pass.
Commit this plan before dispatch. GitHub's native subissue/blocking graph remains the live
work source; this document records scope and proof requirements, not task closure.

Read the [reconciled spec](../specs/2026-10-07-scheduled-tasks-and-proactive-messaging.md),
[original ticket proposal](2026-10-08-scheduled-proactive-ticket-proposal.md),
[approved migration decisions](2026-10-08-scheduled-proactive-migration-decisions.md) and
[integration state](2026-10-08-scheduled-proactive-implementation-state.md).
All four migration rulings, four accepted mockups and UI/API/worker verification seams
remain approved. Preserve their acceptance; proceed without another product interview or
prototype. This plan supersedes earlier dispatch assumptions for #3126 and #3149 only.

## Native graph and dispatch order

| Native task                                            | Parent | Direct blockers | Complete user outcome                                                                             |
| ------------------------------------------------------ | ------ | --------------- | ------------------------------------------------------------------------------------------------- |
| [#3191](https://github.com/motioneso/moss/issues/3191) | #3126  | #3125           | Caller text remains editable and recoverable when the provider is unavailable.                    |
| [#3192](https://github.com/motioneso/moss/issues/3192) | #3126  | #3191           | The owner's stable Main remains authoritative; genuinely granted histories remain accessible.     |
| [#3193](https://github.com/motioneso/moss/issues/3193) | #3126  | #3192           | Existing Main/private/Meeting/Notes/app-action paths retain their behavior through Conversations. |
| [#3194](https://github.com/motioneso/moss/issues/3194) | #3149  | #3125, #3126    | A requested relative reminder survives reopening and informs the next real Main reply.            |
| [#3195](https://github.com/motioneso/moss/issues/3195) | #3149  | #3194           | A due reminder appears immediately beside a live Main reply without replacing or duplicating it.  |

Original blockers remain. [#3126](https://github.com/motioneso/moss/issues/3126) additionally
waits for #3193; its core is integrated, but its acceptance remains incomplete pending repairs.
[#3149](https://github.com/motioneso/moss/issues/3149) additionally waits for #3195 and remains
a full acceptance container under [#3132](https://github.com/motioneso/moss/issues/3132).
#3150 still waits for #3149; #3132 still waits for #3150 and retains its original #3125 edge.
Completing #3194 alone does not complete #3149 or release #3150/#3132's downstream consumers.
The published graph has 39 nodes and 50 blocking edges. Revalidate live blockers before dispatch.

Use one fresh builder at a time for overlapping chat/runtime ownership. The working sequence
is #3191 → #3192 → #3193 → original #3126 acceptance → #3194 → #3195 → original #3149
acceptance → #3150. Integration and verification govern readiness; labels or board status
alone do not establish ownership, completed implementation or proof.

## Actual proof and remaining failures

The integrated #3126 core retains its exact historical source-only reviews and installed
proof in [the side-chat evidence](../handoffs/2026-10-09-3126-evidence.md).
At clean pushed `fd134e7f1c65de402f661f8f2c899f814d60ea75`, fresh assembled static checks,
70 units, 21 chat API checks, 17 browser cases and one configured-model UAT all exited 0.
The root audited the recorded source manifest, image, receipts, cleanup and remote equality.
See [the public integration receipt](https://github.com/motioneso/moss/pull/3154#issuecomment-6084804308).
These scoped receipts certify those exact inputs and scenarios; they do not certify this
new documentation fingerprint, all callers, branch-wide CI or any reminder implementation.

CI tested synthetic merge `06143bf67cb5a402e2dc4f0463a383b871c5891b`, combining main
`5e17e32e616b1626d6eb4f26a1d37bf10a9be4b7` with `fd134`. It failed three Chat/Meeting
unit assertions, the owner-Main hydration browser interaction with removed History, and
Meetings private-to-persistent UAT with removed History. The bounded read-only diagnosis
reproduced the three units at `fd134` (three failed, 50 passed); the relevant chat/Meeting
source and failed tests were unchanged between that tip and the synthetic merge.
Do not classify these failures as preexisting or flaky, or describe #3126 as complete.

The first assembled configured-model UAT at `81decfb143` failed after phone reload with a
CSS preload error and detached Conversations control. Later original-UAT and temporary
phone-cycle passes did not establish its cause or a fix. Keep that failure visible during
fresh proof and final review; stop on a new failure and preserve its actual inputs.
The Chat diagnosis and #3149 fit audit changed no product source and executed no reminder.

## #3191 — caller starter through provider availability

Own the smallest shared bound-draft/Composer correction and every affected caller/fixture,
preserving the existing #2939 starter behavior.
The observed first-render starter is initialized empty and seeded by effects; unavailable
routing can therefore show Connect a provider before the starter becomes visible. Treat
lazy initialization as a candidate to verify, not an established fix.

Preserve first-render/hydrated coverage, delayed caller arrival, real saved-provider changes,
originating thread/privacy/generation, genuine edits, explicit clear, navigation retirement
and saved drafts. A restored starter must never overwrite user edits or leak after navigation.
Selector ownership and the wider Conversations migration belong to subsequent tasks.

Reproduce the existing assertion before changing source. Run complete affected unit suites
and relevant static/types/design/app-map checks. On an isolated installed instance, use
real saved provider configuration and an actual chat/draft to enter unavailable-provider
state, keep the text editable/recoverable, restore availability and continue. Record the
real setup and exact check/runtime inputs; response rewriting is not proof of a transition.

## #3192 — owner Main and authorized histories

Own the picker, authenticated owner identity/API projection, all selector callers/fixtures,
owner-Main hydration browser interaction and affected #3125 fixture/real Main UAT paths.
Current picker selection by first `isMain` and removal of every Main-marked row differs
from stable owner-Main binding. Ordering alone must never select the owner's Main.

Prove ordering/access negatives, keep genuinely granted foreign histories in Conversations
and exclude unauthorized rows. Preserve accepted dock/overlay, focus restoration, inert
background, keyboard/Escape/outside-close, mobile behavior and separate drafts. Add no new
sharing capability and do not change the persistent Main designation.

Exercise the full affected unit/browser/API/static suites. In actual installed data, create
an owner Main and a genuinely granted foreign history, open owner Main first, switch through
Conversations, return and reload without changing Main or drafts. Run updated #3125 fixture
and configured-model proofs and the original #3126 Main/side UAT; disclose external fixtures.

## #3193 — complete Conversations caller repair

Own all remaining stale production/test interactions and their genuine outcomes at the
repaired tip. The diagnosis found ten UAT spec files with twelve old interactions across
private #1089/#1090, #3125 fixture/real, #2942, #2950, #2984, #2809, Notes default/path and
#3065 real scenarios. Reconcile this inventory after #3192 so migrated files are accounted
for and no affected caller is silently omitted.

Exercise actual Conversations → New side chat rather than restoring History/New chat or
renaming labels to pass. Preserve module-specific new/clear context, late-success/failure
generation protections, private-mode clearing, stable Main and transcript separation.
A genuine old Meeting result must not overwrite a new context. Resolve generated titles
from actual persisted identities; message text is not a guaranteed conversation label.

Reproduce late-result and private/persistent protections. Run complete affected unit/browser/
API suites and every changed installed Main/private/Meeting/Notes/app-action UAT scenario.
Record the exact suite inventory, commands and outcomes. Revalidate whole-session fit before
coding: if this complete caller set exceeds one fresh session, stop and reslice before dispatch.
Final assembled integration must independently run the relevant complete suites; this task
cannot serve as a deferred hardening or proof substitute.

## #3194 — durable relative reminder and informed follow-up

Own a complete chat-module reminder path using existing actor-scoped queue/transaction,
public persistence and context admission seams. Request/list/cancel in ordinary chat, close/
reopen, receive exactly one durable assistant-only result in stable owner Main, and reply
with the configured model actually informed of it. A result arriving during an unrelated
live reply must persist safely. Confirmation and app-map describe saved-history delivery;
immediate background stream delivery is reserved for #3195.

Accept one explicit numeric relative duration in seconds/minutes/hours/days, totaling integer
1–2,592,000 seconds, and fixed text of 1–500 characters. Bound queued plus delivered-but-not-
yet-admitted reminders to 20 per owner; provide recoverable capacity/unsupported feedback.
No local-clock time, deadline, recurrence, source checks, Settings, outward notifications or
external action is supported here. Keep scheduled responsibilities separate from ordinary Tasks.

Required safety and lifecycle, all shipping in this task:

- Capture immutable authenticated actor, owned nonprivate ordinary thread/surface, turn ID,
  original raw request and cancellation signal before AI/retrieval/tool output. Use a bounded
  recognizer for explicit relative intent; derive timing/text from that server-held request.
  Direct save applies only to that exact current intent. Reject missing/stale/foreign/stopped,
  private/module, suggested/ambiguous and unsupported intent. Prevent generic app-call mutation
  from bypassing the check; preserve unrelated live-write approval policy. Neither model tool
  arguments nor source content establishes user authority.
- Under the owner-capacity lock, save the task/version/create-intent identity, stable owner Main
  destination and reserved unique assistant-message ID. Enqueue metadata-only work atomically
  using existing `scopedJobDatabase`, `startAfter` and run identity. Database identity enforces
  repeated-intent safety; queue singleton suppression alone is insufficient.
- In the worker's actor transaction, lock the exact task and recheck owner/state/version/due/
  eligible owner Main. Persist the reserved assistant-only result through chat's public API
  and mark delivered/pending-context in the same transaction. No fabricated user row, model,
  network or instruction execution occurs there. Test rollback/retry/concurrent workers and
  committed replay; posting and delivery state must not diverge or duplicate the message.
- Cancel under the same row lock. Cancellation accepted before posting prevents it; after
  posting commits, report already delivered. Check both linearization orders and an active
  job paused before posting, not just queue deletion. Preserve earlier messages. Recover one
  missed due reminder at most once with honest late wording; record/test a small late threshold
  against polling bounds. Quiet hours do not defer chat persistence.
- Before the next accepted Main user prompt, admit the complete bounded pending batch for
  that exact actor/Main as framed prior assistant conversation through existing provenance
  admission and framing neutralization. Never seed a separate prompt during active work.
  Bind the snapshot to exact message IDs; acknowledge only those IDs after successful model
  turn completion/storage. Failure/Stop retains pending results; arrivals after the snapshot
  remain pending. Warm retained sessions and cold replay both work; side/private/module turns
  neither consume nor acknowledge Main's batch. Timestamps are not a safe acknowledgement cursor.

Current fit candidates are a narrow public assistant-only repository operation, focused
chat-owned reminder service/repository/routes/tool/jobs/SQL, shared REST/database contracts,
queue/manifest registration and scoped current-intent composition. Keep large runtime/registry
files as composition. Discover all gateway/origin/classifier, lifecycle/persistence/context,
API startup and worker composition callers/fixtures. The trusted intent service and native
gateway authority decision do not exist yet; prove the full dispatch path, not just a schema.
Never fake an external tool or relax all write approvals. General compaction stays #3156/#3157.

Demonstrate early with real configured-model UI: request a near-future reminder, reopen and
verify one saved assistant result, zero fabricated user trigger and real recall of a harmless
unique reminder fact on warm and cold paths. Browser reopening alone does not prove provider
restart. Cancel another and verify absence beyond due. Deliver during a genuine ongoing reply
without stream injection; after completion/reload assert both persisted IDs/bodies and next-turn
recall. Include controlled real worker downtime and honest late recovery. This read-only fit
assessment is conditional on repaired integration; revalidate seams and full session fit there.

### #3194 reslice (published 2026-10-09)

The #3194 lane stopped before coding: no trusted current-intent capture exists, the worker
role cannot insert chat messages, the chat session manager and routes file are each at 999
lines, and warm admission needs a new gateway path. #3194 stays open as the parent of:

| Issue | Outcome                                                                    | Blocked by   |
| ----- | -------------------------------------------------------------------------- | ------------ |
| #3309 | Save one requested reminder; worker delivers it once to owner Main history | #3125, #3126 |
| #3310 | List and cancel, with honest after-delivery answers                        | #3309        |
| #3311 | Next Main reply admits the delivered batch, warm or cold                   | #3309        |

#3195 is now blocked by #3309 and #3311. #3310 and #3311 may run in parallel.
Intent authority stays the bounded server-side recognizer above. Until #3311 lands, delivered
reminders remain pending-context and count toward the 20 cap; only cancel drains them. This is
accepted because the integration branch does not ship before #3311.

## #3195 — immediate arrival with exact message identity

Own the smallest proven worker-to-API transport for already committed results, selected owned
Main gating, server/shared stream identities, ordinary post-store emissions, SSE parser and
browser correlation/hydration/reconnect callers/fixtures. Cross-process transport is unchosen
and unproven: an existing in-process notifier does not establish worker delivery. Revalidate
its implementation and complete session fit at the verified #3194 integration tip before coding.

Deliver only committed messages to their authorized owner while the owned Main is selected.
Side/private/module surfaces retain drafts/focus and do not receive Main results. Ordinary
turns and background messages carry exact identities; replace an unsaved live reply only
when its identity matches. History/reconnect deduplicate both replies. Retrying delivery
never reruns the reminder. Preserve #3194 cancellation/version/idempotency and warm/cold
admission/acknowledgement, extending live-arrival/context/reconnect races. Visible arrival
does not prove provider consumption or change current-user authority.

In actual configured-model UI, let a reminder fall due beside a genuine streaming Main reply,
observe immediate distinct messages, reload/reconnect and verify both persisted identities
and a normal subsequent reply. Switch side/private surfaces around delivery and prove
suppression plus preserved draft/focus. Replay job/delivery and assert zero duplicates.

## Completion, checks and single-session stops

Each task uses a new isolated fresh TDD session from current committed integration. Before
coding, discover complete callers/fixtures/config/exports through graph-first inspection and
bounded actual source reads. Existing indexed snippets can be stale; confirm changed seams
in the assigned checkout. Include implementation, checks, independent Standards then Spec
review/fixes, installed proof, safe committed evidence and resource teardown in that session.

Run behavioral red/green checks at approved public seams and meaningful boundary negatives
with enforcement removed. For reminders include owner/current-intent/source-forgery, rollback/
replay/concurrency, cancellation/version and context snapshot/Stop/failure tests; #3195 extends
owner/surface/correlation negatives. Follow changed contracts into all callers and fixtures.
Run scoped lint/format, root/tests/web types, file-size, dependencies, migration/manifest/queue,
app-map and design checks as applicable, plus the relevant complete foundation/static/unit/
browser/API suites. DB-touching gates run only via `verify-gate`/`run-gate` on isolated databases.
Serialize heavy checks. A docs-only reslicing commit needs bounded format/link/diff/safety
checks and byte comparison, not another expensive or DB gate.

Truthful product app-map declarations ship with each runtime behavior change, including
requirements/errors/remediations and saved-history versus live delivery. Use accepted authored
UI primitives and preserve approved accessibility, desktop/phone and theme behavior. Record
exact clean source, harness/helper inputs, built image, commands/exits and actual assertions;
old receipts remain historical input evidence. Rebuild changed runtime artifacts from the
actual source and use only dependency reuse from retained images. No screenshots, rewritten/
replayed Moss responses or printed private/model content. Keep credentials, personal data,
private hostnames/addresses/model identifiers and raw logs outside the public repository.

Claim dev ports through `devports` in 5180–5299 and release only task-owned ports/resources.
Preserve other agents' edits, stopped reservations and images; avoid global cleanup. Report
through collaboration to `/root`. Builders do not merge main, deploy, publish registry entries,
close issues, mark PR ready or change board state. Draft [#3154](https://github.com/motioneso/moss/pull/3154)
remains unfinished; final assembled verification and both whole-branch review axes still apply.

Stop before coding if a complete outcome plus its checks/review/live proof no longer fits one
fresh session, if required safety would be postponed, or if reuse needs a provider runtime,
gateway or queue replacement. Return a bounded fit report and complete vertical reslice to
/root for publication and a committed plan before another lane starts. Do not relay one oversized
ticket across repeated sessions. Stop and preserve a new failed proof rather than retrying it
into an unsupported green claim. Parent acceptance and approved migration/UI choices remain.
