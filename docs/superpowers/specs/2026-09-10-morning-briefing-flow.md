# Morning briefing and plan review

**Status:** Morning interaction and visual treatment approved and locked September 10, 2026.
**Approval:** Ben said “Looks great! Let's lock that in” after reviewing direct acceptance of all
time blocks and news/sports prose, enabled by default with individual opt-outs. Today’s composition,
weather, evening flow, and useful-only copy direction remain settled.

## Purpose

Morning is the prepared execution brief: what matters, what changed overnight, and how the day fits.
It carries forward evening intent without repeating the reflection/planning interview. Reading the
briefing is optional; Today already presents the assessment, weather, schedule, preparation, module
actions, news, and sports.

## Approved interaction

- **Read:** Open “Read the full morning briefing” from Today. The report starts with the proposal
  priority inherited from last night, calls out the review moving from 2pm to 1pm, then explains
  preparation, follow-up, and travel. Calendar-change evidence and source times expand on request.
  Preparation materials open inside the briefing with a return link.
- **Review:** Open “Review task blocks” beside Today’s proposed plan, or use the briefing’s review
  tab. Automatic scheduling instead offers “Adjust task blocks”; the prepared calendar requires no
  new approval just to begin the day.
- **Adjust:** Each task has a time and placement control. Add a proposed block to the calendar,
  keep it proposed, or leave the task unscheduled. Existing scheduled blocks can be moved or removed;
  removing a block leaves its task and deadline intact.
- **Accept all:** “Accept all time blocks” is directly available from the readable briefing and
  applies the proposed blocks in one click, keeping the briefing open for reading. The review also
  offers this action; it respects edited times and explicitly unscheduled tasks. Conflicts prevent
  acceptance, and failures retain the choices for retry. Pending edits from review must be reviewed
  before using bulk acceptance from the reading surface.
- **Inspect:** The schedule updates beside the choices. Unsaved additions say “To schedule,” and
  moved calendar blocks say “Time change to save.” A change summary names additions, moves, proposal
  edits, and removals before applying them.
- **Return:** Applying changes returns to Today with updated schedule times and placement states,
  briefing assessment, preparation time, material reference time, and task detail times. Unaccepted
  proposals stay distinguishable; unscheduled tasks remain visible with the proposal’s due date.
- **News and sports:** After the day’s operational prose, include short editorial summaries and
  photos. News explains the lead transport story and a second battery-development story. Sports
  leads with the Mariners and Storm, connects scores to how the games developed, then covers
  noteworthy results elsewhere and tonight’s games. Top links jump directly to either section;
  deeper-reading links return to the corresponding Today section.

News and sports are on by default. Independent morning-briefing preferences let the user exclude
either; explicit exclusions and disabled modules take precedence. The prototype’s News/Sports
checkboxes in its demo controls illustrate these preferences and update `news=off` / `sports=off`
in the preview URL. They control briefing inclusion, not module installation or Today’s sections.

Desktop uses a report and schedule in two columns. Phone uses the approved full-screen dialog
treatment with an expandable schedule and a visible action footer. Escape and Back to Today retain
unapplied choices and return focus to the entry point. Reading shows the saved plan; the review tab
contains pending edits. No draft-storage narration is added to the product copy.

## Recovery and source states

- Overlapping task times or calendar commitments prevent applying the plan. The conflict names the
  affected items and offers the prepared task times. Meetings, lunch, and travel stay in place.
- A simulated save failure leaves Today unchanged and retains all review choices for retry.
- With no evening plan, the report uses task deadlines and the calendar without claiming an
  evening conversation occurred.
- With delayed email, a targeted notice identifies the last update and the possibility of unseen
  replies. Calendar and task information remain available. Refresh demonstrates recovery.
- When the briefing is unavailable, the schedule and review remain usable; Try again demonstrates
  the report becoming available.
- Leaving every task unscheduled is supported without removing fixed calendar commitments.
- Changing the scheduling preference does not silently accept or remove saved morning decisions.

## Preserved approved references

These bounded desktop and phone captures preserve the locked revision independently of the preview
server. All content is fictional; these are design references, not live-path release evidence.

