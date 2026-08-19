<!-- Hallmark · pre-emit critique: P5 H5 E5 S5 R5 V4 -->

# Job Search UI post-onboarding re-review

**Date:** 2026-07-30

**Reviewed application build:** `d14a0ee81fe8dbc2739bf2dc46748058e24ddb08`

**Current review branch:** `research/1246-ui-critique` at `fdb4a0b27af96467a33de3e7503a9d9b58b6ac35`

**Scope:** populated, active Job Search experience after résumé-led onboarding; research and
critique only

## Executive verdict

The completed experience is more usable than the setup state, but it is not yet trustworthy enough
to drive job decisions. Populated data confirms that the dense Matches list is the right visual
foundation. It also exposes a more serious problem than the earlier empty-state review could see:
the system's strongest signals contradict its own evidence.

A Jacobs building-design role is labelled **Strong fit** with Want **74**, while the explanation
under those labels calls it “a different profession,” “a title collision,” and “not a true skill
match.” The completed chat has the same coherence failure at a different seam: the user explicitly
confirmed LinkedIn, the structured UI is active with LinkedIn enabled, yet the transcript ends
“Waiting for your confirmation.”

Operational status is also unreliable in smaller ways. Matches says **New 53** while Overview says
**New 47**. Overview announces the already-populated search is “ready to run.” Monitors says checks
happen “every morning,” while the module manifest schedules the crawl every six hours. Those
contradictions make the polished hierarchy feel less dependable, not more.

The right response is not a redesign. Keep the brand and list. First make labels agree with reasons
and source-of-truth state; then repair list continuity, monitor semantics, filtering, and the
overbuilt utility-screen hierarchy.

## Method and state

The review used the live dev UI at `http://100.64.98.99:5197` in headless Firefox at the required
1280 × 1800 audit viewport. Authentication used the provided environment variables without
printing or storing their values.

The active profile contained:

- 53 roles on the board, 47 read and scored;
- five architecture-oriented titles;
- San Diego with remote preferred;
- a $190,000 base floor;
- résumé version 1, unchanged at 1,865 characters; and
- LinkedIn enabled as the only configured source.

The pass opened scored and queued match inspectors and the global chat drawer. It did not activate
Search now, Run now, the monitor switch, Save, Pass, the external posting link, or Send. A
before/after read of profile, criteria, résumé, and portal state was identical.

The reproducible script and action log were kept in the gitignored local output directory. The
reviewed states were:

- populated Matches
- self-contradictory Strong fit
- ordinary scored inspector
- queued inspector
- active Overview
- completed Profile
- active Monitors
- completed onboarding transcript

## What changed from the first review

| Earlier finding                                   | Active-state result                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Chat-first setup did not complete explicit intent | **Partly improved.** LinkedIn is enabled and the profile is active, but the transcript still says the confirmed write is pending. |
| Mobile inspector sits under the fixed header      | **Not re-tested.** The required Webwright viewport was 1280 × 1800.                                                               |
| Inspector destroys list position                  | **Still present.** Opening from `scrollY=1719` and returning lands at `0`.                                                        |
| Triage is weak for a large result set             | **Still present and more concrete.** The live board now has 53 roles.                                                             |
| Monitor switch has no accessible name             | **Still present.** The accessibility tree exposes an unnamed checked checkbox.                                                    |
| Search now is enabled with no sources             | **No longer applicable.** LinkedIn is enabled.                                                                                    |
| Overview mislabels aggregate readiness as Profile | **Resolved in this state.** Profile now says “Ready to search.”                                                                   |
| Setup status buries the next action               | **Changed, not resolved.** Completed setup still dominates an active operational dashboard.                                       |
| Tabs promise unimplemented arrow behavior         | **Still present.** ArrowRight leaves focus on Matches.                                                                            |
| Want score has unjustified precision              | **Still present.** Values such as Want 74 and Want 80 appear without definition, calibration, or timestamp.                       |
| Profile hierarchy is too ceremonial               | **Improved with real data, but still overbuilt and weak for correction.**                                                         |
| Utility screens repeat one macrostructure         | **Still present.**                                                                                                                |
| Heading hierarchy is muddy                        | **Still present in inspectors.** Job Search and the role title are both `h1`.                                                     |

## Ranked findings

### 1. “Strong fit” can mean “different profession”

**Severity:** High

