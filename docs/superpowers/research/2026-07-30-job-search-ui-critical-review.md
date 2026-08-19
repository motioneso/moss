<!-- Hallmark · pre-emit critique: P5 H4 E4 S5 R4 V4 -->

# Adversarial Job Search UI review

**Date:** 2026-07-30

**Reviewed build:** `d14a0ee81fe8dbc2739bf2dc46748058e24ddb08`

**Scope:** live Job Search module and surrounding Jarv1s shell; research and critique only

## Executive verdict

Jarv1s has an authored visual identity and a better-than-generic Matches list, but the experience
does not yet hold together as a dependable job-search tool. Its strongest screen is the dense,
rule-separated match list. Its weakest seam is setup: the interface says chat is how to finish or
change the search, yet the existing transcript shows an explicit source-enablement intent that did
not become an enabled source. The structured screens then repeat the incomplete state without
offering a direct repair.

The highest-risk defects are concrete, not aesthetic:

1. chat-first setup failed to complete or clearly resolve an explicit intent;
2. the mobile match inspector opens beneath the fixed app header;
3. opening and closing a deep match destroys the user's list position;
4. the only monitor enable control has no accessible name; and
5. a 45-result triage flow has almost no filtering and hides Save/Pass inside the detail view.

The interface should not be replaced wholesale. Fix the broken state and navigation seams, make
consequential setup directly controllable, explain AI output, and compress the repetitive mobile
hierarchy. Preserve the warm dark shell, the Matches list, explicit Save/Pass states, strong visible
focus, and the product's unusually candid safety copy.

## Scope, method, and grounding

The audit used the live dev UI at `http://100.64.98.99:5197` in headless Firefox through Playwright.
The reviewed viewports were 1280 × 1800 and 375 × 812. Authentication used the provided environment
variables; their values were never printed, logged, captured, or committed. The review opened one
match inspector and the chat drawer but did not send messages, run a search, toggle a monitor,
save/pass a match, open an external posting, upload a résumé, change a setting, or otherwise mutate
user or application state.

The source tree was inspected only after the live-UI pass. Code discovery used the repository
knowledge graph first, then targeted source/CSS reads where the graph did not return enough literal
context.

`pnpm audit:preflight` passed with `JARVIS_ALLOW_STALE=1`. This intended issue branch was 14 commits
behind and 248 commits ahead of `origin/main` at review time, so the findings are grounded in the
commit above rather than represented as a review of current `main`.

The reproducible audit script and action log were kept in the gitignored local output directory.
The reviewed states were:

- desktop Matches
- desktop Overview
- desktop Profile
- desktop Monitors
- desktop match inspector
- desktop chat drawer
- mobile Matches
- mobile Overview
- mobile Profile
- mobile Monitors
- mobile match inspector

### Severity

- **High:** blocks, misdirects, or materially degrades a core workflow; or creates a serious
  accessibility barrier.
- **Medium:** repeatedly slows users, presents misleading state, or weakens control and
  understanding without fully blocking the task.
- **Low:** localized semantic or craft problem with limited immediate task harm.

## Ranked findings

### 1. Chat-first setup failed to complete an explicit intent

**Category:** usability / human–AI interaction

**Severity:** High

**Evidence.** The existing chat transcript shows the user agreeing to start with the proposed
built-in sources. The following assistant response asks again whether LinkedIn should be enabled.
The structured state remains “No boards enabled,” and LinkedIn remains “Paused” in
desktop Monitors. The Profile screen says to “Answer what's left in chat,”
while Monitors says adding or editing a board happens through chat. Source confirms those are
deliberate routes: `screens/profile.tsx:190-195` and `screens/settings.tsx:377-382`.

**Why it matters.** This is the highest-trust moment in setup: the user expressed a consequential
intent, the assistant appeared to acknowledge surrounding answers, and the deterministic screen
still shows no resulting state. The user cannot tell whether the assistant misunderstood, the
change failed, or another confirmation is required. Because chat is presented as the correction
path too, the same ambiguous channel must diagnose itself.

Microsoft's validated [Human–AI Interaction Guidelines][ms-hai] call for efficient invocation,
efficient correction, clear scope, explanation of why the system acted, and global controls. The
current handoff satisfies none of those well enough.

**Smallest credible remedy.** After a source-setting utterance, render a structured confirmation
with the interpreted changes and their result, for example “LinkedIn: enabled” or “Not changed:
confirmation still needed.” Put the same explicit enable switch and an “Add board” action on
Monitors so chat is an accelerator, not the only repair path.

