# Evening planning conversation

**Status:** Interaction and visual treatment approved and locked September 10, 2026.
**Approval:** After reviewing the evening flow and revised copy, Ben said: “Very nice, let's lock
this in please.” This includes reflection, commitments, shaping tomorrow, review, recovery, and the
sample morning handoff. The complete morning interaction was subsequently approved in the
[morning spec](2026-09-10-morning-briefing-flow.md); production implementation remains outstanding.

## Intent

Help the user leave the day accounted for and give tomorrow a realistic direction. Reflection is
optional; the agenda is freely navigable. Existing scheduling settings determine whether selected
task blocks are scheduled or saved as proposals. Morning starts with these intentions and reconciles
overnight changes without repeating the interview.

## Approved flow

1. **Reflect:** Moss offers a concise account. The user can acknowledge it, correct the unsent
   follow-up, or say the day took more energy than expected. Corrections distinguish the meeting
   from its unfinished follow-up; they do not invent evidence of task completion.
2. **Open commitments:** Carry forward the choice already made on Today. Give the bike task a
   place tomorrow, another date, an unscheduled place on the list, or leave it undecided.
3. **Shape tomorrow:** Choose a steady or lighter day, one main priority, and when task time starts.
   A lighter day suggests a single work block. Appointments and travel remain protected.
4. **Review:** Inspect corrections, notes, and individual task blocks. Select which blocks to
   include. Changes to an existing plan explicitly identify additions, moves, and removals.
5. **Finish:** Save under the current scheduling setting, return to Today, or inspect a sample
   next-morning handoff. Further adjustment is available.

Desktop keeps the conversation and changing plan side by side. Phone uses a full-screen native
dialog with an expandable plan summary and a visible action footer. Leaving or pressing Escape
retains the draft and unsubmitted notes in the tab, then returns focus to the entry point.
This is underlying preview behavior, not a message to repeat in the product UI. Keep visible copy
focused on useful context, decisions, and consequences; keep prototype instructions in demo controls.

## Recovery and scheduling

- A moved appointment reveals an overlap and offers a new task start time; saving waits for the
  conflict to be resolved. The appointment and travel are not moved by the conversation.
- A simulated save failure preserves choices and supports retry. This illustrates a failure
  before any changes; partial backend failures and reconciliation are specified for review in the
  [implementation plan](../plans/2026-09-10-today-briefings.md).
- An unavailable evening briefing allows planning from the sample calendar, tasks, and user notes.
- Zero selected task blocks is valid. Removing a time block keeps its task on the list.
- Switching from automatic scheduling to proposals retains existing calendar blocks. Proposed
  moves or removals remain visibly pending, including in the morning handoff, until accepted.
- The setting in effect when the conversation resumes governs new changes.

## Preserved approved references

These bounded desktop and phone captures preserve the approved copy revision independently of the
running preview. They contain fictional content and are design references.

| Flow             | Desktop                                                    | Phone                                                     |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| Reflect          | [Reference](assets/2026-09-10-evening-planning/1440-0.png) | [Reference](assets/2026-09-10-evening-planning/375-0.png) |
| Open commitments | [Reference](assets/2026-09-10-evening-planning/1440-1.png) | [Reference](assets/2026-09-10-evening-planning/375-1.png) |
| Shape tomorrow   | [Reference](assets/2026-09-10-evening-planning/1440-2.png) | [Reference](assets/2026-09-10-evening-planning/375-2.png) |
| Review           | [Reference](assets/2026-09-10-evening-planning/1440-3.png) | [Reference](assets/2026-09-10-evening-planning/375-3.png) |

Additional references: [proposed changes](assets/2026-09-10-evening-planning/changed-plan-review.png),
[saved plan](assets/2026-09-10-evening-planning/changed-plan-saved.png), and
[morning handoff with pending changes](assets/2026-09-10-evening-planning/changed-plan-handoff-phone.png).
The [recorded checks](assets/2026-09-10-evening-planning/checks.json) cover the approved revision.

## Interactive artifact and verification

Source: `~/Jarv1s/.superpowers/brainstorm/today-briefings-20260909/`.
Open the local preview on port 8767 with `?mode=evening&blocks=automatic&plan=open`.
Use the dialog’s Preview state selector for unavailable briefing, moved appointment, and save failure.

Run `node .superpowers/brainstorm/today-briefings-20260909/check-evening.cjs` for 32 responsive
conversation views plus interaction/recovery checks. `check.cjs` covers the underlying Today study’s
36 responsive and six quiet-night states. Cropped references and results are in
`captures/evening-flow/` inside the preview directory.

The study uses fictional content and fixed suggested replies. Free text is retained as notes, not
interpreted by a model. All choices reset on reload. There are no account, API, calendar, database,
or production writes. Browser checks are prototype evidence, not live-path release verification.

## Relationship to the existing product

The existing evening interview seed in `packages/chat/src/live-routes.ts` uses reflection and
planning, with ordinary chat action proposals for mutations. `EveningPrepCard` in
`apps/web/src/today/evening-mode.tsx` provides an optional entry from the recap. Preserve the normal
action permissions when implementing this interaction; the study’s simulated save is not a new
authorization model.

The [implementation plan](../plans/2026-09-10-today-briefings.md) now maps existing plumbing,
durable evening intent, morning reconciliation and remaining page states into build slices. Its
production reconciliations are proposed for review; implementation requires a tracked build task
and the readiness/verification gates recorded there.
