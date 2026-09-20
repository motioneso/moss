# Handoff: Jev focus companion Mac pilot architecture

Date: 2026-09-19

## Objective

Create a quick, concrete architecture plan for piloting a Moss companion app on Ben's MacBook. The companion observes enough local computer activity to detect likely distraction while high-priority tasks exist, asks Jev for a typed judgment, and lets Moss send a supportive focus message.

This is planning only. Do not implement code, create issues, or change product metadata.

## Read first

1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/research/2026-09-19-jev-screen-focus-feasibility.md`
4. Existing repo material relevant to desktop/companion apps, tasks, Moss messaging, privacy, and local permissions. Prefer the codebase graph for code discovery.

## Required plan

Write `docs/superpowers/plans/2026-09-19-jev-focus-mac-pilot.md`.

Keep it pilot-sized and MacBook-specific. Cover:

- The smallest native companion-app shape that can run on macOS and communicate with Moss/Jarv1s.
- The cheapest observation ladder: active application/window metadata first, Accessibility/browser text second, local OCR/screenshot access only as a fallback.
- The exact macOS permissions the pilot would require and how to minimize them.
- Event-driven sampling, local filtering/redaction, short rolling context, and when Jev is called.
- A compact Jev state and typed question design, including `focused`, `necessary_detour`, `distracted`, and `insufficient_evidence`.
- Conservative notification gating so normal research and necessary detours do not become nagging.
- Privacy boundaries, prompt-injection handling for webpage text, failure/offline behavior, and a visible pause/disable control.
- The thinnest integration seam with existing tasks and Moss messaging; reuse existing interfaces where present.
- A one-MacBook pilot sequence with success metrics, kill criteria, and a rough effort estimate.
- Explicit non-goals and what should be deferred until the pilot proves value.

Prefer deletion and native platform capabilities over new infrastructure or dependencies. Do not design a cross-platform framework, general screen-recording system, or continuous screenshot upload. If a simpler non-screenshot pilot answers the product question, make that the recommendation.

## Done

- The plan file exists and is concise enough for a pilot decision.
- Commit the plan on this branch.
- Report the recommendation, plan path, commit, and any decision Ben must make before implementation.

## Start

Read the required files, inspect the existing seams, then write and commit the plan. Do not build the feature.