### 2. The mobile match inspector opens under the fixed header

**Category:** responsive usability

**Severity:** High

**Evidence.** In mobile match inspector, “Back to matches” is almost entirely
behind the fixed app header and the job metadata begins under it. The inspector calls
`scrollIntoView({ block: "start" })` when opened
(`screens/inspector.tsx:97-110`), but `.jsm-detail` has no scroll offset
(`styles-board.css:136-145`). The analogous `.jsm-discuss-panel` already uses
`scroll-margin-top: 5rem` specifically to clear that header (`styles-board.css:382-393`).

**Why it matters.** The first action in the detail flow—the way back—is visually obscured, and the
screen appears to start mid-content. This is a loss of context and control at the narrow viewport
where recovery space is already scarce.

**Smallest credible remedy.** Add `.jsm-detail` to the existing
`scroll-margin-top: 5rem` rule. This reuses a proven local fix and needs no new layout system.

### 3. Opening a deep match destroys list position

**Category:** navigation / continuity

**Severity:** High

**Evidence.** A read-only interaction opened row 25 from `scrollY = 2057`. The inspector moved the
page to `scrollY = 250`; “Back to matches” returned to `250`, not `2057`. The source explains that
opening a match intentionally scrolls the inspector root into view (`screens/inspector.tsx:100-110`)
but retains no origin scroll position. The harm is amplified by the 45-role board visible in
desktop Matches.

**Why it matters.** Triage is comparative and repetitive. Losing position after every inspection
forces users to relocate the item they just examined and reconstruct where they were in the queue.
This directly conflicts with Nielsen's [recognition rather than recall][nielsen-heuristics]
heuristic.

**Smallest credible remedy.** Capture the list scroll position when a match opens and restore it
when the inspector closes. Preserve the existing inspector design.

### 4. The 45-result board is too weak for repeated triage

**Category:** competitive workflow / information architecture

**Severity:** High

**Evidence.** Matches exposes New/Saved/Passed buckets and Fit/Want sorting, but no title, company,
location, source, or posting-date filter. Save and Pass appear only after opening a full inspector,
which triggers the position-loss defect above. Mobile Matches shows how quickly
the list becomes a one-row-at-a-time tunnel.

**Why it matters.** The core task is not merely reading matches; it is reducing a queue into
decisions while preserving context. Current first-party comparators make this state explicit:
LinkedIn documents a centralized five-stage [Job tracker][linkedin-tracker] with notes and date
filtering; Huntr documents direct Kanban stages and an activity timeline in its
[Job Tracker][huntr]; Teal describes a stage-based [pipeline][teal] with ratings, notes, and
job-level checklists. Their marketing does not prove superior usability, but it establishes a
current workflow baseline Jarv1s does not yet meet.

**Smallest credible remedy.** First add a compact filter row for source, location, company/title,
and posted date, then expose Save/Pass as keyboard-operable row actions. Do not start with a Kanban
rewrite.

### 5. The monitor switch has no accessible name

**Category:** accessibility

**Severity:** High

**Evidence.** The live accessibility tree exposes the monitor control as a bare `checkbox` with no
name. `MonitorRow` wraps the input in a label, but the label contains only decorative track/thumb
spans and no text or `aria-label` (`screens/settings.tsx:239-252`).

**Why it matters.** A screen-reader user cannot determine which board the checkbox controls or what
changing it will do. This violates the name requirement in WCAG
[4.1.2 Name, Role, Value][wcag-name-role-value].

**Smallest credible remedy.** Give the input a board-specific name such as
`aria-label={\`Enable ${row.label}\`}`. If the visual design can afford it, visible “Enabled/Paused”
text associated with the control is better still.

### 6. “Search now” offers an invalid-looking action when no boards are enabled

**Category:** error prevention / system status

**Severity:** Medium

**Evidence.** Matches offers an enabled “Search now” button while Overview and Monitors state that
no boards are on (mobile Matches, mobile Monitors).
`SearchNowControl` receives only `profileId` and `refreshBoard`, and disables only while a run is
starting or running (`screens/board.tsx:251-288`). It has no enabled-portal condition.

**Why it matters.** The UI invites work it simultaneously says has no input source. Even if the
backend safely no-ops, the likely result is confusion rather than progress. This is a preventable
error and weak status communication under Nielsen's
[error-prevention and visibility heuristics][nielsen-heuristics].