**Evidence.** The Jacobs “Senior Project Architect & Design Manager” row is green and labelled
Strong fit. Its inspector keeps that label and shows Want 74. The adjacent reasoning says the
posting is a building/civil role, “a different profession from software/platform architecture,”
and that “architect” is “a title collision, not a true skill match” (self-contradictory Strong
fit).

This is not merely a questionable recommendation. The output contradicts itself on one screen. The
UI's qualitative band is derived from a score of at least 85
(`external-modules/job-search/src/web/keyline.tsx:115-120`), so “Strong fit” is a confident
classification, not neutral metadata.

**Why it matters.** The list is designed for fast trust: green rule, green label, high position.
Users should not have to open every apparently strong match to discover that the explanation
rejects the classification. The saturated signal also makes genuine strong matches visually
indistinguishable from obvious title collisions.

**Smallest credible remedy.** Add a coherence gate before persisting/displaying the band. Evidence
such as “different profession,” “title collision,” or a dealbreaker conflict must cap Fit below
Strong. Until that is reliable, demote the list label to “Review” when the explanation contains
explicit disqualifying evidence.

### 2. The completed transcript and structured state disagree

**Severity:** High

**Evidence.** The transcript contains the user's exact confirmation to enable LinkedIn and complete
onboarding. The next and final assistant message restates the pending write and says “Waiting for
your confirmation before calling `portal.set-enabled`” (completed onboarding
transcript). At the same time, the shell says Monitoring on, Profile is active, and
Monitors shows LinkedIn enabled (active Monitors).

**Why it matters.** Chat is the prescribed correction path for source configuration. A user cannot
know whether the action happened by reading the conversation that initiated it. This violates the
human–AI requirements for clear invocation, correction, and action feedback in Microsoft's
[Guidelines for Human–AI Interaction][ms-hai].

**Smallest credible remedy.** Render a structured result from the tool response after every
state-changing chat turn: “LinkedIn enabled” or “Not changed.” Hydrate that result from current
source-of-truth state when the drawer opens, so a stale model sentence cannot remain the terminal
status.

### 3. Inspecting a role still destroys the user's place

**Severity:** High

**Evidence.** The final read-only run opened a role from `scrollY=1719`. The inspector moved to the
top, and Back to matches returned to `scrollY=0` rather than the originating row. The board now
contains 53 roles.

**Why it matters.** This turns repeated triage into repeated re-navigation. It violates continuity
and Nielsen's [recognition rather than recall][nielsen-heuristics] principle.

**Smallest credible remedy.** Store the list scroll position and selected row before opening an
inspector. Restore both on Back. Do not replace the existing inspector pattern.

### 4. The 53-role board still lacks triage controls

**Severity:** High

**Evidence.** Matches provides New/Saved/Passed and Fit/Want sorting, but no title, company,
location, posting-date, source, or score-band filters. Save and Pass remain inside the inspector,
which triggers the position-loss defect (populated Matches).

**Why it matters.** The board can display volume but cannot efficiently reduce it. The problem is
now observable rather than hypothetical: the first screen contains many similarly styled Strong
fit rows, including false positives.

**Smallest credible remedy.** Add one compact filter row for query/company, location, posted date,
and Fit band. Add keyboard-operable Save/Pass row actions. Do not start with a Kanban rewrite.

### 5. The monitor action row is visually ambiguous and inaccessible

**Severity:** High

**Evidence.** The only enabled-source row places a low-emphasis Run now button directly beside an
unlabelled switch. “Enabled” appears at the far right as status, not as the switch's label
(active Monitors). The accessibility tree exposes the switch as a checked checkbox
with no name. Source confirms the label wraps only decorative track/thumb spans
(`external-modules/job-search/src/web/screens/settings.tsx:239-252`).

**Why it matters.** Visually, the switch can be read as a Run now toggle. For screen-reader users,
it has no board or action name at all, violating WCAG [4.1.2 Name, Role, Value][wcag-name].

**Smallest credible remedy.** Separate the controls. Make Run now a conventional button. Give the
switch visible “LinkedIn monitoring” text and `aria-label="Enable LinkedIn monitoring"` (or an
equivalent associated label).

### 6. “Every morning” is false operational copy

**Severity:** Medium

**Evidence.** Monitors says, “I check them every morning” (active Monitors). The
module manifest schedules `job-search.crawl-sweep` with cron `17 */6 * * *`—four times per day,
every six hours (`external-modules/job-search/jarvis.module.json:511-517`). The portal response
shown by this screen does not contain schedule metadata; even `MonitorRow`'s source notes that
Schedule does not exist on that wire.

