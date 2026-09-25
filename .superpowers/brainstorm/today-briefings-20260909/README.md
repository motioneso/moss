# Today and the daily briefings — approved design study

Visual direction approved September 10, 2026. Revision 2, including the revised sports,
photography, and module-widget treatment, was approved. The evening flow, revised copy, weather
prominence, and morning flow were subsequently approved and locked. The morning flow includes
direct bulk acceptance and default-on news and sports with prose and independent opt-outs. See the approval record in
`docs/superpowers/specs/2026-09-10-today-briefings-design.md`.

The approved product direction treats Moss as a chief of staff: opening it should give a clear picture of the day,
with tasks, meetings, and events placed in time. Automatic placement versus proposals is controlled
by user settings. The complete day plan comes before news and sports. Followed teams lead sports.

This study explores one composition in morning, daytime, and evening states. The morning pairs a
prepared schedule with meeting preparation; evening leads with the recap, unresolved commitments,
and tomorrow's shape. A section index provides direct access to news and sports below the plan.

The visual family follows the approved Tasks references: Bone, forest, restrained gold, Archivo
display, and a sans body. Its local font and palette are copied from the existing Tasks study.
This is design-reference continuity, not a claim of fidelity to current production tokens. The
current live Today page has not been reinspected during this study. Production theme/font readiness
and current capabilities must be reconciled before implementation.

From `~/Jarv1s`, start the loopback-only preview server in one terminal:

```sh
node .superpowers/brainstorm/today-briefings-20260909/server.cjs
```

Install Playwright's Chromium browser once before running the checks:

```sh
pnpm exec playwright install chromium
```

In another terminal, run the responsive checks:

```sh
node .superpowers/brainstorm/today-briefings-20260909/check.cjs
node .superpowers/brainstorm/today-briefings-20260909/check-evening.cjs
node .superpowers/brainstorm/today-briefings-20260909/check-morning.cjs
```

Open `http://127.0.0.1:8767`. Query parameters select `mode=morning|day|evening` and
`blocks=automatic|proposed`. `night=games|quiet` switches the upcoming-games example.
The preview controls at the bottom switch these states.
Add `plan=open` with `mode=evening` to open the approved evening conversation directly.
Add `brief=open` with `mode=morning` to open the approved morning briefing directly.

Revision 2 replaces the single wide result card with four compact scores: followed teams first,
then games worth covering for their story. A photo-led recap sits alongside, and a separate Tonight
section shows upcoming or in-progress fixtures. News also has a lead photograph. All photos are
AI-generated placeholders; [asset paths and exact prompts](assets/PROMPTS.md) are preserved locally.

Module quick actions sit beside the schedule on desktop and immediately before it on phones.
Wellness is the example contribution: expandable medication logging with correction, and a quick
check-in entry point. Its state carries across the preview's day modes and resets on reload. The
check-in form is an interaction placeholder, not an approved replacement for Wellness's existing
emotion, feeling, sensation, intensity, and note controls. Production already has generic Today
module contributions and Wellness medication/check-in dialogs; this study changes no registration
contracts, module APIs, or production behavior. The quick-action placement is part of the approved visual direction.

Try task/event details, preparation documents, full briefing prose and rationale, accepting proposed
blocks, carrying/rescheduling/dropping the evening task, undo, and the sample planning conversation.
Names, tasks, events, documents, wellness labels, and conversation data are illustrative. News,
team results, and schedules are layout examples, not current reporting. No account access, APIs,
model calls, database writes, or production changes. Changes last only in the tab and reset on
reload. Article and document dialogs illustrate entry points rather than real content viewers. The
conversation uses fixed sample replies; it does not perform planning.

The check exercises 36 responsive states plus six quiet-night states at widths 320–1440. It checks
plan/news/sports order, followed-team ordering, photo loading, medication logging/correction,
check-in state, and the prior preview interactions. The check scripts can generate bounded viewport
crops under `captures/` for design review; those are not live-path release evidence. The committed
PNGs under `docs/superpowers/specs/assets/2026-09-10-*` remain the visual authority. The interactive
preview uses a fictional sample profile, so its profile labels may differ from those PNGs.

The approved evening conversation covers reflection/correction, prior task decisions, capacity
and priority, individual block selection, review, saving, and a sample morning handoff. It preserves
drafts and unsent notes. Preview states demonstrate a missing briefing, calendar conflict, and save
failure/retry. Proposed adjustments preserve existing calendar blocks. `check-evening.cjs` exercises
32 responsive conversation views and the interaction/recovery cases; it writes captures under
`captures/evening-flow/`. See `docs/superpowers/specs/2026-09-10-evening-planning-flow.md`.

The approved evening treatment removes low-value copy, including the draft-in-tab message. Today
also has a more prominent weather row with temperature, conditions, and high/low, including on
phones. Weather is illustrative like the other preview data. These revisions were approved and
locked September 10.
Preserved references are linked from both design documents; no repeat approval is needed for this
settled treatment.

The approved morning interaction covers: readable report, overnight-change evidence,
preparation materials, optional plan review, partial acceptance, task-time adjustments, unscheduled
tasks, conflict handling, and return to Today with the updated facts. Preview states cover no evening
plan, unavailable briefing, delayed email, and save failure/retry. It uses the Wednesday sample day;
the approved evening/Thursday handoff is a separate scene. `check-morning.cjs` covers 16 responsive
views plus interaction and recovery checks; it writes captures under `captures/morning-flow/`.
See `docs/superpowers/specs/2026-09-10-morning-briefing-flow.md` for scope and simulation limits.

Latest morning revision adds “Accept all time blocks” directly to the reading surface and review.
It applies proposals in one click and preserves explicitly unscheduled tasks. News and sports now
appear within the briefing, with photos and prose on major stories, followed teams, other notable
scores, and tonight’s games. Both default on; demo checkboxes independently exclude either from the
briefing (`news=off`, `sports=off`). This revision was approved and locked.

This design study leaves quiet/empty days, delayed briefings, missing sources, disabled modules,
skipped evening preparation, earlier briefing access, and additional widget compositions out of
scope. Design approval covers the composition only; implementation is tracked separately in issue
#2521.

The implementation plan maps the approved design to existing plumbing first, verifies reusable
capabilities, and identifies gaps before proposing new systems.