**Smallest credible remedy.** Disable “Search now” when zero sources are enabled and place a direct
“Turn on LinkedIn” or “Choose boards” link beside the explanation.

### 7. Overview mislabels aggregate search readiness as “Profile”

**Category:** system status / content accuracy

**Severity:** Medium

**Evidence.** The live state shows every profile checkpoint complete and only job boards missing,
yet Readiness Gates says “Profile — Still finishing setup” in
mobile Overview. `buildGates()` maps the aggregate
`profile.readyToCrawl` flag directly to a gate labeled “Profile”
(`screens/overview.tsx:109-118`).

**Why it matters.** The label directs the user toward the wrong repair surface. “Profile” implies
the personal data is incomplete even though the same screen shows those checkpoints as done.
Headings and labels should describe purpose accurately under WCAG
[2.4.6 Headings and Labels][wcag-headings].

**Smallest credible remedy.** Rename the gate “Search” if it intentionally represents aggregate
readiness, or derive a separate profile-only readiness value.

### 8. Setup status is repeated until it buries the next action

**Category:** visual hierarchy / cognitive load

**Severity:** Medium

**Evidence.** The module repeats “Setup incomplete,” “4 of 5 complete,” a large “Your search is
getting set up” hero, Readiness Gates, Setup Checkpoints, monitor health, and a “What's missing”
section. Mobile Overview spends the first viewport restating status before
showing a direct route to resolution.

**Why it matters.** Repetition here is not reassurance; it is extraneous load. Users need one
diagnosis (“No boards enabled”) and one next action. Nielsen's
[aesthetic/minimalist heuristic][nielsen-heuristics] warns that irrelevant or redundant content
competes with relevant content, and NN/g's [cognitive-load guidance][nng-cognitive-load] explicitly
identifies redundant interface material as clutter.

**Smallest credible remedy.** Collapse the readiness hero and gates into one compact status block
with the missing item and a direct fix. Keep detailed checkpoints behind disclosure only if they
remain useful after setup.

### 9. Tab roles promise keyboard behavior the UI does not implement

**Category:** accessibility / interaction semantics

**Severity:** Medium

**Evidence.** The Job Search view and match-bucket controls use `role="tab"` and
`aria-selected`, but every tab remains in the default tab sequence and ArrowRight does nothing.
Source shows ordinary buttons without roving `tabIndex` or arrow-key handling
(`root.tsx:287-307`, `screens/board.tsx:787-801`). Tab/Enter operation and visible focus do work,
so this is not a claim that the controls are keyboard-inoperable.

**Why it matters.** The tab role creates a specific, learned interaction contract. The WAI-ARIA
[Tabs Pattern][wai-tabs] expects focus to move within the tablist with arrow keys and usually keeps
only the active tab in the page Tab sequence. The current hybrid adds extra stops and surprises
users who rely on widget conventions.

**Smallest credible remedy.** Either implement roving `tabIndex` plus Arrow/Home/End behavior, or
remove tab semantics and present these as ordinary navigation buttons. The latter may be the
smaller honest choice.

### 10. “Want 38” presents model judgment with unjustified precision

**Category:** human–AI interaction / trust

**Severity:** Medium

**Evidence.** Desktop match inspector presents `Want 38` with a calibrated-
looking bar and a confident narrative, but no visible denominator, definition, provenance,
uncertainty, or timestamp. The source defines a model-authored 0–100 integer and a detailed prompt
(`domain/score.ts:19-27,61-73`), while the UI renders only the bare number and track
(`web/score.tsx:24-36`).

**Why it matters.** The number looks more objective than the interface can justify. NIST's
[AI Risk Management Framework][nist-ai-rmf] warns that measurement can be oversimplified, lose
critical nuance, and become relied on in unexpected ways. This finding does **not** establish that
the score is fake; it establishes that its meaning is hidden.

**Smallest credible remedy.** Render `38/100` and expose a short definition such as “model estimate
of whether this work matches your stated preferences,” plus when it was scored. If the number
cannot be calibrated, use qualitative bands and preserve the evidence narrative.

### 11. Mobile Profile spends too much space announcing itself

**Category:** responsive hierarchy / craft

**Severity:** Medium

**Evidence.** Mobile Profile has a measured document height of 2527 px. Its first 812 px
(mobile Profile) contains the module chrome, a two-line uppercase hero,
description, rule, and only three résumé facts. The preferences that actually determine matching
arrive much later. Desktop Profile also leaves a visibly unbalanced two-column field of sparse
metadata and long-form criteria (desktop Profile).