**Why it matters.** Cadence is a user-facing promise. Hard-coded personified copy makes the product
sound reassuring while describing behavior it cannot derive from the state it displays.

**Smallest credible remedy.** Prefer “Checks automatically” until runtime schedule metadata is
available. If cadence is exposed, render the actual configured schedule from one source of truth.

### 7. “New” means 53 on Matches and 47 on Overview

**Severity:** Medium

**Evidence.** Matches shows New 53 (populated Matches); Overview shows New 47
(active Overview). The difference is the six queued, unscored postings. Matches maps
every state other than seen/dismissed into the New bucket
(`external-modules/job-search/src/web/screens/board.tsx:165-169`), while Overview counts only rows
whose literal state is `new`
(`external-modules/job-search/src/web/screens/overview.tsx:335-349`).

**Why it matters.** Two screens use the same label for different sets. Users cannot reconcile board
progress or trust the summary.

**Smallest credible remedy.** Reuse one shared bucket function. If the distinction is intentional,
rename the figures “Unreviewed 53” and “Scored new 47.”

### 8. Active Overview is still designed like a setup completion page

**Severity:** Medium

**Evidence.** The profile is active, LinkedIn has successfully run, and 53 roles exist. Overview
still leads with “Setup · 5 of 5 complete,” a huge “Your search is ready to run” headline,
Readiness Gates, and five Done checkpoints (active Overview).

**Why it matters.** The dominant hierarchy describes a completed past event instead of current
operations. It spends the largest type on a stale next step and leaves no strong answer to “What
needs my attention now?”

**Smallest credible remedy.** After the first successful crawl, switch Overview to an operational
summary: last run, next automatic check, queued items, source issues, and one direct next action.
Collapse completed setup into a small status line or disclosure.

### 9. The inspector's layout fights the data the product actually has

**Severity:** Medium

**Evidence.** LinkedIn rows do not store posting text, so the left “The role” column contains one
short disclaimer and then a large empty field. The high-value Fit and Want evidence is forced into
two narrow columns inside the right half of the screen, producing short, tiring line lengths
(ordinary scored inspector). The queued state leaves even more of the canvas empty
(queued inspector).

**Why it matters.** The layout reserves most space for content the source never supplies and
compresses the evidence users must evaluate.

**Smallest credible remedy.** When posting text is absent, use a single readable column for Jarvis's
read and stack Fit above Want at a 55–75 character measure. Keep the original-posting link and
decision actions close to the title.

### 10. Fit and Want look more calibrated than they are explained

**Severity:** Medium

**Evidence.** Want appears as a bare number and progress bar; Fit appears as a strong qualitative
band. Neither shows denominator, definition, model/version, scoring time, nor uncertainty. The
false-positive case demonstrates that the prose and band can diverge.

**Why it matters.** Precision without a contract encourages over-trust. NIST's
[AI Risk Management Framework][nist-ai] warns that measurements can oversimplify context and gain
unintended authority.

**Smallest credible remedy.** Label Want as `74/100`, define both axes in one sentence, show when
the role was scored, and make explicit negative evidence capable of lowering or invalidating the
band.

### 11. Profile exposes criteria, but dense editable values are hard to scan

**Severity:** Medium

**Evidence.** The completed Profile exposes titles, seniority, location, remote preference, pay
floor, and narrative (completed Profile). In a realistically populated profile, long
removable values render as a tall cloud of variably sized rounded pills. Wrapped labels are centered
while small × controls sit at the far edge, so sentence-length criteria read as mini-cards rather
than editable values.

**Why it matters.** This is the screen where users discover interpretation errors. The oversized
pill treatment obscures field hierarchy and makes comparison slower precisely when the profile has
enough detail to be useful.

**Smallest credible remedy.** Keep the direct edit and remove actions, but render long values as
compact, left-aligned tags or rows with restrained rounding, natural wrapping, and an integrated
remove target. Review the populated state, not only sparse fixtures.

### 12. Tab and heading semantics still overpromise

**Severity:** Low

**Evidence.** The Job Search view uses `role="tab"` but ArrowRight leaves focus on Matches. In an
inspector, both Job Search and the role title are `h1`.

**Why it matters.** The controls are operable with Tab/Enter, so this is not a claim of keyboard
inaccessibility. It is a mismatch with the WAI-ARIA [Tabs Pattern][wai-tabs] and a less useful
document outline.

