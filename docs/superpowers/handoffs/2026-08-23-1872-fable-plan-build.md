# Issue #1872 — Build the Fable-authored plan

## Assignment

Implement issue #1872 exactly from the Fable-authored plan at
`docs/superpowers/plans/2026-08-23-service-worker-image-fetch-recovery.md`, commit `9373e271a`.
That plan is approved and authoritative; do not create or substitute another plan.

- Branch/worktree: `1872-fable-plan`
- Tier: routine, with mandatory user-facing live-path proof
- Coordinator: agent `coordinator`, session `01a02cde-59a6-7900-99d9-aa65f8989e49`
- Collision: no known file collision with active #1500 shared-form CSS work

## Required workflow

1. Run `pnpm install` in this fresh worktree.
2. Invoke `coordinated-build`, tell it planning is complete and approved by Fable, and execute the
   single-phase plan test-first.
3. Run the plan's smallest deterministic regression check and production-build browser check.
4. Complete the required live-path proof for one article photo, one sports logo, and preserved
   offline navigation. Post the evidence to the PR.
5. Include the required release note, open the PR, and invoke `coordinated-wrap-up`.
6. Report the PR and compact green evidence to `coordinator`, signed with your pane id.

## Guardrails

- Do not change the Fable plan. A conflict or missing decision is `[DESIGN-FORK]`; stop and message
  `coordinator`.
- Keep CSP and chat-stream warnings out of scope.
- Do not touch `docs/coordination/`, run repo-wide formatting, or use broad `git add`.
- Do not end your turn between required steps or merely declare that you will wait for background
  work; actively finish the lane.

## Start

Install dependencies, read the Fable plan by section, invoke `coordinated-build`, and implement it
now.