**Why it matters.** The screen's primary purpose is to verify and correct search inputs. Decorative
hierarchy delays the data users need to compare and edit. Progressive disclosure should defer
advanced material, not frequently compared primary inputs; see NN/g's
[Progressive Disclosure][nng-progressive-disclosure].

**Smallest credible remedy.** Demote the hero on narrow screens and render résumé metadata as a
compact grid or rows. Bring titles, locations, remote preference, pay floor, must-haves, and
dealbreakers earlier. This is compression, not a new design system.

### 12. Repeated screen macrostructure makes distinct tasks feel templated

**Category:** AI-design tell / visual craft

**Severity:** Low; partly taste

**Evidence.** Overview, Profile, and Monitors repeat the same all-caps eyebrow, oversized two-line
uppercase heading, gold strap, description, and heavy rule despite serving different tasks
(desktop Overview, desktop Profile,
desktop Monitors). The cost becomes concrete on mobile, where this repeated
ceremony consumes a large share of each first viewport.

**Why it matters.** This is the most defensible “AI-generated feel” in the reviewed UI: not a color
or border radius, but uniform page choreography applied regardless of task. It weakens information
scent and makes each view feel like a skin over the same template.

**Smallest credible remedy.** Keep the palette and typography, but let task shape drive hierarchy:
Overview needs status plus an action; Profile needs scannable editable fields; Monitors needs source
state and controls. Reduce, rather than replace, the shared hero treatment on secondary screens.

This finding is partly aesthetic judgment. No authoritative source found in this review establishes
that repeated macrostructure proves AI authorship. Validate the perception with users rather than
treating “AI-looking” as an objective defect.

### 13. Heading hierarchy is semantically muddy

**Category:** accessibility / content structure

**Severity:** Low

**Evidence.** The live accessibility tree contains a module-level `h1` and another `h1` for the
active screen or inspector. The visual hierarchy already treats these as a module title plus
subview title.

**Why it matters.** Multiple `h1` elements are not automatically a WCAG failure, but here they make
the outline less informative than the visual nesting. Clear descriptive headings help users
navigate and understand structure under WCAG [2.4.6][wcag-headings].

**Smallest credible remedy.** Keep the module page title as `h1` and render active subview and
inspector headings as `h2`.

## Usability and accessibility defect summary

| Finding                   | User harm                                               | Standard or heuristic            |
| ------------------------- | ------------------------------------------------------- | -------------------------------- |
| #2 inspector under header | Back/context obscured on mobile                         | Responsive context; user control |
| #3 list-position loss     | Repeated disorientation during triage                   | Recognition rather than recall   |
| #5 unnamed checkbox       | Board/action unavailable by name to screen-reader users | WCAG 4.1.2                       |
| #6 ungated Search now     | Invites a nonproductive action                          | Error prevention; visibility     |
| #7 mislabeled gate        | Sends users to the wrong repair surface                 | WCAG 2.4.6                       |
| #9 incomplete tabs        | Widget semantics and keyboard convention diverge        | WAI-ARIA APG Tabs                |
| #13 heading outline       | Structure is less clear than the visual nesting         | WCAG 2.4.6                       |

No horizontal overflow was observed at 375 px on Overview, Profile, or Monitors
(`scrollWidth = clientWidth = 375`). Keyboard focus indicators were visibly strong, and the tested
controls remained usable with Tab and Enter. Those strengths narrow the accessibility work: the
review does not support a claim that the entire module is keyboard-inaccessible.

Contrast was not instrumented, 320 px was not tested, and no full screen-reader session was run.
Muted metadata and state indicators should receive a formal contrast pass, but this report does not
label them failures without measurements.

## Visual hierarchy and craft

The shell is recognizably Jarv1s: warm near-black surfaces, forest navigation, restrained gold, and
green fit/status accents. The typography has more personality than a generic dashboard, and Matches
uses separators rather than turning every role into a floating card. That is the right instinct.

The hierarchy breaks down when display treatment outranks task content. Profile and Monitors use
editorial-scale headings for utility screens. Overview repeats a single setup fact across several
named structures. Desktop Monitors places a very small amount of state in a large empty field while
the consequential action is a tiny unlabeled switch. Mobile magnifies those choices: screen titles
and setup ceremony occupy the space where direct controls and preferences should be.

