# Slice 7: Evening conversation and next-morning handoff

**Goal:** Connect the approved reflection/planning interaction to durable intent and actual actions,
then prove that next morning starts from it. **Dependencies:** slices 1–6.

Read the [approved evening flow](../specs/2026-09-10-evening-planning-flow.md),
[behavior matrix](2026-09-10-today-briefings-behavior-and-verification.md), and shared plan.

## Files

Existing: `apps/web/src/today/evening-mode.tsx`, `today-page.tsx`,
`apps/web/src/shell/chat-controls-context.ts`, existing chat drawer/composer/session clients;
`packages/chat/src/live-routes.ts`; composition-root interview wiring;
`packages/briefings/src/compose-evening.ts`, `plan-context.ts` from slice 4;
Calendar day-plan API/service/repository from slices 1–2.
Proposed focused UI: `apps/web/src/today/evening-planning.tsx` and an evening draft/controller only
if it cannot remain cohesive in the component. Reuse `briefing-dialog.tsx` and `day-plan-review.tsx`.
Tests: extend `today-evening-mode`, `briefings-evening`, interview seed/action tests; add
`tests/unit/evening-planning.test.tsx` and a cross-day handoff integration/browser scenario.

## Task 1: Reflection and existing decisions

- [ ] Open immediately from the evening recap and show current report/source availability. Preserve
      the working existing chat entry while the new view is developed; do not wait for model setup
      before showing the conversation surface.
- [ ] Load/resume the actor's target-day plan and linked conversation. Reflect, Open commitments,
      Shape tomorrow and Review remain freely navigable; no forced verification checklist.
- [ ] Persist corrected account, priority/capacity and selected commitments through typed plan-draft
      commands. Keep a correction's source/history; changing prose does not complete a task.
- [ ] Inherit task dispositions already made from Today and reconcile newer task state. Tomorrow,
      another date, unscheduled and unchanged choices use the canonical task/action semantics.
      Changing a task's date is explicit; a moved time block does not silently change its deadline.
- [ ] Handle unavailable report and skipped reflection gracefully using actor-visible facts. Keep
      full free-text input and ongoing draft choices when the user switches agenda topics or closes.

## Task 2: Reuse the actual conversation/action channel

- [ ] Extend the existing `startEveningInterview`/seed context to reference plan id/revision and the
      target local day through owner-checked lookups. Keep model selection and source trust boundaries.
- [ ] Use existing chat session/history/streaming and normal action proposals. Do not mount a second
      ChatDrawer/SSE transport or ship the prototype's fixed reply branches as an assistant.
- [ ] Implement a narrow plan-draft tool/command if structured edits from chat need it. Validate all
      IDs, typed choices and expected revisions server-side; store prose as notes unless it has produced
      a validated, reviewable action. Prompt text is never authority to write a calendar.
- [ ] Keep a clear distinction between saving intent and applying selected blocks. Ask Moss and
      manual review both route calendar effects through the same plan apply service and policy.
- [ ] Respect no-provider, provider-error, rejected action, disconnected/reconnected session and
      multi-device revision changes. Preserve choices and offer the existing configuration remediation.

## Task 3: Review, save, and real handoff

- [ ] Review additions/moves/removals, corrections and notes against the current calendar. Honor
      current `off|suggest|auto`, existing committed blocks, protected events and source freshness.
- [ ] Moving/removing committed blocks requires the same additional move/removal-set confirmation from slice
      2 when current family policy requires it, including in automatic scheduling mode. Saving evening intent is not destructive authorization. Cancelled
      confirmation preserves the draft and existing events without beginning the mixed apply batch.
- [ ] A lighter day reduces proposed work without deleting unselected tasks. Zero selected blocks,
      delayed task choices, and explicitly unscheduled tasks remain valid.
- [ ] Saving with suggestion mode persists intent/proposals; automatic mode applies eligible blocks
      through the normal policy. Partial/failed effects remain visible and retryable, never a false
      “tomorrow is ready” result. Resume links load server-confirmed draft/operation state.
- [ ] Link the saved plan to the evening run when present. Next morning's actual scheduled/manual
      run reads that plan for the target date/timezone, reports overnight differences, and carries the
      selected capacity/priority/corrections without repeating the interview.
- [ ] Update Today recap/tomorrow projection and related task/calendar queries after acknowledgement.
      An automatic→proposal preference switch keeps existing blocks and proposes their changes rather
      than erasing/recreating them.
- [ ] Update Today core, Briefings, Calendar and any changed chat capability metadata for real
      interview, resume, review, save, failure and handoff behavior.

## Verification and stop

- [ ] Tests: reflect/correct without false completion; existing Today decision inheritance; free text
      and typed draft retention; another-day task change versus block time; lighter day; no selected
      blocks; rejected/failed actions; partial effects/retry; current policy; focus and mobile shell.
- [ ] Protected integration: evening intent survives reload/restart, owner/run access checks, a new
      morning run for the correct local day consumes it, overnight calendar change causes safe review,
      and duplicate worker/UI requests do not create duplicate events.
- [ ] Browser: exercise the actual evening→next-morning path with controlled clock/source fixtures,
      not two unrelated sample scenes. Preserve existing rich Wellness and email-action workflows.
- [ ] Run scoped static checks and affected morning/calendar/briefing regressions.

Session checkpoints: typed reflection/draft; chat/action integration; real cross-day handoff.
Stop with both briefings using the same persisted plan and authorizations.
