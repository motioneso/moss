# Today and briefings: behavior, recovery, and acceptance

Read the [implementation plan](2026-09-10-today-briefings.md) and the three approved design specs it
links. This document translates those approvals into verifiable behavior. Choices explicitly marked
**proposed** are production reconciliations for plan review, not additional visual approvals.

## Requirement-to-proof matrix

| Requirement                         | Implementation acceptance evidence                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chief-of-staff assessment           | Headline/prose reflect actual task status, current calendar, evening intent when present, and source age. No fictional names, dates, counts, or unsupported completion claims.                                                                          |
| Complete day before the wider world | DOM order places the schedule and preparation before news/sports. Keyboard and mobile reading order agree with the visual order.                                                                                                                        |
| Automatic or proposed blocks        | Resolve the current actor's existing scheduling policy. Automatic placement only occurs through the existing authorized scheduling path; reading requires no new acceptance. Proposed blocks do not become committed merely by rendering or refreshing. |
| Bulk acceptance                     | One activation accepts eligible proposed task blocks, without a per-task tour. The reading briefing remains open on success. Unscheduled tasks and already accepted calendar blocks are not resurrected or duplicated.                                  |
| Partial acceptance                  | Accept one proposal and leave another proposed; reload and verify each state independently. Change summaries name additions, moves, and removals.                                                                                                       |
| Adjust/remove blocks                | The calendar and task detail show the new time after acknowledgement. Removing a block retains its underlying task, deadline, notes, and history. Completing a task is a distinct action.                                                               |
| Protect commitments                 | Meeting, event, lunch, preparation dependencies, travel, timezone, and duration constraints are rechecked at application time. A preview's old availability cannot authorize an overlapping write.                                                      |
| Evening reflection                  | A correction distinguishes a completed meeting from an unsent follow-up. Preserve correction provenance; do not mark a task completed because prose says it is.                                                                                         |
| Open commitments                    | Existing Today decisions appear in the evening without re-asking them. Tomorrow, another date, unscheduled, and unchanged decisions retain correct task semantics.                                                                                      |
| Capacity and priority               | A lighter plan prioritizes selected work without deleting or completing the other tasks. The next morning consumes saved intent instead of repeating the interview.                                                                                     |
| Drafts and save                     | Closing/reopening retains changes and input according to the specified draft store. Actual saved state survives reload. Failure must not falsely announce success or erase pending choices. No UI narration of storage mechanics.                       |
| Calendar-policy changes             | Previously committed blocks stay committed when policy changes to proposals. Pending proposals are not silently accepted when switching policy. New mutations resolve policy again.                                                                     |
| Morning reconciliation              | Source-grounded overnight changes identify what changed, its impact, and a recommendation. No evening preparation produces a normal briefing from available facts, not an invented conversation.                                                        |
| Sources and materials               | Every source/material link resolves to an actor-visible entity or reports its absence. Freshness and changed-calendar evidence are inspectable without overwhelming prose.                                                                              |
| News                                | Include morning news by default unless explicitly excluded or disabled; provide concise major-story prose, source links, a real sourced photo when available, and useful article navigation.                                                            |
| Sports                              | Include by default unless excluded/disabled. Followed teams lead multiple prior-night results; notable other games earn inclusion by an explainable story. Include short prose, images where available, and a separate tonight/live/quiet state.        |
| Weather                             | Prominent current conditions and daily high/low or overnight low respect existing location, unit, timezone, and freshness settings. Do not invent readings when a provider is unavailable.                                                              |
| Module actions                      | Contributions honor module installation/enabled/access state. Wellness keeps its full existing medication and check-in capabilities, pending/error/correction behavior, and ownership.                                                                  |
| App map                             | Every shipped surface, preference, requirement, error, and remediation is declared by the correct core/module owner in the same PR as behavior.                                                                                                         |
| Responsive/a11y                     | Verify 320/375/768/1440 widths, keyboard-only operation, named controls, focus return, error announcements, contrast, readable prose, and no clipped primary action.                                                                                    |

## Remaining page-state reconciliations (proposed)

Use existing authored state components and the approved hierarchy. These additions do not authorize
new modules or a second design system. Before implementing a materially new screen, preserve its
reviewed reference alongside the approved specs.

