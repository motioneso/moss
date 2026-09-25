# Moss: next-section design session brief

## Start here

Continue the collaborative Moss design exploration with Ben. **The next section has not been selected.** Tasks has an approved visual direction and a preserved implementation plan; do not resume Tasks implementation or reopen its settled design decisions by default.

Suggested opening:

> We settled Tasks on Park Office with Field Guide's list index. I'd suggest Today next, to see how the same visual language works on the daily briefing rather than another task list. Is Today the section you want to tackle, or did you have another in mind?

Today is a recommendation, not an approved choice. If Ben names a different section, work on that section. Begin by understanding what he uses it for, what currently works, and what feels unfinished before proposing changes.

## What Ben is trying to improve

Moss has the beginnings of a good design but feels unfinished and insufficiently on-brand, especially outside Today. Today was the closest to acceptable in his initial assessment. The goal is more polish, intentional hierarchy, and a stronger national parks influence—not more decoration or a blanket increase in density.

Ben wants a respectful, well-executed **homage** to parks. Translate signage, visitor information, field-guide organization, confident typography, and material/color choices into a useful app. Do not imitate official park-service branding or dress every feature in hiking metaphors.

**Working preference:** Ben explicitly said, "I want you to use your design capabilities built in, no need for the skills." Do not invoke Hallmark or another design-skill workflow. Use direct design judgment grounded in Moss's references and the conversation. Repository safety requirements still apply when touching files or Git.

## Settled visual direction

- **Bone replaces Oat.** The inspected light-theme paper color was `#f2eee4`.
- Confident forest fields, restrained decorative gold, Swiss sans-serif hierarchy, quiet metadata, and purposeful rules.
- Substantive and useful, not sparse wellness minimalism. Containment should clarify groups rather than turn everything into rounded cards.
- No literal landscape scenes, heavy frames, aged patina, therapeutic softness, mascots, serif/mono headings, or faux park-service seals.
- Gold is decorative; amber is normal drift/recovery; red is for real errors or destructive actions. Preserve accessible contrast and non-color state cues.
- Apply the family resemblance thoughtfully. **Park Office is not a mandate to put the same masthead, sidebar, or grid on every page.** The page's job should determine its composition.

### What Tasks taught us

We explored three standalone directions: Park Office, Field Guide, and Trail Register, with priority-list and grid variants. Ben preferred Park Office, with Field Guide a close second. When asked what stood out about Field Guide, he said **the list index**.

The approved combination is Park Office's forest masthead, Bone title, thin gold rule, and pale sage section headings, plus Field Guide's visible list index in both desktop views. Mobile uses a compact list control. Selection carries across List/Grid. Ben's response to the combined mockup: "Yep that looks awesome."

Tasks-specific requirements remain settled: current comfortable spacing, compact title-only Enter capture, optional full Details, and both views. Do not generalize those into requirements for unrelated sections. In particular, an early critique suggested revisiting task-row density; Ben subsequently said the spacing was fine. His later decision wins.

## Current status and preserved references

As checked when writing this brief:

