# Handoff: #1755 — the Workshop page

Spec: `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`.
Approved mockup: `docs/superpowers/specs/assets/2026-08-19-moss-workshop/workshop.html`.
Issue: #1755. Tier: routine (re-check during build — bump to sensitive if it turns out
to touch shared schema or module-install paths). Worktree:
`.claude/worktrees/1755-workshop-page`. Branch: `1755-workshop-page`.

Coordinator: pane w1:pMV, agent name `coordinator`, session
7b8957b3-93f9-44ee-81cc-a6a436514031.

Not part of the #1499-#1503 serialized chain — independent work, running in parallel.
Not blocked by anything else in this run; its three prerequisite pieces (#1752, #1753,
#1754) are already merged.

## What to build

A first-party page listing modules the user has asked Moss to build, in three groups:
Needs you, Building now, Live. A build in progress shows what step it is on, what it has
written so far, and what it has spent, with a way to stop it. A live module offers ask
for a change, share as a folder, and turn on for everyone. A module that has stopped
working says so and offers to have Moss fix it.

## Design rulings that came out of review — do not undo

- Cards are for decisions. Only the item asking the user to do something is a raised
  card. Work in progress and live modules are plain rows separated by a hairline.
- The reviewed width was about 920px and Ben said it was right — do not widen this
  screen.
- Use the `jds-*` primitives only. Run the invented-class audit in the `design-system`
  skill, and include `packages/ui/src/styles/` as well as `apps/web/src/styles/` or it
  reports every real class as invented. Use the `design-system` skill before any UI work
  here.

Follow `coordinated-build` end to end: plan → my approval → build → PR →
`coordinated-wrap-up`. Do not touch `docs/coordination/` (coordinator-only) or run
repo-wide `pnpm format` / broad `git add`. Read the spec by section for your current
task only.