| State                       | Proposed behavior                                                                                                                                   | What must not happen                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Quiet/empty day             | A factual assessment and existing commitments; optional task suggestions when warranted. Enabled news, sports, and module actions can still appear. | Manufacturing work to fill the schedule, a wall of zero metrics, or treating empty data as failure.       |
| Briefing pending            | Keep current calendar/tasks usable with a small in-place progress state.                                                                            | Blocking the entire Today page behind a prose request.                                                    |
| Briefing unavailable        | Offer retry and show usable schedule data. Retain a previous report only with its date/freshness visible.                                           | Calling yesterday's prose today's completed briefing.                                                     |
| One source delayed          | Identify the affected source and last known time; retain unrelated working sections. Retry through that source's owning capability.                 | Claiming a source is current or rebuilding all modules because one failed.                                |
| Calendar unavailable/stale  | Keep known commitments visible with their age. Draft suggestions may be shown, but defer writes that cannot pass current conflict validation.       | Treating an empty/error response as a free day.                                                           |
| Full day/no feasible slot   | Keep the task unscheduled, expose deadline risk, and offer a real adjustment.                                                                       | Shortening task duration, moving fixed events, or filling protected travel without consent.               |
| No evening preparation      | Explain the morning plan from tasks, calendar, and actual priorities.                                                                               | A fabricated quote or capacity choice from last night.                                                    |
| Module disabled/uninstalled | Remove its contributions and source access; use the module's existing setup/navigation path if the user seeks it.                                   | Briefing defaults re-enabling a module or overriding an explicit exclusion.                               |
| No followed teams           | Reuse the current default slate for a small notable-games digest if enabled, with the existing follow-team setup entry.                             | Inventing followed teams or blocking the whole sports section.                                            |
| Ambiguous followed team     | Exclude unresolved identities and surface the existing follow-resolution candidates.                                                                | Assigning scores or prose to a guessed team from a short key.                                             |
| No games tonight            | A short factual quiet-night message. Keep the previous night's results when relevant.                                                               | A blank oversized score card or treating a postponed game as completed.                                   |
| Missing photo               | A compact text treatment with source attribution; retain the story.                                                                                 | A broken image, unrelated stock photo implying real coverage, or a generated fake presented as reporting. |
| Locale/timezone changes     | Recompute day boundaries and presentation from actor locale. Preserve event instants and show correct cross-midnight game/date context.             | Selecting yesterday by slicing UTC date strings or treating future games as final.                        |
| Earlier briefing            | Reuse existing run/history facilities. Earlier reports are dated/read-only; any current action must be revalidated against current state.           | Replaying old mutations from an archived briefing.                                                        |
| Meaningful daytime change   | Mark the affected section/time and update the relevant facts. Preserve ongoing edits; surface conflicts against the newer plan.                     | Resetting an in-progress conversation or interrupting solely because prose changed.                       |
| Several enabled widgets     | Compose existing module contributions in the approved dock; mobile remains before the schedule. Preserve each owning module's deeper flow.          | Duplicated Wellness controls, independent dashboard registration systems, or hidden offscreen actions.    |

## Mutation and persistence semantics (proposed implementation contract)

- Use stable entity identities and actor ownership throughout. UI prose is explanatory, not a command
  parser or an authorization token. A server-validated action must identify the proposed change.
- Base changes on a known plan/source version. Revalidate current task state, policy, permissions,
  busy ranges, and external source freshness before committing. Return a conflict with enough
  current data to review; do not silently overwrite concurrent work.
- Reuse the existing action/proposal and scheduling authorities. The new UI cannot call around
  approval policy, connector consent, audit history, or module boundaries to approximate the mockup.
- Accept All covers proposed additions only. A reviewed batch with removals requires one further
  explicit confirmation of that move/removal set under the existing `calendar_management` default
  `always_confirm` policy. Gateway/action authorization binds actor, revision, event IDs and operation;
  missing/stale approval prevents all batch writes. Scheduling mode alone cannot authorize these changes; resolve explicit family promotions separately.
- Bulk acceptance needs a documented atomicity boundary. A local transaction is not an external
  calendar transaction. If the authoritative store and provider cannot commit together, surface
  per-item applied/pending/failed state and retry only uncompleted operations. Never imply rollback
  of a remote write that has already succeeded.
- A repeated request or retry must not create a second block. Bind retry/idempotency to the actor,
  source plan version, operation, and target identity using existing keys wherever possible.
- Separate draft, proposed, committed, and unscheduled state. Persist committed choices and evening
  intent through existing repositories where they fit; an additional durable record requires an
  explicit storage purpose and migration. No shadow task/calendar copy in browser storage.
- After acknowledgement, invalidate/update the owning queries so schedule, report, task detail,
  preparation links, and morning/evening handoff agree. Do not claim completion before acknowledgement.
- Default-on news/sports applies only to an absent preference. Preserve existing explicit false
  values, module-disabled state, and source/topic exclusions. If old data cannot distinguish an
  implicit default from an explicit choice, preserve the old value and document that limitation.
- Keep all source reads actor-scoped and model selection capability-based. Validate generated
  output; escape rendered prose and use existing safe source/image navigation mechanisms.

## Verification layers and boundaries

1. **Pure unit checks:** mapping/source freshness, default precedence, timezone boundaries, ordering,
   conflicts, plan differences, selection, and idempotency decisions. Name tests for observable
   behavior; do not mirror trivial markup or private helper structure.
2. **Repository/service integration:** protected isolated database target, two actors for isolation,
   durable save/reload, version races, task retention, policy checks, source filters, and retries.
   Validate actual wiring and repository authorization, not a newly invented in-memory equivalent.
3. **Mocked browser regression:** existing mock harness, every added endpoint intercepted, realistic
   partial failures. Validate the combined Today/dialog/preparation/Wellness paths and the complete
   default-on/off content matrix. Browser mocks cannot prove provider or database behavior.
4. **Real UI on live dev:** use the protected UAT/provisioning workflow and a disposable authorized
   actor. Follow actual login, module/settings configuration, briefing generation, review/save,
   reload, and next-morning handoff. Record revision, command, exit code, assertion summary, and
   bounded DOM/network evidence. Screenshots are design references, not live-path release proof.
5. **Release:** scoped type/lint/format checks during slices; `pnpm verify:static`, protected
   `pnpm verify:foundation`, required CI and review, app-map build, release note, and real-path proof
   on the exact candidate before Done/merge. Never run DB-touching commands without the mandated
   protected verification procedure. Missing verification is reported explicitly.

The planning session does not execute product tests, provision actors, deploy, or mutate accounts.
Prototype checks already recorded in the approved specs establish prototype behavior only.
