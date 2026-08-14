# Handoff — #1592 unwired confirm-route behavior spec and plan

## Scope

Create a focused design spec and implementation plan for GitHub task #1592. Do not implement code.

The follow-up from #1256/PR #1587 is that an unwired chat gateway returns 503 for every action status even though only `confirm`/`execute` require gateway wiring; `reject`/`cancel` should remain functional without it. Ground the smallest fail-closed correction and preserve the security behavior of statuses that do require the gateway.

## Required grounding

- Read `CLAUDE.md`, `AGENTS.md`, GitHub issue #1592, PR #1587's durable QA finding, and `docs/DEVELOPMENT_STANDARDS.md`.
- Use codebase-memory graph tools first to trace the route and action-resolution call paths.
- Explicitly map behavior for `confirm`, `execute`, `reject`, and `cancel`, including unknown/foreign action IDs.
- Check collision with in-flight #1591/PR #1613. The implementation must serialize after #1591 lands if the paths or behavior overlap; the spec/plan may proceed now.

## Deliverables

- `docs/superpowers/specs/<date>-1592-unwired-confirm-routing.md`
- `docs/superpowers/plans/<date>-1592-unwired-confirm-routing.md`
- A focused commit, pushed branch, and draft PR linked to #1592.
- A concise report to the `Coordinator` pane with PR URL, locked decisions, explicit #1591 collision result, and any genuine decision requiring Ben.

Use `~/Jarv1s` in documentation. Do not edit `docs/coordination/`, implement code, or alter the in-flight #1591 branch.

## Start

Use the relevant pre-development/spec workflow. Ground the route matrix and collision first, then write the smallest complete spec and plan. Ask Ben only for a material behavior fork. Begin now.