| Surface                         | Desktop                                                                   | Phone                                                                    |
| ------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Briefing with accept-all action | [Reference](assets/2026-09-10-morning-briefing/1440-proposed-read.png)    | [Reference](assets/2026-09-10-morning-briefing/375-proposed-read.png)    |
| Review proposed blocks          | [Reference](assets/2026-09-10-morning-briefing/1440-proposed-review.png)  | [Reference](assets/2026-09-10-morning-briefing/375-proposed-review.png)  |
| Automatically prepared day      | [Reference](assets/2026-09-10-morning-briefing/1440-automatic-read.png)   | [Reference](assets/2026-09-10-morning-briefing/375-automatic-read.png)   |
| Adjust existing blocks          | [Reference](assets/2026-09-10-morning-briefing/1440-automatic-review.png) | [Reference](assets/2026-09-10-morning-briefing/375-automatic-review.png) |

Additional references: [news prose and photo](assets/2026-09-10-morning-briefing/1440-news.png),
[sports prose and tonight](assets/2026-09-10-morning-briefing/375-sports.png), and
[partial plan changes](assets/2026-09-10-morning-briefing/partial-review.png).
[Recorded checks](assets/2026-09-10-morning-briefing/checks.json) cover the locked revision.

## Artifact and validation

Source: `~/Jarv1s/.superpowers/brainstorm/today-briefings-20260909/`.
On preview port 8767, use `?mode=morning&blocks=proposed&brief=open` to review the proposed-block
path, or `blocks=automatic` for an already prepared calendar. The dialog’s Preview state selector
offers no evening plan, unavailable briefing, delayed email, and save failure examples.

`node .superpowers/brainstorm/today-briefings-20260909/check-morning.cjs` passed 16 responsive views
at widths 320, 375, 768, and 1440, plus reading, source evidence, materials, partial acceptance,
conflicts, draft resume, save retry, changed Today facts, task details, source recovery, and zero-block
checks. Desktop reading and phone review crops were visually inspected. The underlying Today suite
passed 36 responsive and six quiet-night states; the evening suite passed 32 conversation views
and its recovery cases after the final integration. Captures and results are in
`captures/morning-flow/` inside the preview source.
Additional checks cover direct bulk acceptance, conflict/failure handling, retaining explicit
unscheduling, default inclusion and independent opt-outs, photo loading, followed-team prose,
tonight/quiet-night content, and links back to Today’s news and sports sections.

All content is fictional and all edits remain in memory. The Wednesday morning uses a fictional
Tuesday evening intention; it is a separate sample from the approved Wednesday-evening/Thursday
handoff. Time controls offer representative choices, not a complete scheduler. Source refreshes,
save failures, and material contents are simulations. No production or account changes, model
calls, calendar writes, or Git writes are part of this design pass.

## Existing capabilities and remaining work

Ben explicitly noted that much of the plumbing may already exist and asked that the full
implementation plan account for it. Before planning build slices, map each approved interaction
to the current UI, APIs, scheduling/proposal actions, briefing composition, preferences, source
freshness, module contributions, and news/sports data. Identify what can be reused, what needs
extension, and what is missing. Verify the current capabilities rather than treating the prototype
as a request to rebuild those systems. The present source observations below are starting points,
not a completed functionality audit.

The current `MorningBriefingSection` in `apps/web/src/today/today-page.tsx` renders report prose,
loading/unavailable states, and source staleness. `BriefingFreshnessList` exposes source ages.
The product brief in `docs/brand/product-goals-and-ideals.md` establishes morning as reconciliation
of evening intent with new reality. Preserve source freshness and ordinary action permissions
when translating this design into the product.

Next: resolve remaining quiet/empty days, module composition,
earlier briefing access, and ongoing daytime changes. Free-form planning and actual source/action
integration need the completed implementation spec. The saved morning changes are demonstrated
on morning Today; the daytime and evening modes remain their separate representative scenes.

The [implementation plan](../plans/2026-09-10-today-briefings.md) now contains that plumbing audit,
file-targeted build slices, proposed page-state treatments, and verification criteria. It preserves
the approvals above; product implementation and runtime proof remain outstanding.
