# Scheduled tasks and proactive messaging — implementation tickets

Status: **24-ticket breakdown approved for publication on 2026-10-08; published as #3125–#3148. Implementation has not started; four migration recommendations below still require review.**
Source: [reconciled feature spec](../specs/2026-10-07-scheduled-tasks-and-proactive-messaging.md), [#3096](https://github.com/motioneso/moss/issues/3096), accepted mockups #3100–#3103. Related [#2388](https://github.com/motioneso/moss/issues/2388) remains open and is linked from every published task; its body/state and the parent body/state were preserved.

The numbered slices below retain their proposal identifiers; use the publication map for GitHub issue numbers. Sizing revision: **24 approved ticket slices replace the original 15 drafts**. Each ticket is bounded to one fresh session including orientation, implementation, relevant checks, review, live demonstration and saved evidence. Session fit is an estimate grounded in existing seams, not a guarantee from a title. Revalidate the stated reuse assumptions against the build branch before dispatch. There is no schema-only, UI-only, final-hardening or final-proof ticket. A slice ships only the responsibility types it actually supports; it must not advertise later slices as available.

## Published issue map

All 24 issues are native sub-issues of #3096, with native blocking relationships and the `task` and `ready-for-agent` labels. They are on project 2, **Issue and Roadmap Work**. Only the initial frontier is Ready; the remaining issues are in Backlog until their blockers are integrated and verified. The triage label does not override dependencies or unresolved migration decisions.

| Slice | GitHub issue                                                                                                              | Blocked by                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | [#3125 — Keep a stable Main chat and preserve existing history](https://github.com/motioneso/moss/issues/3125)            | None                                                                                                                                                                   |
| 2     | [#3126 — Open topic side chats through the accepted overlay](https://github.com/motioneso/moss/issues/3126)               | [#3125](https://github.com/motioneso/moss/issues/3125)                                                                                                                 |
| 3     | [#3127 — Continue a conversation through a clean context handoff](https://github.com/motioneso/moss/issues/3127)          | [#3125](https://github.com/motioneso/moss/issues/3125)                                                                                                                 |
| 4     | [#3128 — Return safely to an interrupted conversation](https://github.com/motioneso/moss/issues/3128)                     | [#3127](https://github.com/motioneso/moss/issues/3127)                                                                                                                 |
| 5     | [#3129 — Consolidate the saved automatic email-alert choice](https://github.com/motioneso/moss/issues/3129)               | None                                                                                                                                                                   |
| 6     | [#3130 — Use the canonical quiet-hours control for unambiguous settings](https://github.com/motioneso/moss/issues/3130)   | None                                                                                                                                                                   |
| 7     | [#3131 — Resolve conflicting legacy quiet-hours schedules explicitly](https://github.com/motioneso/moss/issues/3131)      | [#3130](https://github.com/motioneso/moss/issues/3130)                                                                                                                 |
| 8     | [#3132 — Save and deliver a cancellable one-time reminder in chat](https://github.com/motioneso/moss/issues/3132)         | [#3125](https://github.com/motioneso/moss/issues/3125)                                                                                                                 |
| 9     | [#3133 — Inspect and control real reminders in Settings](https://github.com/motioneso/moss/issues/3133)                   | [#3132](https://github.com/motioneso/moss/issues/3132)                                                                                                                 |
| 10    | [#3134 — Deliver reminder notifications under existing attention controls](https://github.com/motioneso/moss/issues/3134) | [#3131](https://github.com/motioneso/moss/issues/3131), [#3132](https://github.com/motioneso/moss/issues/3132)                                                         |
| 11    | [#3135 — Edit reminder instruction, timing and deadline in chat](https://github.com/motioneso/moss/issues/3135)           | [#3133](https://github.com/motioneso/moss/issues/3133)                                                                                                                 |
| 12    | [#3136 — Run fixed-text reminders on a local recurring cadence](https://github.com/motioneso/moss/issues/3136)            | [#3135](https://github.com/motioneso/moss/issues/3135)                                                                                                                 |
| 13    | [#3137 — Execute one requested read-and-report check while away](https://github.com/motioneso/moss/issues/3137)           | [#3133](https://github.com/motioneso/moss/issues/3133)                                                                                                                 |
| 14    | [#3138 — Repeat read checks only when there is useful new information](https://github.com/motioneso/moss/issues/3138)     | [#3136](https://github.com/motioneso/moss/issues/3136), [#3137](https://github.com/motioneso/moss/issues/3137)                                                         |
| 15    | [#3139 — Complete an evidence-backed, deadline-bound condition watch](https://github.com/motioneso/moss/issues/3139)      | [#3138](https://github.com/motioneso/moss/issues/3138)                                                                                                                 |
| 16    | [#3140 — Complete a reading watch only from reliable owner evidence](https://github.com/motioneso/moss/issues/3140)       | [#3139](https://github.com/motioneso/moss/issues/3139)                                                                                                                 |
| 17    | [#3141 — Save a suggested responsibility only after typed agreement](https://github.com/motioneso/moss/issues/3141)       | [#3139](https://github.com/motioneso/moss/issues/3139)                                                                                                                 |
| 18    | [#3142 — Approve one bounded non-destructive action at creation](https://github.com/motioneso/moss/issues/3142)           | [#3135](https://github.com/motioneso/moss/issues/3135), [#3137](https://github.com/motioneso/moss/issues/3137)                                                         |
| 19    | [#3143 — Run an explicitly approved deletion with no automatic replay](https://github.com/motioneso/moss/issues/3143)     | [#3142](https://github.com/motioneso/moss/issues/3142)                                                                                                                 |
| 20    | [#3144 — Renew agreement when editing a task’s approved actions](https://github.com/motioneso/moss/issues/3144)           | [#3143](https://github.com/motioneso/moss/issues/3143)                                                                                                                 |
| 21    | [#3145 — Allow only the explicitly named task during quiet hours](https://github.com/motioneso/moss/issues/3145)          | [#3134](https://github.com/motioneso/moss/issues/3134)                                                                                                                 |
| 22    | [#3146 — Preserve legacy email monitoring under consolidated preferences](https://github.com/motioneso/moss/issues/3146)  | [#3129](https://github.com/motioneso/moss/issues/3129), [#3131](https://github.com/motioneso/moss/issues/3131)                                                         |
| 23    | [#3147 — Deliver useful automatic email findings into Main chat](https://github.com/motioneso/moss/issues/3147)           | [#3134](https://github.com/motioneso/moss/issues/3134), [#3139](https://github.com/motioneso/moss/issues/3139), [#3146](https://github.com/motioneso/moss/issues/3146) |
| 24    | [#3148 — Send results to an explicitly requested side chat](https://github.com/motioneso/moss/issues/3148)                | [#3126](https://github.com/motioneso/moss/issues/3126), [#3135](https://github.com/motioneso/moss/issues/3135)                                                         |

Initial frontier: [#3125](https://github.com/motioneso/moss/issues/3125), [#3129](https://github.com/motioneso/moss/issues/3129) and [#3130](https://github.com/motioneso/moss/issues/3130). Start with #3125 to validate the implementation/integration loop; coordinate file ownership before running #3129 and #3130 concurrently. See their explicitly pending migration recommendations before coding.

## Recommendations requiring review

These fill gaps left by the mockups; they are proposals, not retroactive design approvals.

- **Existing main conversation (#1):** designate the most recently active eligible persistent app conversation once on upgrade; preserve the other eligible transcripts as side chats. Do not repurpose incognito or module-specific surfaces. Create Main chat only when none exists. Later activity never changes the designation. Validate the actual eligibility rules against current storage before migration.
- **Email choices (#5):** reuse the existing email source preference instead of adding a competing switch. An explicit legacy source-off or master-off keeps automatic email alerts off; no saved applicable choice defaults on. A saved master-off must not disable user-requested tasks. Do not infer explicit consent from fallback defaults; distinguish absent records from saved records and disclose unavoidable legacy ambiguity in the migration review. Turning the email switch on must not enable unrelated legacy sources.
- **Quiet hours (#6–#7):** use the existing timezone-capable Profile preference as canonical storage, with existing surfaces linking to Alerts & quiet hours. Carry forward a sole saved value or identical saved values. Different saved values, including enabled/off disagreements, require the accepted explicit choice; keep prior effective policies until resolution. Preserve the existing Profile default when no saved preference exists; the mockup’s Pacific schedule is sample data.
- **Legacy caps and cards (#22–#23):** preserve saved source/global caps for unsolicited email findings; requested tasks use their own bounded cadence and do not spend the unsolicited-email budget. Persist a useful selected chat result immediately during quiet hours; defer only its outward interruption. Share finding identity/budget accounting with legacy scanning so the same finding does not produce duplicate proactive surfaces/notifications. Preserve existing non-email card behavior. The concrete cap accounting and treatment of unsaved defaults must be settled in #22’s implementation plan before coding.

Ticket size and dependencies were approved for publication; these four recommendations remain subject to review before affected migration code. Module ownership, minimum polling cadence, active-task limits and bounded read-retry policy are engineering choices to record in the relevant ticket before implementation, using existing facilities where possible. They must not quietly narrow an accepted user scenario.

## Existing seams to reuse

Graph/source inspection at main revision `d47136ad9` confirms timezone/keyed pg-boss briefing schedules, owner-scoped proactive preferences and notification deferral. It also confirms chat record injection emits a record without persisting it and notification urgency currently skips quiet-hours deferral. These are reuse candidates and gaps, not proof that background delivery or explicit exceptions already work.

Prefer the existing chat persistence/provider routing, actor-scoped job queue, authorized module APIs, timezone scheduling, source scanning, notification delivery and authored Settings/chat primitives. Keep scheduled assistant responsibilities distinct from ordinary to-do items. Do not build a second scheduler, workflow engine, connector, approval UI or generic framework. Re-read the actual branch before implementing; the spec branch predates this inspection.

## Sizing method and result

A ticket has one concrete user outcome, a bounded implementation surface, and a short reproducible live demonstration. It reuses its blockers’ behavior rather than rebuilding it. Safety required by an exposed capability ships with that capability; none is parked in a later hardening ticket. A new Settings control is a vertical extension when it operates real saved records and proves the resulting worker behavior, not merely when it renders a screen.

The first reminder slice delivers chat messages without outward notifications. Settings management and notification delivery are separately useful extensions. Read/report starts with one explicit check before recurrence and novelty suppression. Approved actions start with a bounded non-destructive operation before deletion and action-scope editing. These limits reduce scope without pretending that later capabilities have already shipped.

The highest-risk remaining slices are #3, #4, #8, #13 and #18: semantic context handoff, interrupted-turn recovery, the first durable reminder path, the first isolated read run and the first stored-action authority path. They are bounded to their minimum complete behaviors below. If the named existing seams cannot support that boundary without replacing provider runtimes, a gateway or queue infrastructure, revise/split the ticket before dispatch; do not consume multiple sessions under one issue. No numerical time or token estimate is claimed without an agreed session budget.

| Original draft          | Revised tickets | Sizing decision                                                                                      |
| ----------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| 1 — stable Main chat    | 1               | Keep; one designation/history migration.                                                             |
| 2 — side chats          | 2               | Keep; wire the accepted overlay to existing conversation operations.                                 |
| 3 — context changes     | 3, 4            | Separate clean context handoff from interrupted-turn recovery.                                       |
| 4 — email preference    | 5               | Keep; preference/access mapping only, with legacy cap migration elsewhere.                           |
| 5 — quiet hours         | 6, 7            | Separate ordinary canonical control from conflicting legacy schedules.                               |
| 6 — first reminder      | 8, 9, 10        | Separate minimal chat delivery, real Settings management and outward notification delivery.          |
| 7 — chat edits          | 11              | Keep; instruction/timing/deadline edits, no action-scope approval.                                   |
| 8 — recurring reminders | 12              | Keep; cadence/catch-up extend the proven fixed-text path.                                            |
| 9 — source checks       | 13, 14          | Separate one requested read/report run from useful-only recurrence and consecutive-failure handling. |
| 10 — watches            | 15, 16          | Separate evidence-backed conditions from reading goals with explicit owner confirmation.             |
| 11 — suggestions        | 17              | Keep; typed agreement creates already-supported responsibilities.                                    |
| 12 — scoped effects     | 18, 19, 20      | Separate non-destructive actions, deletion and reapproval of action edits.                           |
| 13 — allowances         | 21              | Keep; one explicit task-specific delivery exception.                                                 |
| 14 — automatic email    | 22, 23          | Separate legacy scanner compatibility from automatic chat delivery/default-on behavior.              |
| 15 — side destinations  | 24              | Keep; route/edit destinations on the existing delivery path.                                         |

## Ticket slices

### 1. Keep a stable Main chat and preserve existing history

**Blocked by:** None.

**What it delivers:** reopening Moss returns to the same durable Main chat; a one-time upgrade preserves existing transcripts.

**Scope limit:** designate/migrate the main identity using existing chat persistence. No selector redesign, provider-context work or background delivery.

- [ ] Apply the reviewed eligibility rules once, retain other eligible histories, and make repeated upgrades idempotent; exclude module/incognito surfaces.
- [ ] Reload/reconnect retains designation/history; later side-chat activity cannot change it. Selection/read/write stay owner-scoped.

**Live demonstration:** reopen an existing owner’s app, verify the same history/designation, repeat the migration and confirm preserved transcript counts.

### 2. Open topic side chats through the accepted overlay

**Blocked by:** #1.

**What it delivers:** New side chat opens directly to typing; users switch between distinct persisted transcripts through the three-line overlay.

**Scope limit:** connect accepted navigation to existing chat operations and shared owner memory/preferences. No new provider runtime or destination scheduling.

- [ ] Preserve the 380px dock, closed overlay, automatic titles, keyboard/Escape/outside-close behavior, inert background and focus restoration.
- [ ] Switching/reload preserves identities, separate transcripts and drafts without changing Main chat or introducing an update banner; owner isolation applies.

**Live demonstration:** create/type/switch/reload at desktop and phone widths, then verify transcripts remain separate and Main chat remains designated.

### 3. Continue a conversation through a clean context handoff

**Blocked by:** #1.

**What it delivers:** an existing conversation continues after its provider context fills, retaining relevant decisions without a visible new conversation.

**Scope limit:** semantic summary/context selection and clean handoff through the existing provider-neutral replay/session boundary. No new vendor adapters or interrupted-turn recovery. If this requires a runtime replacement, reslice before dispatch.

- [ ] Use capability-routed semantic compaction/handoff instead of concatenation/truncation; preserve durable transcript and conversation identity.
- [ ] Summary failure retains the last usable context/history; never replace good context with an empty/failed result. Load durable responsibilities once those records exist instead of relying on summaries to remember them.

**Live demonstration:** reach a small test context budget through real chat, trigger clean handoff, and ask about a decision from before the transition; record unchanged transcript identity and the real-model response.

### 4. Return safely to an interrupted conversation

**Blocked by:** #3.

**What it delivers:** after a provider/app interruption, reopening chat preserves completed messages and makes the unfinished outcome understandable without replaying uncertain actions.

**Scope limit:** persisted pending/completed turn identity and recovery at the existing session boundary. No new compaction algorithm, tool-ledger repair system or generic retry framework. If the current runtime cannot expose a safe interruption boundary, reslice before dispatch.

- [ ] Reconcile pending versus completed turn/message identities across restart; completed turns are not lost or duplicated.
- [ ] Resume only where existing evidence establishes safety; an uncertain tool/action outcome is never blindly rerun. Explain unfinished work in ordinary chat using existing failure presentation, without a technical new-session announcement.

**Live demonstration:** interrupt one reply on the isolated dev instance, restart/reopen and continue typing; verify earlier history and no duplicated reply/effect.

### 5. Consolidate the saved automatic email-alert choice

**Blocked by:** None.

**What it delivers:** one persisted Automatic email alerts choice preserves existing off decisions and remains separate from email access and delivery preferences.

**Scope limit:** accepted email/delivery column, effective preference mapping and existing email-source enable/disable entry point. No cap/cursor rewrite, connector changes or new chat alerts; those are #22–#23.

- [ ] Distinguish absent versus saved choices, preserve applicable master/source-off and disconnected preferences, and record default-on intent for eligible users without a saved choice.
- [ ] An explicit on choice neither grants/reconnects access nor enables unrelated sources. Requested responsibilities do not consult this unsolicited-alert preference.
- [ ] Keep module/device/digest delivery controls distinct; include saved-off, disconnected/revoked and loading/load/save-error states with local recovery feedback.

**Live demonstration:** save off/on/reload through Settings and exercise the existing source gate, including revoked access and an unrelated source remaining unchanged. Default-on chat behavior is demonstrated in #23.

### 6. Use the canonical quiet-hours control for unambiguous settings

**Blocked by:** None.

**What it delivers:** users manage a timezone-aware quiet-hours schedule through the accepted surface when legacy values are absent, identical or otherwise unambiguous.

**Scope limit:** reuse the Profile preference and its existing delivery consumers; no conflicting-value migration UI or task exceptions.

- [ ] Preserve the reviewed defaults/sole saved value, link existing surfaces to the canonical control and keep saved versus draft/error feedback distinct.
- [ ] Validate timezone/start/end, overnight windows, equal-time rejection and DST boundaries; failed saves retain the effective schedule and draft.
- [ ] Detect conflicts without choosing a winner or discarding either value. Until #7 resolves them, keep conflicting owners’ existing controls/policies effective; do not expose a falsely authoritative merged setting.

**Live demonstration:** save/reload an overnight schedule, fail a save without changing its effective value, and verify an existing notification follows its boundary.

### 7. Resolve conflicting legacy quiet-hours schedules explicitly

**Blocked by:** #6.

**What it delivers:** owners with differing saved quiet-hour values choose explicitly which schedule applies through the accepted conflict flow.

**Scope limit:** migration/choice transaction and its real consumers; reuse #6’s control, validation and error handling.

- [ ] Cover different windows and enabled/off disagreements; retain prior policies until the selected choice saves successfully.
- [ ] Commit a single effective preference only after the authenticated choice succeeds; repeated upgrade/resolution is idempotent.
- [ ] Existing relevant notification/proactive consumers use the resolved value. No source/model urgency becomes permission for the new task-delivery path.

**Live demonstration:** create conflicting records through the real data path, resolve them in Settings, reload, and verify notification timing; repeat with a failed save preserving old behavior.

### 8. Save and deliver a cancellable one-time reminder in chat

**Blocked by:** #1.

**What it delivers:** a user requests a fixed-text reminder in ordinary chat, can cancel it in chat, and receives one durable replyable Moss message while the browser is closed.

**Scope limit:** the minimum reminder record, authenticated create/list/cancel operations, existing metadata-only queue and assistant-message persistence. No full Settings surface, model/tool execution, recurrence or outward notifications. If persistence requires a live-runtime rewrite, reslice before dispatch.

- [ ] Save directly with natural local-time/deadline confirmation and no card/second approval. Store owner, instruction, due/deadline, state and default Main chat destination.
- [ ] Current lifecycle/owner checks prevent cancelled/deleted queued or in-flight work from posting; replay/concurrent workers cannot duplicate execution/message creation.
- [ ] A missed reminder posts once as clearly late unless expired. The hidden trigger creates no user turn; concurrent live replies retain their own message identities.
- [ ] Reload/reconnect and a normal reply work. Quiet hours do not defer this chat message; outward delivery is absent until #10.

**Live demonstration:** request a near-future reminder, close/reopen, reply to its persisted result, then cancel a second queued reminder and verify zero resulting messages. Automated checks also cover replay, expiry and active-reply coexistence.

### 9. Inspect and control real reminders in Settings

**Blocked by:** #8.

**What it delivers:** users inspect reminder details/history and pause/resume/delete the same records through the accepted compact Settings list.

**Scope limit:** Settings-backed lifecycle extension for reminders only. Reuse #8’s execution and cancellation; no editing form or new scheduler.

- [ ] Add Reminders icon/title rows, compact details, dated run history/View message and collapsed Past tasks; cover loading/empty/error and active/paused/completed/expired states.
- [ ] Pause/resume in Settings and chat affect the actual worker. Confirm deletion with Keep task focus and retain prior messages/effects; controls are not run-history entries.
- [ ] Recheck pause/delete state before effects/posting, including queued/in-flight work and resume races.

**Live demonstration:** pause a pending reminder in Settings, observe no firing, resume and receive it once, open its result/history, then delete another pending reminder. Exercise the same record from chat and on phone.

### 10. Deliver reminder notifications under existing attention controls

**Blocked by:** #7, #8.

**What it delivers:** reminders can signal through existing enabled delivery channels; quiet hours delay outward interruptions while chat results remain readable.

**Scope limit:** notification/delivery extension of the proven result path and resolved preference. No source scanning or task exceptions.

- [ ] Use result/run identity and existing delivery machinery so notification failure/retry cannot recreate a chat message or rerun the reminder.
- [ ] Persist chat immediately; defer only outward delivery through canonical quiet hours. Module/device/channel mutes win, and model urgency cannot bypass the window.
- [ ] Recheck lifecycle and current preferences at queued delivery; cancelled work cannot initiate further notifications. A failed channel has an honest retryable delivery outcome.

**Live demonstration:** request a reminder during a current quiet window, read/reply in chat immediately, then end the window and observe one outward delivery; repeat with the existing channel muted.

### 11. Edit reminder instruction, timing and deadline in chat

**Blocked by:** #9.

**What it delivers:** users edit saved reminders through ordinary Moss chat and inspect the same updated record in Settings.

**Scope limit:** instruction/local-time/deadline edits and version invalidation. No action-scope approval or destination selector.

- [ ] Resolve the intended task, use natural confirmation and provide no Settings Edit form/button.
- [ ] Invalidate stale queued instructions; check current version/state before posting, including edits during a run. Unsupported or action-widening edits remain refused until implemented, never silently accepted.

**Live demonstration:** move a queued reminder and change its text in chat, inspect the new record, and verify only the revised instruction fires at the new time.

### 12. Run fixed-text reminders on a local recurring cadence

**Blocked by:** #11.

**What it delivers:** daily, weekly and more-frequent reminders run on their saved local schedule and remain controllable in the corresponding Settings groups.

**Scope limit:** recurrence and catch-up on #8’s fixed-text queue/result path. No model checks or novelty scoring.

- [ ] Reuse timezone-aware queue scheduling, current lifecycle/version checks and bounded active schedules; show useful cadence/next-run details and existing chat editing.
- [ ] After downtime produce one fresh due outcome and resume cadence, never replay all missed intervals. Respect expiry and define/test local DST policy before coding.

**Live demonstration:** create a short recurring reminder in chat, stop the isolated worker for a few intervals, restart, observe one catch-up result and the next normal firing, then cancel it.

### 13. Execute one requested read-and-report check while away

**Blocked by:** #9.

**What it delivers:** a user schedules one read-and-report check of an available source and receives a sourced ordinary assistant reply while the browser is closed.

**Scope limit:** one bounded run through the existing configured model/read gateway and source APIs. No multi-source workflow, recurrence, write authority or new provider/connector adapter. If isolating this run requires replacing the action gateway, reslice before dispatch.

- [ ] Load private instruction/source context through authorized APIs, keep job payloads metadata-only, use current capabilities and deny all changes/deletion at the actual gateway.
- [ ] Keep the trigger and run context out of visible user turns and live-chat authority. Task cancellation/version checks and stable run/message identity apply before posting and on replay.
- [ ] Apply bounded quiet retries for transient read failures and report exhausted failures honestly; never claim quiet success for failure. Use configured capabilities without hardcoding provider/model.
- [ ] Persist a normal replyable sourced result; connected-provider webmail links open in a new tab. Quiet hours never defer chat persistence; reuse outward policy if #10 is installed.

**Live demonstration:** request a near-future check using a real authorized existing source, close/reopen and inspect/reply to the result; revoke access for a second check and observe refusal without data exposure. Automated checks prove write/source-instruction and cross-owner denials.

### 14. Repeat read checks only when there is useful new information

**Blocked by:** #12, #13.

**What it delivers:** recurring read checks stay silent for empty/unchanged findings and post useful new findings with distinct success/failure history.

**Scope limit:** recurrence/observation state and consecutive-failure handling on the proven read path. No condition completion or automatic email policy.

- [ ] Persist novelty/observation identity; empty/unchanged checks show quiet success, not messages. Changed useful findings post once with sources.
- [ ] Reuse bounded per-run read retries; repeated failed scheduled checks create actionable status/message without flooding or false success.
- [ ] After downtime make one fresh check, then resume cadence; lifecycle/idempotency remain enforced. Record polling/active-task bounds and briefing interoperability without creating duplicate schedule ownership.

**Live demonstration:** run a requested recurring check through Settings/chat, observe quiet success, change the real source, observe one update, then run unchanged again. Automated clock/failure checks and controlled worker downtime prove recovery.

### 15. Complete an evidence-backed, deadline-bound condition watch

**Blocked by:** #14.

**What it delivers:** a requested condition watch reports reliable fulfilment evidence, explains completion once and stops; unfulfilled watches expire at their deadline.

**Scope limit:** one stated condition over an existing available source, demonstrated with an expected email reply. Reuse the read/report path for other supported evidence; no new condition language, source adapter, provider read-state collection or reading-goal completion.

- [ ] Store goal/matching criteria, evidence and deadline; introduce Watches and inspectable completed/expired states/history using the accepted details.
- [ ] Alert delivery alone is not completion evidence. Establish the actual requested goal from source evidence; competing workers/duplicate findings cannot repeat closure or run after fulfilment/expiry.

**Live demonstration:** create a watch in chat, deliver a matching email through the connected source, inspect one result/closure and stopped work; demonstrate a short unmet deadline expiring without an execution.

### 16. Complete a reading watch only from reliable owner evidence

**Blocked by:** #15.

**What it delivers:** a reading goal stays active after an alert/webmail click and completes after the owner explicitly confirms reading.

**Scope limit:** reading-goal state and normal-chat owner confirmation. No new read/unread sync or provider telemetry.

- [ ] Unknown provider read state remains unknown; neither notification delivery nor opening a source link can close the watch.
- [ ] Bind an explicit “I’ve read it” to the correct owner/watch, resolving ambiguity; close once and retain deadline/stop behavior when confirmation never arrives.

**Live demonstration:** open an alert’s webmail link, verify the watch remains active, confirm reading in chat and verify one closure with no later firing.

### 17. Save a suggested responsibility only after typed agreement

**Blocked by:** #15.

**What it delivers:** Moss proposes already-supported reminders/checks/watches in ordinary chat; agreement saves a working responsibility, decline saves none.

**Scope limit:** proposal/agreement binding using existing conversation persistence and creation paths. No new approval UI or unsupported task types.

- [ ] Use ordinary text/composer, no cards/buttons/panels. Revised or ambiguous replies never approve the old terms.
- [ ] Reconnect preserves the proposal conversation without granting authority; repeated acceptance creates at most one responsibility and a natural confirmation.

**Live demonstration:** decline one proposal, revise another, reload and agree to its current terms; verify exactly one real saved task that executes through the established path.

### 18. Approve one bounded non-destructive action at creation

**Blocked by:** #11, #13.

**What it delivers:** an owner approves a stated, supported change in ordinary chat; its scheduled run performs that bounded action while the owner is away without asking again.

**Scope limit:** stored creation-time scope and the existing action gateway, demonstrated with one existing non-destructive API on disposable data. No new action API, deletion or action-scope editing. If the gateway must be redesigned, reslice before dispatch.

- [ ] Bind typed agreement to the exact proposed task version/action scope; decline/revised terms save nothing. Show inspectable scope in Settings. Refuse scope-changing edits until #20.
- [ ] Enforce current grants, stored scope, source-trust boundaries and lifecycle at the real effect gateway; refuse/report other actions without runtime approval. Live-chat outside-content rules stay unchanged.
- [ ] Record effect initiation before invocation. Any failed/uncertain run after a write starts is never automatically rerun, including after restart; provide actionable history/message. Result delivery retry cannot repeat model actions.

**Live demonstration:** approve a bounded action in chat, close the browser, observe one real change/result and no later approval. Replay its job and verify no repeated effect; negative/uncertain-outcome checks exercise the same gateway.

### 19. Run an explicitly approved deletion with no automatic replay

**Blocked by:** #18.

**What it delivers:** an owner can approve a supported destructive action once at creation, inspect its scope and receive an honest result without unattended reapproval.

**Scope limit:** destructive policy classification/authority on #18’s path using one existing deletion API and disposable data. No connector deletion implementation or new approval presentation.

- [ ] Ordinary chat names deletion and its irreversibility where applicable; refusal/decline/revised terms save nothing. No background prompt appears.
- [ ] Current capability/scope/lifecycle checks still win. Reuse effect-initiation/uncertain-outcome safeguards; deletion and result delivery are never blindly replayed.

**Live demonstration:** explicitly approve deletion of a disposable item, observe it removed once, replay the queued run without further deletion and inspect history/scope. Automated checks cover revoked approval/capability and a failure after invocation starts.

### 20. Renew agreement when editing a task’s approved actions

**Blocked by:** #19.

**What it delivers:** changing saved action scope in ordinary chat asks for fresh agreement; timing-only edits retain their already-approved scope.

**Scope limit:** proposed-version/consent binding and queue invalidation on existing write/deletion tasks. No new effect type or approval system.

- [ ] Never execute widened/revised scope before agreement. Decline leaves the previously saved scope intact unless the user explicitly pauses/deletes it; pending edits confer no authority.
- [ ] Agreement commits the current proposed version once and invalidates stale queued authority. Recheck versions before initiating effects; source content cannot approve edits.
- [ ] Preserve timing-only edit behavior; destination-only changes use #24 when available. Deleting/revising a proposal before acceptance prevents stale approval from saving it.

**Live demonstration:** propose a change to an approved action, decline it and verify old scope, then accept a revised scope and verify queued old instructions cannot act. Test ambiguous/replayed acceptance and timing-only edits.

### 21. Allow only the explicitly named task during quiet hours

**Blocked by:** #10.

**What it delivers:** an owner adds/removes a per-task allowance in normal chat and sees it under Allowed during quiet hours.

**Scope limit:** explicit task-bound intent and delivery exception on the established notification path. No global urgent bypass or new channel.

- [ ] Change in chat targets the correct owner/task; persist explicit intent, never model/source urgency. Only that task bypasses deferral.
- [ ] Current module/device/channel mutes still block outward delivery. Recheck removed allowances and task state before queued delivery; never recreate the chat message.

**Live demonstration:** allow one reminder during a current quiet window and compare it with an unallowed reminder; remove the allowance and repeat with the existing device channel muted.

### 22. Preserve legacy email monitoring under consolidated preferences

**Blocked by:** #5, #7.

**What it delivers:** existing opted-in email monitoring continues to respect saved enable choices, caps, finding identity and resolved quiet-hour preferences after consolidation.

**Scope limit:** the existing email scanner/anti-spam consumers and their real Settings-backed policy. No new default-on chat producer or non-email scan rewrite.

- [ ] Preserve reviewed saved source/global caps and apply effective email preference without enabling unrelated sources; preserve cursor/finding identity through migration/restart.
- [ ] Account for a finding once, including duplicates/concurrent scans. Keep requested responsibilities outside the unsolicited-email budget.
- [ ] Keep legacy non-email behavior stable; make the email policy usable by #23 so chat delivery need not create a second scan/budget pipeline.

**Live demonstration:** exercise existing email monitoring from real Settings with saved off/on and a small saved cap; run duplicate/new findings through its source and verify the real capped outcome survives reload/restart.

### 23. Deliver useful automatic email findings into Main chat

**Blocked by:** #10, #15, #22.

**What it delivers:** eligible users receive useful unsolicited email messages by default when no saved choice exists; switching alerts off leaves requested inbox watches and other tasks running.

**Scope limit:** connect the existing selected email findings to the proven assistant-result/delivery path under #22’s policy. No second source/model scanner or cap migration.

- [ ] Apply saved-off/default-on/disconnected/revoked rules; useful source-backed results have real provider webmail links and empty/unchanged findings stay quiet.
- [ ] Reuse finding identity/accounting to avoid duplicate cards/messages/notifications for a migrated finding; no duplicate model scan. Failure never counts as successful silence.
- [ ] Persist selected chat messages immediately during quiet hours, defer only outward delivery and respect mutes. The unsolicited-alert switch neither cancels requested watches nor grants email access.

**Live demonstration:** observe a useful real email alert, turn the switch off, then introduce another finding and a matching requested-watch reply; verify only the watch reports and an unrelated recurring task continues.

### 24. Send results to an explicitly requested side chat

**Blocked by:** #2, #11.

**What it delivers:** creation or a normal chat edit can name a side-chat destination; otherwise results go to Main chat even when created in a side chat.

**Scope limit:** stored destination, authorized message routing and destination-only edits on the common task path. No new navigation or notification transport.

- [ ] Confirm a non-default destination naturally and show it in details; destination-only edits require no action approval and invalidate stale routing versions.
- [ ] Main-chat arrivals while a side chat is open preserve its transcript/draft/focus without banners. Explicit side results persist and coexist with a live reply there.
- [ ] Recheck destination access/existence before posting; an unavailable target gives actionable status rather than silent rerouting/cross-owner delivery.

**Live demonstration:** create tasks in a side chat with default and explicit destinations, edit one destination before firing and verify both histories/identities and preserved drafts during live delivery.

## Coverage and completion

The accepted product spec is unchanged by this sizing pass. The table maps its acceptance scenarios to the slices that provide their assembled behavior; shared boundary checks still apply to every relevant ticket.

| Spec scenario                    | Revised tickets                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| 1 — continuity                   | 1, 3, 4                                                                                   |
| 2 — side chats/routing           | 2, 24                                                                                     |
| 3 — one-time task                | 8, 10                                                                                     |
| 4 — useful recurring checks      | 14                                                                                        |
| 5 — suggestion/controls          | 9, 11, 17                                                                                 |
| 6 — independent email preference | 5, 15, 23                                                                                 |
| 7 — quiet hours                  | 7, 10, 21                                                                                 |
| 8 — failures                     | 13, 14                                                                                    |
| 9 — authority/cancellation       | 8, 9, 18, 19, 20                                                                          |
| 10 — concurrent/retry safety     | 8, 13, 18; inherited by every later delivery/effect slice                                 |
| 11 — watch completion            | 15, 16                                                                                    |
| 12 — downtime                    | 8, 12, 14, 15                                                                             |
| 13 — trust boundaries            | 8, 13, 18, 19, 21, 23, 24; owner checks also apply to every earlier control/history slice |
| 14 — ordinary creation/approval  | 8, 13, 17, 18, 19, 20                                                                     |
| 15 — compact management          | 9; history/state extensions in 12–15, 18–20                                               |
| 16 — saved preferences/conflicts | 5–7, 22, 23                                                                               |
| 17 — interruption controls       | 10, 21, 23                                                                                |
| 18 — sources/navigation          | 2, 13, 15, 23, 24                                                                         |

## Shared acceptance and publication boundary

Every product ticket updates the app map in the same PR for its actual capabilities, settings/navigation, requirements, errors and recovery. Use authored design primitives and the accepted desktop/phone, light/dark/Teal states. Unsupported later capabilities stay unadvertised/unavailable; never accept unsafe work in anticipation of a future slice. In particular, reminders may exist in chat before Settings/outward delivery, effects cannot run before their approval slice, and ambiguous legacy preferences stay effective until explicitly resolved.

Every exposed source/action path must enforce the spec’s trust boundaries: observed content cannot change permissions, action scope, recipients or interruption allowances; private instructions/content stay out of queue payloads and secrets stay out of prompts, frontend output and logs. These are requirements to prove, not claims about existing enforcement.

Each session includes the smallest relevant behavioral checks at existing seams, required repository checks, review and its stated live demonstration/evidence. Actor/authority negatives, cancellation/version races and idempotency ship wherever the slice introduces them. Observe security assertions failing with their enforcement removed. Use the prescribed gate workflow for DB-touching checks, never the live dev database. Live proof exercises the installed real UI/worker path on an isolated dev instance with assertions and bounded textual evidence; no rewritten Moss responses. Use near-future timing, a current quiet window and controlled worker downtime for live checks; deterministic clocks/source/model doubles belong in automated checks. No final hardening or proof ticket substitutes for this work.

The initial frontier is #1, #5 and #6. The first reminder #8 depends only on stable Main chat, because it produces readable chat without outward interruptions. #10 adds notification policy after conflict resolution; #9 independently adds management. #13 adds the bounded read path independently of recurrence; #14 combines it with cadence. #18 does not wait for condition watches. #23 waits for a working requested watch to prove independent opt-out. #3–#4 are required for full conversation continuity but do not gate short isolated reminder/read runs. Every blocker listed is a direct prerequisite; neither review order nor shared ownership alone creates an edge.

Publication complete: the user approved submitting this 24-ticket breakdown through `to-tickets`. All tickets retain their scope limits, acceptance criteria, live demonstrations and direct blockers; the map above records actual tracker identifiers. Approval to publish is not independent approval of the four migration recommendations. No builders were dispatched, production code changed, or issues/PRs merged or closed. A fresh `implement-spec` session should use current main, safely incorporate the documentation from PR #3097 if it is still unmerged, and work the native dependency frontier on one integration branch. Do not restart the accepted product interview or merge throwaway mockup branches.
