# Scheduled tasks and proactive messaging — proposed implementation tickets

Status: **for user review; not published, ready for dispatch, or approved for implementation**.
Source: [reconciled feature spec](../specs/2026-10-07-scheduled-tasks-and-proactive-messaging.md), [#3096](https://github.com/motioneso/moss/issues/3096), accepted mockups #3100–#3103. Related [#2388](https://github.com/motioneso/moss/issues/2388) remains open; reconcile its overlapping scope when publishing approved tickets, without silently closing or rewriting it.

The numbers below are proposal identifiers, not GitHub issue numbers. Each ticket delivers a complete narrow behavior through storage, authenticated APIs, the real UI/worker path, checks and review in one fresh session. There is no schema-only, UI-only, final-hardening or final-proof ticket. A slice ships only the responsibility types it actually supports; it must not advertise later slices as available.

## Recommendations requiring review

These fill gaps left by the mockups; they are proposals, not retroactive design approvals.

- **Existing main conversation (#1):** designate the most recently active eligible persistent app conversation once on upgrade; preserve the other eligible transcripts as side chats. Do not repurpose incognito or module-specific surfaces. Create Main chat only when none exists. Later activity never changes the designation. Validate the actual eligibility rules against current storage before migration.
- **Email choices (#4):** reuse the existing email source preference instead of adding a competing switch. An explicit legacy source-off or master-off keeps automatic email alerts off; no saved applicable choice defaults on. A saved master-off must not disable user-requested tasks. Do not infer explicit consent from fallback defaults; distinguish absent records from saved records and disclose unavoidable legacy ambiguity in the migration review. Turning the email switch on must not enable unrelated legacy sources.
- **Quiet hours (#5):** use the existing timezone-capable Profile preference as canonical storage, with existing surfaces linking to Alerts & quiet hours. Carry forward a sole saved value or identical saved values. Different saved values, including enabled/off disagreements, require the accepted explicit choice; keep prior effective policies until resolution. Preserve the existing Profile default when no saved preference exists; the mockup’s Pacific schedule is sample data.
- **Legacy caps and cards (#14):** preserve saved source/global caps for unsolicited email findings; requested tasks use their own bounded cadence and do not spend the unsolicited-email budget. Persist a useful selected chat result immediately during quiet hours; defer only its outward interruption. Share finding identity/budget accounting with legacy scanning so the same finding does not produce duplicate proactive surfaces/notifications. Preserve existing non-email card behavior. The concrete cap accounting and treatment of unsaved defaults must be settled in #14’s implementation plan before coding.

Review these four recommendations alongside ticket size and dependencies. Module ownership, minimum polling cadence, active-task limits and bounded read-retry policy are engineering choices to record in the relevant ticket before implementation, using existing facilities where possible. They must not quietly narrow an accepted user scenario.

## Existing seams to reuse

Graph/source inspection at main revision `d47136ad9` confirms timezone/keyed pg-boss briefing schedules, owner-scoped proactive preferences and notification deferral. It also confirms chat record injection emits a record without persisting it and notification urgency currently skips quiet-hours deferral. These are reuse candidates and gaps, not proof that background delivery or explicit exceptions already work.

Prefer the existing chat persistence/provider routing, actor-scoped job queue, authorized module APIs, timezone scheduling, source scanning, notification delivery and authored Settings/chat primitives. Keep scheduled assistant responsibilities distinct from ordinary to-do items. Do not build a second scheduler, workflow engine, connector, approval UI or generic framework. Re-read the actual branch before implementing; the spec branch predates this inspection.

## Proposed tickets

### 1. Keep a stable Main chat and preserve existing history

**Blocked by:** None.

**What it delivers:** reopening Moss returns to the same durable main conversation; upgrade preserves existing conversations rather than assigning Main chat by latest activity on every visit.

- [ ] Persist an owner’s main designation and perform the reviewed one-time migration without losing transcripts; repeated upgrades are idempotent.
- [ ] Reload/reconnect retains visible history and the same main identity. Other owners cannot select, read or mutate it.
- [ ] Preserve unselected histories for the side-chat selector in #2; module/incognito semantics remain explicit.

### 2. Open and switch topic side chats in the accepted overlay

**Blocked by:** #1.

**What it delivers:** users open New side chat directly to typing and switch between separate transcripts in the closed three-line overlay, sharing their owner memory/preferences.

- [ ] Preserve the 380px dock, automatic titles, existing histories and desktop/phone overlay behavior; no title-entry dialog or update banner.
- [ ] Switching preserves drafts/focus and does not change Main chat. Overlay supports keyboard entry, Escape/outside close, inert background and focus restoration.
- [ ] Reload retains identities and separate transcripts; owner isolation applies to selection, memory and messages.

### 3. Continue Main chat through invisible provider context changes

**Blocked by:** #1.

**What it delivers:** a long conversation keeps its visible history and usable decisions while provider context is compacted or handed off.

- [ ] Reuse provider-supported compaction where available; otherwise use the smallest capability-routed handoff that retains relevant context and conversation identity.
- [ ] Exercise a forced context transition and restart/reconnect; no technical restart message, lost completed turn or fabricated turn.
- [ ] Relevant prior decisions remain usable. Saved responsibilities, once introduced, load from durable records rather than depending on a summary remembering them.

### 4. Consolidate automatic email-alert choice without losing saved preferences

**Blocked by:** None.

**What it delivers:** the real Alerts & quiet hours surface offers one persisted Automatic email alerts choice, independent of email access and existing delivery settings.

- [ ] Apply the reviewed legacy email/master mapping, preserve saved off, and distinguish missing records from saved choices. Fresh eligible users have default-on intent; #14 adds chat delivery.
- [ ] The existing email scanning entry point respects the effective off choice. Turning it on neither grants/reconnects access nor enables other proactive sources.
- [ ] Show email/delivery together, existing module/device/digest controls, saved-off, disconnected/revoked, loading and retryable load/save errors. Use accepted column/phone layout.

### 5. Use one quiet-hours control and reconcile conflicting saved schedules

**Blocked by:** None.

**What it delivers:** users manage one timezone-aware quiet-hours preference through the accepted Settings surface; conflicting legacy schedules require an explicit choice.

- [ ] Apply the reviewed migration/default rules; old effective policies continue until a conflicting choice saves successfully. Existing control surfaces link to the canonical surface.
- [ ] Validate timezone/start/end, overnight windows and equal-time rejection; test local boundaries/DST. Failed saves preserve the effective setting and editable draft with nearby recovery feedback.
- [ ] Existing relevant notification/proactive consumers read the resolved preference. No model-urgency exception is carried into the new scheduled/proactive path.

### 6. Save, inspect and deliver one requested reminder while the app is closed

**Blocked by:** #1, #5.

**What it delivers:** a user asks for a fixed-text reminder, receives an ordinary local-time confirmation, inspects/stops it in Settings, and receives one durable replyable Moss message when due.

- [ ] Save directly with no card/second approval. Own the record and metadata-only queued job; this slice invokes no model tools or change/deletion actions.
- [ ] Introduce Reminders icon/title rows, compact details/history and Past tasks, with loading/empty/error and active/paused/completed/expired states. Pause/resume/delete work in Settings and chat; deletion focuses Keep task and retains old messages/effects.
- [ ] Post an assistant-only message with stable message/run identity; reload/reconnect and normal reply work. A simultaneous live reply retains its own identity and content.
- [ ] Quiet hours defer outward interruption while the message persists immediately. Module/device mutes win; delivery retry cannot repeat execution/message creation.
- [ ] A queued or in-flight paused/deleted reminder cannot initiate further effects. A missed reminder delivers once as clearly late unless expired; replay/concurrent workers cannot duplicate it.

### 7. Edit saved responsibilities through ordinary chat

**Blocked by:** #6.

**What it delivers:** a user changes a reminder’s instruction, local timing or deadline in chat and sees the same updated record in Settings, without a Settings editor.

- [ ] Use the normal composer and natural confirmation; retain no competing Edit form/button. Resolve which task is being edited when unclear.
- [ ] Changes invalidate stale queued instructions; check current version/state before effects and result posting, including an edit during a run.
- [ ] Timing-only changes do not add approval. Unsupported capabilities are explained honestly; #12 adds renewed agreement for changed action scope.

### 8. Run recurring reminders at the saved local cadence

**Blocked by:** #7.

**What it delivers:** daily, weekly and more-frequent reminders can be created/edited in chat and managed in the matching Settings groups.

- [ ] Extend the reminder path with timezone-aware cadence, next-run details and bounded active schedules using the existing queue; no second scheduler.
- [ ] After downtime, deliver one fresh due reminder/check outcome and resume saved cadence, without replaying every missed interval. Respect deadlines, pause/resume/edit/delete and duplicate-run prevention.
- [ ] Exercise daily/weekly boundaries and DST policy; demonstrate ordinary creation, execution and history through the real UI.

### 9. Check sources in the background and speak only when useful

**Blocked by:** #8.

**What it delivers:** a recurring read-and-report request runs while the browser is closed and sends an ordinary sourced message only for a useful new or materially changed finding.

- [ ] Add the smallest isolated background model/tool path using configured capabilities and authorized source APIs; never fabricate a visible user turn or contaminate live-chat authority/context.
- [ ] Successful empty/unchanged checks stay silent and have distinct history from failures. Persist observation/run/result identity so repeated scans, reload and delivery replay do not duplicate messages.
- [ ] Retry transient read failures quietly with bounded backoff; repeated failures produce actionable status/message. Interrupted read checks reconcile once after downtime, then resume cadence.
- [ ] Enforce current access, read-only authority, source trust boundaries, actor isolation, queue metadata constraints and task lifecycle before effects/posting. Work and useful message persistence continue during quiet hours.
- [ ] Include local polling/task limits and failure bounds in this ticket’s plan; preserve existing briefing behavior and avoid duplicate scheduled ownership.

### 10. Watch for a condition and stop from reliable completion evidence

**Blocked by:** #9.

**What it delivers:** an explicitly requested, optionally time-limited watch reports a matching condition and closes once its actual goal is established.

- [ ] Demonstrate a matching email-arrival goal through an existing authorized source; store goal/evidence/deadline and display Watches, useful details/history and completed/expired Past tasks.
- [ ] Explain closure once and stop future runs. Expired watches execute nothing; unfulfilled goals remain active until deadline or explicit stop.
- [ ] An alert or webmail click never proves reading. Explicit owner “I’ve read it” can complete a reading goal; unknown provider read state remains unknown.
- [ ] Email evidence opens the actual connected provider’s webmail in a new tab. Cancellation, repeated findings and competing workers cannot duplicate closure or future effects.

### 11. Suggest a responsibility and save it only after typed agreement

**Blocked by:** #10.

**What it delivers:** Moss can propose a useful supported reminder/check/watch in ordinary chat; agreeing creates a working responsibility, declining creates none.

- [ ] No suggestion card, review panel or approval buttons; use the normal composer and natural saved confirmation.
- [ ] Ambiguous replies or changed proposal terms do not accept the old proposal. Agreement binds to the current proposal and repeated submission creates at most one task.
- [ ] Pending proposals survive the supported reconnect flow without gaining authority or becoming scheduled on their own; expose only implemented responsibility types.

### 12. Approve scoped changes/deletion once and run without asking again

**Blocked by:** #9 (includes #7’s edit/version handling).

**What it delivers:** a user approves a stated action set in ordinary chat, including deletion where requested, and its scheduled run uses only that authority while the user is absent.

- [ ] A creation-time chat question enumerates changes/deletion. Typed agreement binds to the saved task version/scope; decline or revised actions leave it unsaved. Editing actions requires fresh agreement; timing/destination-only edits do not.
- [ ] The real action gateway permits only the stored set plus current grants, refuses and reports other effects without prompting, and isolates background outside-content state from the destination conversation. Live-chat approval rules stay unchanged.
- [ ] Disabled/revoked capabilities and observed instructions cannot widen authority, recipient or quiet-hours permission. Inspectable scope remains in Settings.
- [ ] Mark a run as having started an effect before initiating it. After any write/deletion begins, failure or uncertain outcome is never automatically rerun; history/message gives an actionable reconciliation step. Posting/delivery retry cannot repeat the model’s actions.
- [ ] Exercise a real supported bounded action and the deletion boundary with safe test data; prove stale edit/delete races and cross-owner/source-authority denials at the actual gateway.

### 13. Allow only a user-named task during quiet hours

**Blocked by:** #6.

**What it delivers:** users add/remove a task-specific quiet-hours allowance in ordinary chat and inspect it under Allowed during quiet hours.

- [ ] Change in chat targets the named responsibility; persist explicit owner intent and reflect changes across Settings/chat. No global urgency or source-derived allowance.
- [ ] Only that task bypasses quiet-hours deferral; unrelated work still waits. Module mute and disabled device/channel choices remain effective.
- [ ] Recheck current allowance/task/channel state before notification delivery, including queued changes and removed allowances; never duplicate the already-persisted chat message.

### 14. Deliver useful automatic email updates with an independent off switch

**Blocked by:** #4, #10 (includes #9’s read/check path and enables proof that requested inbox watches continue).

**What it delivers:** eligible users receive useful unsolicited email messages in Main chat, and turning off Automatic email alerts stops those updates while requested inbox watches and other tasks continue.

- [ ] Apply the reviewed legacy cap/card recommendations through existing source scanning and the common background delivery path; avoid duplicate model scans, findings, budget charges and notifications.
- [ ] Fresh eligible users receive default-on behavior; saved off remains off. Disconnected/revoked email stays unavailable without changing the preference or granting access.
- [ ] Updates contain supported useful facts/evidence and connected-provider webmail links. Empty/unchanged findings stay quiet; failures are not reported as successful silence.
- [ ] Persist useful selected messages immediately during quiet hours, defer outward interruption, and respect existing delivery choices. Turning email alerts off does not cancel explicit responsibilities or other sources.

### 15. Deliver a responsibility to an explicitly requested side chat

**Blocked by:** #2, #7 (includes #6’s delivery and supports destination edits).

**What it delivers:** creation or a chat edit can name a side-chat destination; otherwise results still go to Main chat even when the task was created in a side chat.

- [ ] Store the explicit owner-authorized destination, mention it naturally and show it in compact details. A destination-only edit needs no action approval and invalidates stale queued routing.
- [ ] Main-chat arrivals while a side chat is open preserve its transcript/draft/focus without a banner. Explicit side-chat results persist, remain replyable and coexist with a live reply there.
- [ ] Recheck destination authorization/existence before posting. Unavailable targets produce an actionable status rather than silent rerouting or cross-owner delivery.

## Shared acceptance and publication boundary

Every product ticket updates the app map in the same PR, including its real capabilities, settings/navigation, requirements, errors and recovery. Use the authored design tokens/primitives and accepted desktop/phone, light/dark/Teal states. Implement only the supported slice, without importing preview controls or fictional persistence.

Each ticket includes the relevant smallest behavioral checks at existing seams, actor/authority negatives, cancellation/version races and idempotency where it introduces them. Observe security checks failing with enforcement removed. Run the required scoped/full repository checks with the prescribed gate workflow; do not run DB-touching commands against the live dev database. User-facing completion requires real installed UI/worker proof on an isolated dev instance recorded on the PR, with executable assertions and bounded textual evidence. Time-based live proof uses near-future schedules, a current quiet-hours window and controlled worker downtime; deterministic clock/source/model doubles belong in automated checks, not fabricated live responses.

The starting frontier is #1, #4 and #5. After #1, #2 and #3 can proceed independently. #6 waits for stable Main chat and resolved quiet-hours delivery; #13 branches off #6; #15 needs the side-chat and editing flows. #3 is required for the complete feature but does not gate short reminder/model runs, which must not depend on a live provider session. #12 needs the reusable read/check path without waiting for watch/suggestion completion. #14 also waits for a working watch so its independent off-switch can be proven end to end. There is no requirement to start multiple agents concurrently.

Review requested: are the slices small enough, do the blocking edges reflect real dependencies, and should any be merged/split? Also review the four migration recommendations above. Once approved, publish one GitHub task issue per slice in dependency order with native blocking links where available, reconcile the parent/overlap links, and apply dispatch labels only to approved executable tickets. Publication and implementation require subsequent authorization; this document creates neither tickets nor a build fleet.