- [Implementation task #2450](https://github.com/motioneso/moss/issues/2450) is on project 2, **Issue and Roadmap Work**.
- [Docs PR #2451](https://github.com/motioneso/moss/pull/2451) is **open, not merged**. It preserves the plan/spec/reference images; it does not implement the redesign or close the task.
- Preservation branch: `docs/2450-tasks-park-office-plan`.
- Preservation commit: `9e789b41cda9efaa9d1c69d707e897f9fc7258af`.
- No production Tasks redesign has been implemented or deployed in this design session. Recheck GitHub status rather than assuming this remains unchanged later.

Read these first:

1. [Tasks design spec](../superpowers/specs/2026-09-09-tasks-park-office-design.md), including the approved desktop list/grid and mobile reference links.
2. [Tasks implementation plan](../superpowers/plans/2026-09-09-tasks-park-office.md). Four slices: layout/index; capture/priority list; grid/page states; live verification/release.
3. `docs/brand/brand-brief.md`, relevant visual-language research, and `docs/DEVELOPMENT_STANDARDS.md`. Older brand documents are historical where they conflict with Ben's latest decisions or the current token system.

If local planning documents are absent, use the issue's immutable commit links. Do not switch a shared worktree just to access them.

Interactive study, if still available: `~/Jarv1s/.superpowers/brainstorm/tasks-parks-20260909/`. Run `node .superpowers/brainstorm/tasks-parks-20260909/server.cjs` from the repo only if port 8766 is not already serving it. Direction A is the approved combined version. The server may no longer be running; the committed visual references are the durable source. Mockup interactions use sample data in memory only.

## Earlier app critique: useful leads, not current facts

The original review inspected a populated **dev** demo account across Today, Tasks, Calendar, Wellness, News, Sports, and the Workshop. Production was reachable but required authentication; do not describe that review as a production audit. Dark mode and a complete accessibility audit were not covered. No authentication state was retained for reuse.

Useful findings to validate again on the chosen section:

- The brand was stronger in the global shell than in working-page interiors. Utility controls, small headings, and repeated pale rounded cards often weakened hierarchy.
- **Today:** preserve its asymmetrical reading layout. The large attention-count headline dominated the daily orientation and could conflict with the anti-shame promise. Mobile clipping was content-dependent, not universal.
- **Calendar:** preserve the familiar grid and distinction between accepted events and assistant-held time. Consider clearer orientation above the utility controls; a field-itinerary influence may fit its job.
- **Wellness:** card-heavy composition and narrow summary overflow; observation/recording discipline may be more appropriate than wellness-app softness.
- **News:** settled headline/rule/photo composition already had useful editorial character; do not treat transient image-loading gaps as a settled design defect.
- **Sports:** strong subject-specific character, but compressed panels/truncated identities needed editing and hierarchy more than added decoration.
- **Workshop:** strong forest opening; the inspected empty state felt disconnected and duplicated the primary creation action. Only its empty state was reviewed, and recent Workshop work may have changed it substantially.

The old recommendation was Tasks first, Today second, then Calendar as a different kind of surface. Reinspect the selected page before carrying any of these findings forward. The original critique used Hallmark before Ben opted out; do not carry that workflow or its scores into the new session.

## Theme/source discrepancy to handle honestly

The inspected live theme and mockups used Bone and an Archivo display face. At planning time, the shared checkout's base `apps/web/src/styles/tokens.css` still contained Oat and a Helvetica-based display stack. Runtime aesthetic theme overrides exist.

Identify the recent theme/font work and actual rendered tokens before claiming production fidelity. Do not quietly revert to Oat, install the mockup font globally, or create a section-specific palette to conceal an unresolved base/theme mismatch. This is a readiness check, not authorization for a global theme migration.

## How to work through the next section

1. Confirm the section and its purpose with Ben. Ask concise questions one at a time; do not repeat the entire brand interview.
2. Inspect the real current screen and relevant existing capabilities. Prefer the code graph for discovery; if unavailable, use bounded source reads. Be explicit about dev versus prod, authentication limits, and sample versus actual data. Avoid live mutations during critique.
3. Give a focused critique: what to preserve, what feels unfinished, and which hierarchy/composition changes would make the page more useful and more Moss.
4. Discuss the direction before drawing. Once Ben wants mockups, create a small number of genuinely distinct, standalone options with representative content and relevant narrow-screen states. Preserve existing functionality and do not implement production changes just to explore visuals.
5. Explain the tradeoffs, recommend a direction, and iterate on the detail Ben responds to. Tasks improved because we identified the list index specifically, not because we averaged two designs together.
6. After explicit visual approval, record the spec and reference artifacts. If asked for implementation planning, use the established Goal/Architecture/Tech Stack/Constraints structure, file-targeted checkbox tasks, session-sized slices, verification, and handoff boundaries. GitHub writes, commits, PRs, and merges need the applicable user request; do not assume approval from design discussion alone.

## Workspace and evidence safety

Work from `~/Jarv1s`. The previous session used a dirty shared checkout at detached HEAD and preserved its docs with an isolated docs-only commit based on remote main. Other agents' unpublished history and edits were intentionally untouched. Do not checkout/reset/stash, sweep the index, or assume local files are unpreserved merely because the current detached checkout lists them as untracked. Check the preservation commit/branch first.

Keep reads bounded. Never view full-page screenshots inline; inspect cropped regions only. Do not use screenshots as live-path release evidence; the repo requires executable assertions and bounded textual evidence for that gate. Do not run database-touching tests or the full foundation gate casually against live dev.

**Success for the next session:** shared understanding of the chosen section, a grounded design direction, and—when requested—reviewable mockups that feel related to Tasks without mechanically copying it.