Cards, pills, rounding, and “AI UI” are not inherently defective. USWDS says
[cards][uswds-cards] should group content and actions about one subject and should not be used merely
for decoration; Jarv1s correctly avoids a card grid on Matches. USWDS similarly warns that
[tags][uswds-tags] can be mistaken for buttons and lose emphasis when overused. The few Profile
pills visible in the sparse review state were not the primary problem. That conclusion does not
hold for a populated, directly editable profile: long removable values become a dense stack of
variably sized rounded mini-cards, centered text wraps awkwardly, and the remove control separates
from its label. Reviews must exercise realistic high-density values and reject pill clouds for
sentence-length content. Use compact, left-aligned removable tags or rows with an integrated remove
control. The broader problem remains task-insensitive repetition and weak action priority.

## AI-design tells and generic patterns

Three observed patterns make the experience feel machine-composed:

1. **Template before task.** Three different screens use nearly identical hero choreography
   (#12).
2. **Conversation before direct control.** Board setup and correction are routed through chat even
   when a deterministic switch or form would be clearer (#1).
3. **Precision before explanation.** A two-digit model score is more visually concrete than its
   definition or provenance (#10).

These are task-fit and trust findings, not a claim about how the code was authored. The UI notably
avoids several common failure modes: there is no purple-gradient spectacle, no wall of decorative
cards, no fake sparkle vocabulary, and no gratuitous motion dominating the module.

### Hallmark audit lens

The Hallmark anti-pattern list identifies two **major** tells here:

- **Eyebrow on every screen** — the decorative all-caps kicker repeats on Overview, Profile, and
  Monitors; remove it where it does not communicate a real stage or sequence.
- **Default-attractor sameness** — those utility screens share one macrostructure despite different
  jobs; vary hierarchy by task, not by adding new decoration.

Hallmark-specific summary: **0 critical · 2 major · 0 minor**. Verdict: recognizable templating on
the utility screens, not wholesale “AI slop.”

## Competitive patterns worth copying in principle

### Keep AI adjacent to direct control

LinkedIn's [AI-powered job search][linkedin-ai-search] accepts natural-language intent and then
places explicit refinement filters under the query. Simplify's first-party product page combines an
AI/profile-led matcher with structured preferences, dealbreakers, bookmarks, and a
[tracker][simplify]. Jarv1s should follow the principle, not their chrome: chat may interpret intent,
but the resulting source, profile, and triage state must be visible and directly correctable.

### Make the job/application the persistent object

LinkedIn, Huntr, Teal, and Careerflow all publicly describe a central job/application record with
stages and attached artifacts. Jarv1s already has New/Saved/Passed and detailed AI reasons; it does
not need a new object model to start. Add filters, direct state actions, notes, and stable return
position around the existing match row.

### Distinguish automatic state from user state

LinkedIn documents which stages Easy Apply updates automatically and where the user can use
“Change stage.” Jarv1s should similarly distinguish “found/scored by Jarv1s” from “saved/passed by
you,” show when each changed, and leave the user's decision directly correctable.

### Turn incomplete states into one next action

IBM Carbon's [empty-state guidance][carbon-empty] says to explain clearly how to populate the space
and, when useful, why it is empty. “No boards enabled” is a good diagnosis; pair it with the direct
action that resolves it instead of repeating setup status elsewhere.

## Strengths to preserve

- **Dense Matches list.** It is faster to scan than a generic card grid and leaves room for a
  useful mobile collapse.
- **Explicit decision vocabulary.** New, Saved, Passed, Save, and Pass are clear and concrete.
- **Separate Fit and Want concepts.** Qualitative “Strong fit” is easier to understand than a
  blended overall rank. Keep the separation while explaining the numeric Want value.
- **Strong visible focus.** Tested controls show clear focus and work with Tab/Enter.
- **Honest scope copy.** “This board doesn't store the full posting text,” “nothing is sent
  anywhere,” and “it never submits anything” set useful safety boundaries.
- **Responsive reflow.** The tested utility screens fit 375 px without horizontal scrolling.
- **Authored brand.** The warm-dark shell, gold rules, green status language, and editorial
  typography should survive the fixes.

## Priorities

### Fix now

1. Add the existing header scroll offset to `.jsm-detail`.
2. Restore list scroll position on inspector close.
3. Give every monitor checkbox a board-specific accessible name.
4. Disable “Search now” when no sources are enabled and link to the remedy.
5. Rename the misleading “Profile” readiness gate or derive a real profile-only state.
6. Make tab semantics honest: implement the WAI keyboard pattern or remove `role="tab"`.

### Fix next

1. Add direct source enable/add/edit controls and structured chat confirmation.
2. Add source/location/company-or-title/date filters and row-level Save/Pass.
3. Explain the Fit/Want scale, provenance, and scoring time—or demote numbers to qualitative bands.
4. Collapse repeated setup status into one diagnosis plus one next action.
5. Compact Profile on mobile and move actionable criteria above decorative hierarchy.
6. Correct the heading outline.

### Do not chase

- Do not replace the Matches list with a card grid.
- Do not clone a competitor's Kanban before fixing filters, row actions, and return position.
- Do not purge rounding or pills on principle; test affordance and hierarchy instead.
- Do not add sparkle, glass, gradients, or motion to make the AI feel more “alive.”
- Do not flatten Jarv1s's color and type identity into a generic SaaS dashboard.
- Do not treat “AI-looking” as a measurable defect without user evidence.

## Research limits

- This was one read-only pass against one existing account state. No destructive, state-changing,
  error-recovery, empty-first-use, or completed-search path was exercised.
- The report intentionally avoids reproducing private live account content.
- Teal blocked direct retrieval with Cloudflare. Its official page content and Teal-hosted image
  references were read through Jina's public reader rendering, so Teal-specific retrieval confidence
  is moderate.
- Huntr, Simplify, Teal, and Careerflow public pages establish their stated information
  architecture and features; they do not establish the usability or accessibility quality of
  authenticated product flows.
- Comparator mobile, keyboard, screen-reader, loading, empty, error, and reduced-motion behavior was
  not independently tested.
- No authoritative source found in this review proves that a particular visual style is
  AI-generated. Visual authorship claims in this report are explicitly labeled as taste or
  hypothesis.

## Primary sources

All sources were accessed 2026-07-30.

- LinkedIn Help, [Track and organize job opportunities][linkedin-tracker].
- LinkedIn Help, [Discover new opportunities with AI-powered job search][linkedin-ai-search].
- LinkedIn Help, [Let recruiters know you're Open to Work][linkedin-open-to-work].
- Huntr, [Job Application Tracker & CRM][huntr].
- Simplify, [AI Job Search Platform][simplify].
- Teal, [Job Application Tracker][teal] (retrieval limitation above).
- Careerflow, [Job Application Tracker][careerflow].
- Microsoft Research, [Guidelines for Human–AI Interaction][ms-hai].
- Jakob Nielsen, [10 Usability Heuristics for User Interface Design][nielsen-heuristics].
- Nielsen Norman Group, [Progressive Disclosure][nng-progressive-disclosure] and
  [Minimize Cognitive Load to Maximize Usability][nng-cognitive-load].
- W3C WAI, [WCAG 2.2 understanding documents][wcag-headings] and
  [WAI-ARIA Authoring Practices Tabs Pattern][wai-tabs].
- NIST, [AI Risk Management Framework 1.0][nist-ai-rmf].
- U.S. Web Design System, [Card][uswds-cards] and [Tag][uswds-tags].
- IBM Carbon Design System, [Empty states][carbon-empty].

[careerflow]: https://www.careerflow.ai/job-tracker
[carbon-empty]: https://carbondesignsystem.com/patterns/empty-states-pattern/
[huntr]: https://huntr.co/product/job-tracker
[linkedin-ai-search]: https://www.linkedin.com/help/linkedin/answer/a6889044
[linkedin-open-to-work]: https://www.linkedin.com/help/linkedin/answer/a507508
[linkedin-tracker]: https://www.linkedin.com/help/linkedin/answer/a8684146
[ms-hai]: https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/
[nielsen-heuristics]: https://www.nngroup.com/articles/ten-usability-heuristics/
[nist-ai-rmf]: https://doi.org/10.6028/NIST.AI.100-1
[nng-cognitive-load]: https://www.nngroup.com/articles/minimize-cognitive-load/
[nng-progressive-disclosure]: https://www.nngroup.com/articles/progressive-disclosure/
[simplify]: https://simplify.jobs/
[teal]: https://www.tealhq.com/tools/job-tracker
[uswds-cards]: https://designsystem.digital.gov/components/card/
[uswds-tags]: https://designsystem.digital.gov/components/tag/
[wai-tabs]: https://www.w3.org/WAI/ARIA/apg/patterns/tabs/
[wcag-headings]: https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html
[wcag-name-role-value]: https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html