**Smallest credible remedy.** Either implement roving focus and Arrow/Home/End behavior or use
ordinary navigation buttons. Keep Job Search as `h1` and make inspector titles `h2`.

### 13. Utility screens still share one editorial template

**Severity:** Low; taste with concrete hierarchy cost

**Hallmark tells:** **Default-attractor sameness** and **Eyebrow on every section**

**Evidence.** Overview, Profile, and Monitors repeat an all-caps eyebrow, oversized uppercase
headline, gold strap, description, and heavy rule despite performing different tasks
(active Overview, completed Profile, active Monitors).
Monitors uses most of the viewport to present one source and two actions.

**Why it matters.** The repeated ceremony is the clearest AI-design tell. More importantly, it
causes operational facts and controls to look secondary to decorative page identity.

**Smallest credible remedy.** Preserve type, palette, and rules, but vary hierarchy by task.
Overview should be status-led, Profile field-led, and Monitors control-led. Remove decorative
eyebrows where they do not express a genuine sequence.

## Hallmark audit lens

```text
[major] Default-attractor sameness — Overview, Profile, Monitors
  one utility-screen macrostructure is repeated regardless of task
  → keep the visual system, but let status, fields, and controls produce different page shapes

[major] Eyebrow on every section — Overview, Profile, Monitors, inspector
  decorative uppercase kickers repeatedly label already-labelled content
  → remove non-ordinal eyebrows and let headings/field labels carry hierarchy
```

**Hallmark summary:** 0 critical · 2 major · 0 minor

**Hallmark verdict:** Authored brand with recognizable templating; not wholesale AI slop.

## Strengths to preserve

- **The populated Matches list is still the strongest screen.** Rule-separated rows outperform a
  generic card grid and fit a large queue.
- **Queued scoring is explained honestly.** “Queued for scoring, not dropped” is specific and
  reassuring without pretending a score exists.
- **The reason text can name uncertainty.** The false-positive explanation correctly identifies
  the title collision; the product must make the band respect that evidence.
- **Profile is materially better with real data.** Titles, location, remote preference, pay, and
  narrative are visible together.
- **Safety copy remains unusually candid.** The posting-storage and no-application boundaries are
  worth keeping.
- **The brand remains distinctive.** Warm dark surfaces, forest navigation, restrained gold, and
  green state language should survive the corrections.
- **No desktop overflow was observed.** At 1280 × 1800, `scrollWidth` equalled `clientWidth`.

## Recommended correction sequence

### Fix first

1. Add score/reason coherence validation and prevent explicit domain mismatches from appearing as
   Strong fit.
2. Make chat tool results hydrate from and confirm source-of-truth state.
3. Restore list position after closing an inspector.
4. Name and visually separate the monitor switch and Run now action.
5. Unify the New bucket/count definition across Matches and Overview.
6. Replace the false morning cadence with runtime-derived or schedule-neutral copy.

### Fix next

1. Add compact filters and row-level Save/Pass.
2. Convert active Overview from setup completion to operational status.
3. Reflow inspectors around the absence of stored posting text.
4. Define Fit/Want, show score time, and expose uncertainty.
5. Add a direct criteria correction path.
6. Make tab and heading semantics honest.
7. Reduce repeated utility-screen hero ceremony.

### Do not chase

- Do not replace Matches with cards or a Kanban board before filters and continuity work.
- Do not add more score visualizations until the labels and reasons agree.
- Do not add more setup confirmation blocks; make one source-of-truth status reliable.
- Do not remove the Jarv1s palette or editorial voice.
- Do not use animation, gradients, or decorative AI motifs to make the assistant appear smarter.

## Limits

- This pass deliberately did not activate any state-changing control, so success/error recovery for
  Save, Pass, Run now, monitor toggling, edits, uploads, or chat sends was not tested.
- The required Webwright audit viewport was 1280 × 1800. Earlier mobile findings were compared, not
  re-executed.
- Background scoring can continue independently; counts are the values observed during the final
  evidence run.
- The report intentionally avoids reproducing private account content.
- The review does not infer that the visual style proves AI authorship. Hallmark labels are taste
  heuristics; the ranked trust, accessibility, and continuity defects are evidence-based.

[ms-hai]: https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/
[nielsen-heuristics]: https://www.nngroup.com/articles/ten-usability-heuristics/
[nist-ai]: https://doi.org/10.6028/NIST.AI.100-1
[wai-tabs]: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/
[wcag-name]: https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html
