# Today and the morning/evening briefings

**Status:** Today visual direction, weather prominence, evening planning, and morning briefing flow locked September 10, 2026. The implementation plan is complete for review; its remaining page-state treatments are proposed.
**Approval:** Ben responded “This looks great!” to the revised preview after requesting compact sports
scores, tonight's games, photos, and module quick actions. After reviewing the evening flow, copy
cleanup, and more prominent weather, Ben confirmed: “Very nice, let's lock this in please.”
He subsequently approved the morning flow, including direct bulk acceptance and default-on
news/sports with prose: “Looks great! Let's lock that in.”
**Scope:** Collaborative product design. This is not yet a complete implementation spec or build plan.

## Goal

Moss is the user's chief of staff. Opening it in the morning should reveal a prepared, realistic day
with time assigned to tasks, meetings, events, preparation, and travel. The evening should account
for the day and help prepare tomorrow. News and sports keep the user informed beyond their schedule.

## Approved visual direction

- Keep the relationship to Tasks: Bone, confident forest fields, restrained decorative gold,
  sans-serif hierarchy, useful rules, and comfortable spacing.
- Morning leads with Moss's concise assessment, followed by a complete schedule and preparation.
  Distinguish accepted commitments from flexible or proposed task blocks.
- Automatic placement and proposed plans both exist, according to user settings. Do not collapse
  this into one global behavior or ask Ben to choose again.
- The complete day plan precedes news and sports. Section links allow direct access.
- Give weather a prominent row in the Today header: larger temperature, conditions, and high/low
  (overnight low in evening), readable on phones as well as desktop.
- Keep copy focused on useful context, decisions, and consequences. Remove filler such as
  “Your draft stays in this tab,” generic reassurance, and repeated preview-save narration.
- Evening leads with the recap, open commitments, tomorrow's shape, and an optional planning
  conversation. Its [detailed flow](2026-09-10-evening-planning-flow.md), including the revised copy, is approved.
- Sports uses compact scores for multiple games. Followed teams come first; other games earn their
  place through a significant story. Remove the oversized single-game result card.
- Provide a separate Tonight section, including a clear quiet-night state.
- Use photographs in both news and sports. The study's generated photos are illustrative assets,
  not real reporting or approved production content.
- Make room for module quick-action widgets. Wellness demonstrates medication logging and a
  check-in entry point. The approved study places quick actions alongside the plan on desktop and
  immediately before it on phones.

## Preserved visual references

These bounded captures preserve the approved revision independently of the preview server. They
contain fictional data and are design references, not live-path release evidence.

| Surface                            | Desktop                                                                         | Phone                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Initial morning and module actions | [Reference](assets/2026-09-10-today-briefings/morning-1440-opening.png)         | [Reference](assets/2026-09-10-today-briefings/morning-375-opening.png)         |
| Initial evening                    | [Reference](assets/2026-09-10-today-briefings/evening-1440-opening.png)         | [Reference](assets/2026-09-10-today-briefings/evening-375-opening.png)         |
| Approved weather revision          | [Reference](assets/2026-09-10-today-briefings/morning-1440-opening-weather.png) | [Reference](assets/2026-09-10-today-briefings/morning-375-opening-weather.png) |
| News                               | [Reference](assets/2026-09-10-today-briefings/morning-1440-news.png)            | [Reference](assets/2026-09-10-today-briefings/morning-375-news.png)            |
| Sports                             | [Reference](assets/2026-09-10-today-briefings/morning-1440-sports.png)          | [Reference](assets/2026-09-10-today-briefings/morning-375-sports.png)          |

Interactive source: `~/Jarv1s/.superpowers/brainstorm/today-briefings-20260909/`.
Run its `server.cjs` with Node; port 8767. Run `check.cjs` for the preview checks.
The study README records asset prompts and the limits of simulated interactions.

## Remaining design work

- The [morning flow](2026-09-10-morning-briefing-flow.md) is approved: reading, overnight-change
  evidence, preparation materials, partial and bulk acceptance, adjustment, return to Today, and
  default-on news/sports with independent opt-outs and prose about big stories and followed teams.
- Design quiet/empty days, unavailable or delayed briefings, missing sources, disabled modules,
  morning/daytime schedule conflicts, and a skipped evening conversation. Evening conversation
  conflict and recovery treatments are covered by the approved flow.
- Resolve access to earlier briefings and how meaningful daytime changes appear.
- Check the widget composition with additional enabled modules and preserve each owning module's
  capabilities. The sample check-in dialog is not an approved Wellness form redesign.

## Implementation readiness and verification

The [implementation plan](../plans/2026-09-10-today-briefings.md) records four low-cost agent
explorations of existing UI, briefing, scheduling and module plumbing, then maps reuse and actual
gaps to eight implementation slices. Its linked behavior matrix proposes the remaining page
states above. These production reconciliations do not change the visual approvals in this spec.

The local source confirms generic Today module contributions and existing Wellness medication and
check-in dialogs. Those capabilities should be preserved through their owning modules. No production
registration contract or API change has been designed or implemented by this study.

The study copies its palette and font from the approved Tasks study. Actual live theme/font tokens
and current Today behavior must be reinspected before implementation; production fidelity has not
been verified. No global theme migration is authorized here.

The revised preview passed 36 responsive states and six quiet-night states at widths 320–1440,
including photo loading, score ordering, medication logging/correction, check-in state, and the
earlier schedule/planning interactions. Desktop and phone crops were visually reviewed.

Implementation still requires a completed approved spec, a tracked build task, preservation of
current module functionality, truthful app-map declarations, and the repository's verification
requirements. No product code, commit, pull request, or deployment is included in this approval.
