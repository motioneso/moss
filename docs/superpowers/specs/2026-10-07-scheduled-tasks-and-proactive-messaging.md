# Scheduled tasks and proactive messaging

Tracker: [spec issue #3096](https://github.com/motioneso/moss/issues/3096).

Status: approved product definition and verification boundary, reconciled on 2026-10-08 with all four accepted mockups (#3100–#3103) and the accepted conversation shell. The [24-ticket implementation breakdown](../plans/2026-10-08-scheduled-proactive-ticket-proposal.md) was approved for publication on 2026-10-08; its four migration recommendations were separately approved during implementation on 2026-10-08, as recorded in the [migration decisions](../plans/2026-10-08-scheduled-proactive-migration-decisions.md). Implementation now follows the [integration state](../plans/2026-10-08-scheduled-proactive-implementation-state.md); no auto-merge or deployment is authorized.

## Problem Statement

Users currently have to return to Moss and ask for updates. They want a chief of staff that remembers responsibilities, works while the app is closed, notices useful changes, and starts a conversation when there is something worth knowing. They also need a clear way to inspect and stop those responsibilities without having to negotiate with the assistant.

A background update should belong to the same ongoing relationship as ordinary chat. Starting another conversation whenever provider context fills up, displaying internal instructions as user messages, or interrupting the user for empty checks would undermine that experience.

## Solution

Moss maintains one continuous main conversation and optional topic side chats. It can execute user-requested reminders, recurring checks, and condition watches in the background. It can suggest a schedule and save it after the user agrees. Useful automatic email updates are enabled by default and can be disabled independently of requested work.

Useful results appear as ordinary, durable, replyable Moss messages, normally in the main conversation. Internal provider triggers stay outside the visible transcript. Quiet hours delay outward interruptions while work continues and results remain readable in Moss. A task can bypass quiet hours only when the user explicitly requests that exception.

Users inspect, pause, resume, and delete accepted schedules and watches through one Settings list or through chat. All task editing happens in ordinary Moss chat. Moss quietly retries temporary failures, distinguishes failures from successful checks with nothing to report, and can close a watch when reliable evidence establishes that its goal is fulfilled.

## User Stories

1. As a user, I want Moss to work while I am away or the app is closed, so that responsibilities do not depend on an open chat window.
2. As a user, I want one continuous main conversation, so that I can return to the same relationship and visible history.
3. As a user, I want provider-context compaction and session transfer to happen invisibly, so that technical context limits do not make me restart a conversation.
4. As a user, I want relevant decisions and ongoing responsibilities retained across context changes, so that Moss can continue useful work.
5. As a user, I want optional side chats for specific topics, so that I can organize conversations.
6. As a user, I want separate side-chat transcripts with the same owner-scoped memory and preferences, so that organization does not create a different assistant.
7. As a user, I want background results in my main conversation by default, so that I have one usual place to find updates.
8. As a user, I want to request a side-chat destination explicitly, so that a topic-specific responsibility can report there.
9. As a user, I want to create a one-time reminder in chat, so that Moss can remind me without another request.
10. As a user, I want Moss to confirm the saved instruction and local timing, so that I understand what will happen and when.
11. As a user, I want recurring checks over connected or available sources, so that Moss can notice useful new information for me.
12. As a user, I want a watch for a condition such as an expected reply or a sale, so that Moss can tell me when the condition is met.
13. As a user, I want a deadline on time-limited watches, so that monitoring ends when it is no longer relevant.
14. As a user, I want Moss to suggest useful schedules, so that I do not have to invent every responsibility myself.
15. As a user, I want a proposed schedule saved only after I agree, so that suggestions do not silently become commitments.
16. As a user, I want a background task never to ask for approval once it is created, so that background assistance remains useful while I am away.
17. As a user, I want the request that creates a task to ask once for the approval its actions need, including deletion, so that I decide what the task may do before it runs unattended.
18. As a user, I want revoked access and disabled capabilities respected, so that a past schedule cannot override my current permissions.
19. As a user, I want useful unsolicited email updates enabled by default, so that Moss can notice important developments without a named watch.
20. As a user, I want to disable unsolicited email alerts separately, so that my requested inbox watches and other proactive tasks keep working.
21. As a user, I want checks to remain silent when nothing useful has changed, so that routine monitoring does not become noise.
22. As a user, I want unchanged findings suppressed, so that I do not receive the same update every hour.
23. As a user, I want useful updates to explain why Moss is speaking and link evidence when available, so that I can judge and act on them.
24. As a user, I want to reply normally to a proactive message, so that an update can become a conversation.
25. As a user, I want internal background instructions hidden from the visible transcript, so that Moss never fabricates a request in my name.
26. As a user, I want a proactive message to coexist with a live reply, so that neither message overwrites or becomes attributed to the wrong turn.
27. As a user, I want work to continue during quiet hours, so that attention preferences do not stop monitoring.
28. As a user, I want quiet-hours results readable in Moss while outward interruptions wait, so that I can choose when to look.
29. As a user, I want to explicitly allow a particular alert during quiet hours, so that a responsibility I choose can interrupt me.
30. As a user, I want Moss's urgency assessment to respect quiet hours, so that only my explicit instruction creates an exception.
31. As a user, I want a compact Settings list grouped by responsibility type, with instruction, useful timing and recent status in expandable details, so that I can scan and understand my standing responsibilities.
32. As a user, I want to inspect, pause, resume, and delete a responsibility directly in Settings, so that I can stop work without chatting.
33. As a user, I want to edit responsibilities through ordinary Moss chat and use chat controls for the same records, so that there is one editing flow and both interfaces reflect the current truth.
34. As a user, I want deleted, cancelled, or paused work prevented from firing again, so that a queued run does not ignore my control.
35. As a user, I want temporary failures retried quietly, so that transient problems do not cause unnecessary interruptions.
36. As a user, I want repeated failures explained with an actionable next step, so that I can restore a responsibility that cannot proceed.
37. As a user, I want Settings to distinguish a failed check from a successful quiet check, so that silence does not conceal broken monitoring.
38. As a user, I want retries to avoid repeating completed actions and delivered results, so that recovery does not cause duplicate effects.
39. As a user, I want Moss to recognize a fulfilled watch goal and tell me once that it stopped, so that completed responsibilities do not keep running.
40. As a user, I want watch completion based on reliable evidence rather than alert delivery alone, so that monitoring does not stop before my actual goal is met.
41. As a user, I want completed and expired watches to remain inspectable, so that I can understand why work stopped.
42. As a user, I want one fresh recurring check after downtime, so that Moss resumes useful work without replaying every missed interval.
43. As a user, I want missed one-time reminders clearly marked late and expired instructions skipped, so that catch-up work does not mislead me.
44. As a user, I want my background work, memory, and messages confined to my authorized scope, so that another user's data or conversation cannot be used or exposed.
45. As a user, I want observed email and web content treated as information rather than authority, so that it cannot grant permissions, change recipients, or bypass quiet hours.
46. As a user, I want results to stay in Moss for this feature and existing notification preferences honored, so that proactive assistance does not unexpectedly introduce a new messaging channel.
47. As a user, I want task creation, proposals and approval questions to use ordinary chat text and my normal composer, so that scheduling does not introduce a second task interface.
48. As a user, I want completed and expired tasks under collapsed Past tasks, so that historical responsibilities remain inspectable without cluttering the active list.
49. As a user, I want dated run history and a way to open an available result message, so that I can understand what a responsibility actually did.
50. As a user, I want one Alerts & quiet hours surface that preserves my saved choices and asks me to resolve conflicting schedules, so that consolidation does not silently change when Moss interrupts me.
51. As a user, I want a disconnected email source and failed preference save explained with a recovery action, so that I can distinguish missing access from my alert choice and know which settings are effective.
52. As a user, I want source email links to open my connected provider’s webmail in a new tab, so that I can inspect the evidence without losing my Moss conversation.

## Implementation Decisions

These are required behaviors and architectural constraints, not claims that the existing system already satisfies them. Concrete ownership, schema, and API changes will be chosen during ticketing from the smallest existing seams that can meet this contract.

### Accepted mockups and precedence

The final accepted revisions below govern presentation and user interaction. They supersede initial ticket briefs, comparison layouts, and earlier review recommendations where those differ. These are fictional browser-only previews: acceptance proves the design, not production persistence, permissions, provider evidence, timing or concurrency. Implement the accepted behavior with production primitives; do not merge the throwaway branches wholesale.

| Design                            | Accepted reference                                                                                                                                                                 | Decisions carried into this spec                                                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #3100 — create and approve        | [Ordinary-chat creation notes](https://github.com/motioneso/moss/blob/3fd2a152ec43e3f9606d017b40ea224247d437e9/apps/web/src/chat/scheduled-task-creation.prototype.md)             | Normal transcript text and composer; direct requested saves; typed agreement for suggestions and scoped changes/deletion; no task card or approval buttons.                                 |
| #3101 — manage in Settings        | [Approved management handoff](https://github.com/motioneso/moss/blob/2495cf19a/docs/superpowers/handoffs/2026-10-08-scheduled-task-management-design.md), final UI `bfab305ed`     | Grouped icon/title rows, compact details, history, Past tasks, pause/resume/delete; editing only in chat.                                                                                   |
| #3102 — receive proactive updates | [Accepted ten-situation preview](https://github.com/motioneso/moss/blob/49a2dbed664318e58597911873d4d0fa897279a4/apps/web/src/chat/proactive-updates.prototype.md)                 | Ordinary sourced/replyable messages, evidence-based completion, quiet checks, late/expired/recovery/failure states, no automatic rerun after a started change, live/background coexistence. |
| #3103 — control interruptions     | [Accepted final interruption preview](https://github.com/motioneso/moss/blob/98336045fc858cf7dc8d9e31b0a4edc88d7e3b88/apps/web/src/settings/interruption-preferences.prototype.md) | Two columns with phone stacking, saved-off preservation, explicit quiet-hours conflict resolution, task-specific allowances and existing delivery controls.                                 |

All four mockups were accepted by the user on 2026-10-08. The #3103 source notes/tracker still contain an earlier “ready for review” status; the later user acceptance and this reconciliation supersede it. The legacy preference mapping and caps were separately approved during implementation, as recorded in the [migration decisions](../plans/2026-10-08-scheduled-proactive-migration-decisions.md); ticket publication itself did not approve them.

The inherited [conversation-shell decision](https://github.com/motioneso/moss/tree/prototype/main-side-chat-navigation) uses the existing 380px dock and a closed three-line overlay menu. New side chat opens directly to the composer; Moss generates its title from conversation content. No title dialog or main-chat update banner is introduced. Opening/closing the overlay preserves focus, Escape/outside-click behavior and an inert underlying transcript while open.

### Ordinary-chat creation and approval

- Requested reminders and read-and-report watches save directly when their required details are known. Confirm the saved outcome in natural language, including relevant local timing and stop conditions.
- A Moss suggestion is an ordinary question, answered through the normal composer. Agreement saves it; decline saves nothing. A response changing the proposed actions is a revision, not approval of the old proposal. Resolve ambiguous responses before saving approval-dependent work.
- Explain the proposed changes/deletions once in ordinary chat and bind agreement to that action set. No task sheet, special summary, receipt, review panel, separate approval buttons, or second generic confirmation step.
- Omit redundant Main chat destination and routine-action summaries in ordinary confirmations. Mention an explicitly requested side-chat destination and relevant deadlines naturally. Keep full agreed authority in the stored record and inspectable details.

### Conversation identity and context

- Designate a stable main conversation for each owner. Recent activity in a side chat must not silently redefine the main conversation or a task's destination.
- Keep durable visible history distinct from a provider's active session/context. Compaction or handoff must preserve conversation identity, relevant decisions, and ongoing responsibilities while remaining invisible in the transcript.
- Side chats have explicit identities and separate transcripts. They use the same owner-scoped long-term memory and preferences; this does not mean copying every side-chat transcript into every other provider context.
- Save the delivery destination with the accepted responsibility. Default to the main conversation even when creation happened in a side chat; honor an explicit side-chat request.
- A proactive assistant message must persist, appear after reload or reconnect, and support a normal reply. Streaming and persistence must identify the correct turn/message so background delivery cannot replace an unrelated live response.

### Responsibilities and user controls

- Support one-time tasks, recurring checks, and condition watches. A watch can be time-limited and can end when its requested goal is reliably fulfilled.
- Persist the agreed instruction, owner, timing or trigger, destination, approved actions, relevant notification exception, and lifecycle state. Represent enough execution status to distinguish a successful quiet run, an actionable result, and a failure.
- Confirm saved timing in the user's local time zone. Reuse existing timezone-aware scheduling where suitable; resolve time-zone and daylight-saving behavior explicitly in the relevant ticket rather than treating local times as server time.
- Create a Moss-proposed schedule only after agreement. The initial explicit user request is already authorization to save the requested schedule; do not add a second generic approval step.
- When a task will change or delete anything, the creation confirmation lists those actions, deletion included, and saving the task approves them. Reminders and read-and-report tasks save without an approval step. Editing a task's actions asks for approval of the new set; editing only its timing or destination does not.
- Settings and chat manage the same records. Settings supports inspection, pause/resume and deletion; no Edit button or editing form. All edits happen through ordinary Moss chat, including changed actions that require renewed agreement.
- Group active list rows into Reminders, Daily, Weekly, More often and Watches. A flat contextual icon and title identify each row; selecting it reveals compact details. Keep completed/expired responsibilities under collapsed Past tasks until deleted.
- Details contain instruction, state, useful timing, specific watch deadlines, non-default destinations, inspectable approved change/deletion scope and actionable failure guidance. Omit redundant source labels, default Main chat, indefinite duration and obsolete future scheduling facts on past tasks.
- Show dated, expandable run history distinguishing useful results, quiet successful checks, failures and uncertain changes. Offer View message when a recorded result exists. Pause/resume/edit/delete controls are management actions, not task runs.
- Confirm Settings deletion with focus initially on Keep task. Deleting the schedule leaves previous messages and completed actions intact.
- Pausing prevents future runs until resumed. Editing or deleting work must invalidate stale queued instructions. Cancellation/deletion prevents future firings without undoing completed actions; check current task state before execution and before initiating further effects.
- Stop a fulfilled watch and tell the user once. Completion criteria derive from the user's goal and available reliable evidence. A matching reply arriving can fulfill an arrival goal. Alert delivery or opening webmail does not establish a reading goal; explicit user confirmation such as “I’ve read it” can fulfill that goal. Without provider read-state evidence or user confirmation, keep it active until its deadline or another explicit stop condition.
- Updates and closure/failure explanations use ordinary assistant messages, with normal replies and evidence links where available. Email links open the actual connected provider’s webmail in a new tab; Gmail in the preview is sample data. No background trigger, fabricated user message, or special update card appears.
- A main-chat update arriving while a side chat is open must not change its transcript, interrupt with a banner, discard its draft, or steal focus. The update is available on returning to Main chat.

### Background execution and permissions

- Extend existing actor-scoped workers and provider routing where suitable. A closed browser must not prevent work. Use the user's configured provider capabilities; do not hardcode an AI vendor or model.
- Add an explicit background execution/delivery entry point that accepts trusted internal intent without creating a visible user turn. A hidden instruction is not a hidden grant of authority.
- Background work must act within the owning user's current access and enabled capabilities. Reuse declared module APIs/events and existing action authorization; do not query another module's private tables or introduce an admin bypass.
- Approval happens once, at task creation (user's ruling, 2026-10-07). A background run never asks for approval, including for deletion. Its authority is the set of actions approved at creation, stored with the task.
- The action gateway allows a background run only the actions approved at creation. It refuses any other write or deletion without asking, and the run's result says what was refused. Revoked access and disabled capabilities still win over a stored approval.
- Background runs do not use the live-chat rule that writes ask once outside content has been read ([#3065](https://github.com/motioneso/moss/issues/3065), `2026-10-05-moss-acts-through-app-design.md`, "Run or ask"). The creation-time approval replaces it for background runs only. Live chat keeps that rule unchanged. A background run's outside-content state stays on the run and does not mark the destination conversation.
- Observed source content cannot alter permissions, recipients, approved actions, or quiet-hours exceptions. Those come from authenticated user controls and agreed task instructions, with enforcement outside untrusted source text.
- Accepted risk: within an approved action, untrusted content can still influence which items the action touches, such as a planted email posing as a newsletter in a "delete newsletters" task. The Settings list, where the user can inspect, pause, and delete the task, is the control.
- Keep queue payloads metadata-only: actor/resource identifiers, job kind, idempotency key, and small command parameters. Retrieve private content and instructions through authorized application paths at execution time. Credentials and secrets must not become prompts, job payloads, frontend responses, or logs.
- Separate execution outcome, persisted conversational result, and outward notification delivery. A notification failure must not cause a completed action to run again. Use existing idempotency facilities where they fit; uncertain external-action outcomes need reconciliation rather than blind replay.

### Usefulness and attention

- A requested fixed reminder is a useful result when due. A recurring information check sends a message only for a useful new finding or a meaningful change. Persist enough observation/result state to suppress unchanged repeats.
- Automatic email alerts default on only when there is no saved email-alert choice and the source is available and permitted. Preserve saved email-off choices, including applicable legacy master/source-off choices; never silently enable them during migration. This preference does not connect an account or grant missing access. Turning it off disables unsolicited email updates only; explicitly requested watches and other tasks retain their own controls.
- Automatic email updates should contain relevant, supported information, such as a requested-action deadline, and evidence links where available. Avoid claiming urgency or facts unsupported by the inspected source.
- During quiet hours, continue work and persist useful messages immediately for reading in Moss; delay outward interruptions through the existing notification preference machinery.
- Only an explicit user request for the particular task/alert can create a quiet-hours exception. Do not inherit a general urgent-notification bypass merely because Moss labels a result urgent. Respect other notification preferences and disabled channels.
- Keep conversation/results in Moss. Existing app notification delivery may signal those results according to existing preferences; this spec does not add Slack, SMS, or another conversation transport.

### Alerts & quiet hours Settings

- One user-facing Alerts & quiet hours surface has email alerts/delivery in one column and quiet hours/Allowed during quiet hours in the other. Use ruled headings and a vertical divider; stack at narrow widths. Keep the accepted concise copy, without the removed tagline or duplicate “work continues” explanation.
- Automatic email alerts is separate from Connectors’ email access grant, per-module notification mute, This device delivery and Email digest. A digest is a separately scheduled summary, not a second unsolicited-email switch. Link existing control surfaces rather than duplicating controls.
- Consolidate quiet-hours control behind one timezone-capable preference. Preserve saved values. If saved schedules disagree, require an explicit choice; do not infer a winner from conflicting defaults or timestamps. Until a choice saves successfully, retain the prior effective behavior. The sample 10 PM–7 AM Pacific schedule is not a new product default.
- Validate local start/end and timezone; reject matching start/end values. Show the effective saved schedule separately from unsaved edits. A failed save retains the old effective preference and editable draft with nearby retry feedback.
- Allowed during quiet hours lists explicit per-task allowances; Change in chat adds/removes them through ordinary requests. Model urgency never adds an allowance, and an allowance cannot override a muted module or disabled delivery channel.
- Include loading, load-error/retry, save-error, empty allowances, disconnected email, revoked access, saved-off and conflicting-schedule states. Retain a saved alert choice while disconnected; explain that no email can be checked until available and permitted.
- The approved UI settles these behaviors. Migration of legacy proactive master/source settings, canonical preference ownership, and the interaction of existing proactive-card caps/deferral with chat delivery were separately approved during implementation in the [migration decisions](../plans/2026-10-08-scheduled-proactive-migration-decisions.md). Ticket publication itself did not approve these decisions, and approval does not establish their implementation.

### Recovery and lifecycle

- Retry transient failed checks quietly with bounded backoff. Repeated failures can create an actionable message and visible status; a failure is never a successful nothing-new outcome.
- Only a run that made no change may retry automatically. A run that has started any write or deletion and then fails ends as failed or uncertain, with an actionable status and message, and is never rerun on its own; rerunning a model run lets it choose its actions again. Delivery of a run's result message is keyed by the run's identity so it appears at most once.
- After downtime, perform one fresh recurring check and resume saved cadence. Do not replay every missed interval or report obsolete source snapshots as current.
- Deliver a missed one-time reminder once with a clear late indication, unless an explicit deadline has expired. Time-limited watches stop at the requested deadline rather than restarting after it.
- Retries and concurrent workers must not duplicate completed actions or delivered results. Exercise cancellation/deletion against queued work, not only against the management UI.

### Existing foundations and gaps

At inspected baseline `60505036c`, Moss has durable completed chat history and provider-context replay, actor-scoped pg-boss jobs, briefing generation, proactive source scanning, and notifications. These are reuse candidates, not an end-to-end proof of this feature.

The current chat chooses a conversation by latest activity rather than a designated main thread. Its rolling summary concatenates and truncates old text rather than performing semantic compaction. Native provider compaction and unfinished-turn crash recovery have not been verified.

The normal turn path records a user message. A record-injection path streams without persistence, while a context-seeding path hides input but discards the response and has an acknowledged live-turn race. None establishes the required durable background assistant turn. The current UI's replacement of an unstored streamed reply also needs turn identity before concurrent proactive delivery can be considered safe.

Briefing background generation is not the live, tool-using Moss conversation pipeline, and ready notifications are not assistant chat messages. General notification quiet hours and proactive-card quiet hours are separate from the inspected chat delivery path. Preserve useful existing behavior while closing these gaps; do not build a second general scheduler or a workflow engine by default.

### Design and delivery constraints

- Main/side-chat navigation and all four feature mockups are accepted above. Carry their desktop/phone, light/dark/Teal, empty, loading, failure, paused, completed and expired states into the production UI using existing design-system primitives. Preview scenario selectors, sample clocks and Run sample buttons are review tools, not product controls.
- Keep the app map truthful in every product slice, including new controls, requirements, errors, and remediations. Do not declare these capabilities shipped in this documentation-only change.
- Split delivery into independently demonstrable vertical slices, each fitting one fresh session including verification and review. Security, cancellation, retries, and live proof belong in each applicable slice rather than a final hardening ticket.

## Testing Decisions

The user approved verification through existing application UI/API and background-worker entry points: save a responsibility, trigger its run, observe durable output or a justified quiet outcome, and operate the same responsibility through Settings or chat.

- Test observable behavior of chat persistence/routing, responsibility management, background execution, email preference separation, notification deferral, and recovery. Avoid assertions about private helper calls or exact model phrasing.
- Prefer the existing integration seams to new testing interfaces. Use deterministic model, clock, and source doubles at those boundaries for reproducible automated checks.
- Existing chat-history/API coverage, actor-scoped briefing worker tests, notification preference/quiet-hours tests, and proactive suppression tests are prior-art candidates. Inspect their applicability before reuse; they do not already prove this feature.
- Prove persistence after reload/reconnect, separate execution from delivery, and exercise real queued-task lifecycle changes. Use explicit identities and observable message counts to detect duplication and active-turn corruption.
- Negative coverage must include hidden-trigger visibility, unfulfilled watch goals, revoked capabilities, an action outside the approved set, cross-user reads/delivery, untrusted source instructions, duplicate execution/delivery, automatic retry after a run has acted, deletion before queued firing, and a proactive message during a live reply.
- For security assertions, observe the test failing when its protection is removed and record the evidence. A passing test that also passes without enforcement is insufficient.
- Every user-facing slice requires live proof through the actual UI on an isolated dev instance, recorded on its PR with executable assertions and bounded DOM/network/log evidence. Automated doubles do not replace assembled live proof; do not rewrite Moss's own network responses to manufacture evidence.
- Spec publication requires document checks only. No implementation tests or live feature proof are claimed by this document.

### Acceptance scenarios

1. **Continuous conversation:** close the app and return to the same main chat with preserved history. Exercise a context compaction/handoff and verify the visible conversation does not restart and relevant decisions/responsibilities remain usable.
2. **Side chats and routing:** create a topic side chat; verify separate transcripts and the same owner memory/preferences. Save a task there and observe main-chat delivery by default, then verify an explicit side-chat destination.
3. **One-time task:** ask for a reminder, observe confirmation of its saved instruction and local timing, close the app, and execute the run. Observe one persisted, replyable assistant message after reopening and no fabricated user trigger message.
4. **Useful recurring checks:** run an hourly significant-AI-news check with no useful new finding and observe successful quiet status without a message. Introduce a significant sourced finding and observe one message. Run again unchanged and observe no duplicate update.
5. **Suggestion and controls:** have Moss suggest an inbox watch as ordinary chat text and verify no saved responsibility until typed agreement. Decline and revised/ambiguous replies must not save the original proposal. After agreement, inspect, pause, resume and delete it in Settings. Edit it through ordinary chat, with no Settings editor; both interfaces must reflect the same record.
6. **Independent email preference:** a useful email update produces a main-chat message by default. Disable automatic email alerts and verify unsolicited email updates stop while a requested inbox watch and an unrelated task continue.
7. **Quiet hours:** run useful work during quiet hours and verify immediate readable chat persistence with outward interruptions deferred. Verify only an explicit task-specific user exception permits a quiet-hours interruption; model-assessed urgency alone does not.
8. **Failures:** fail a check temporarily and observe quiet retry, then a success. Cause repeated failures and observe actionable status/message rather than a successful nothing-new claim. Recovery must not duplicate a delivered result.
9. **Authority and cancellation:** create a task that deletes something and verify the creation request asks once for approval of that deletion. Verify its runs, including the deletion, never ask again, even after reading email or web content. Verify an action outside the approved set is refused without asking and reported, and revoked/disabled capabilities are respected. Delete or cancel queued work and verify it cannot initiate future effects; completed effects remain intact.
10. **Concurrent chat and retry safety:** deliver a proactive message during an active user reply. Verify both messages persist with correct identities and neither overwrites the other. Replay a completed run/delivery and verify no duplicate action or message.
11. **Watch completion:** fulfill the actual goal using reliable evidence and verify one closure explanation and inspectable completed state. Merely delivering an alert or opening webmail must not close a reading goal. Explicit owner confirmation can complete that goal; otherwise it remains active without reliable read-state evidence. An unfulfilled time-limited watch expires at its deadline.
12. **Downtime:** miss several recurring intervals and observe one fresh check followed by normal cadence. Observe one late-marked missed one-time reminder, and verify expired instructions are skipped.
13. **Trust boundaries:** put instructions to change permissions, recipients, or quiet-hours behavior in observed email/web content. Verify they cannot change the accepted task authority. Exercise two owners and verify execution, memory access, Settings controls, and message delivery remain within their authorized scopes.
14. **Ordinary creation and scoped approval:** a requested reminder/read-and-report watch saves with a natural local-time confirmation and no second approval. A change/deletion task states its action set as a chat question; typed agreement saves that set, decline saves nothing, and changed actions require a new agreement. No cards, special panels or separate approval buttons appear.
15. **Compact management:** verify icon/title grouping, collapsed Past tasks, useful details and dated history. Quiet success differs from failure, controls do not appear as runs, and View message opens an available result. Delete focuses Keep task and preserves existing messages/completed effects.
16. **Saved preferences and conflicts:** no saved email choice defaults on when permitted; saved email/master/source-off remains off. Conflicting quiet-hours settings require an explicit choice. Failed load is retryable; failed save keeps the old effective schedule and draft. Disconnection/revocation never grants access or loses the saved choice.
17. **Interruption controls:** inspect the two-column/stacked surface and Allowed during quiet hours. Add/remove one task allowance in chat. Verify unrelated tasks remain quiet and disabled module/device channels still block outward delivery. Email digest remains independent.
18. **Source and navigation continuity:** open an email source in the connected provider’s webmail in a new tab. Deliver a main-chat update while viewing a side chat; verify no banner, focus/draft loss or transcript contamination. New side chat opens to typing and receives an automatic title; overlay keyboard/focus behavior remains usable at desktop and phone widths.

## Out of Scope

- New Slack, SMS, Teams, or other external conversation/messaging integrations.
- A general workflow builder, module marketplace, or new connector/OAuth implementation.
- Unrestricted autonomous action permissions, run-time approval prompts in background tasks, or automatic quiet-hours bypass based on model urgency.
- Changing when live chat asks for approval. This spec changes approval only for background tasks.
- Replaying every missed recurring interval, running expired instructions, or undoing completed actions when a schedule is cancelled.
- Treating side chats as separate assistants with independent long-term memory.
- A commitment to a new scheduling dependency, provider-specific mechanism, or replacement of existing briefings.
- Implementation, builder dispatch, or merge of this spec PR in this publication session. A Settings task editor, structured creation/approval cards and preview-only review controls are also outside the accepted design.

## Further Notes

The existing [schedules and watchers issue #2388](https://github.com/motioneso/moss/issues/2388) overlaps the requested-work portion of this feature. This broader contract also covers continuous conversation, safe assistant-initiated delivery, and independently controlled automatic email updates. Link and reconcile that issue during ticketing; do not silently overwrite or close it.

Research and the detailed product discussion remain outside the public repository in the Moss area of the Obsidian vault. Research informed the discussion; the user-approved behavior above is authoritative where competitor defaults differ.

The candidate delivery areas are stable main conversation/history, invisible context compaction/handoff, side chats, safe actor-scoped background execution and assistant-only delivery, one-time tasks and controls, recurring useful-only checks, requested watches and agreed suggestions, and default-on email updates. These are areas to split, not eight published tickets or a mandatory linear dependency chain.

The [2026-10-08 implementation-ticket proposal](../plans/2026-10-08-scheduled-proactive-ticket-proposal.md) uses Matt Pocock's `to-tickets` workflow for complete single-session vertical slices with explicit blockers. The user approved publishing the 24-ticket breakdown; the plan records the resulting GitHub issues and native dependencies. The four migration recommendations were resolved before affected migration code through separate explicit user approval; see the migration decisions above. Publication itself did not approve them. Concrete module ownership, resource/retry bounds, briefing interoperability and local-time edge cases belong to the relevant slice; none may defer its safety or live proof to a final hardening task. The frontend decisions are accepted; do not restart the completed product interview.

The independent Opus 5.5 review (2026-10-07, on the spec PR) found that background authority conflicted with #3065 and that approval requests cannot wait for an absent user, because they expire after 150 seconds inside a live chat turn. The user's creation-time approval ruling resolves both. The accepted mockups resolve presentation findings; the ticket proposal carries the remaining migration, evidence, lifecycle and resource-bound work.

A `ready-for-agent` tracker label is required by `to-spec`; it does not override the implementation prerequisites or authorize a build fleet.
