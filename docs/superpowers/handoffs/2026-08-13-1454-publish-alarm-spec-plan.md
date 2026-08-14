# Handoff — #1454 skipped image-publish alarm spec and plan

## Scope

Create a design spec and implementation plan for GitHub task #1454. Do not implement code.

The defect is silent non-publication of the rolling `:edge` image when the main workflow's publish job is skipped or cancelled. Preserve the existing safety gate: red verification must still prevent publishing. Design the smallest native GitHub Actions signal that clearly identifies the main SHA which did not reach `:edge`, including skipped/cancelled dependency cases.

## Required grounding

- Read `CLAUDE.md`, `AGENTS.md`, GitHub issue #1454, and `docs/DEVELOPMENT_STANDARDS.md`.
- Inspect only the relevant workflow and existing notification/status patterns; use codebase-memory for code references and bounded reads for YAML/config.
- Prefer native GitHub Actions behavior and existing repo integrations. Do not add a service or dependency for one alarm.
- Replace the issue's risky suggestion of intentionally merging a known failure to main with a safe, observable verification method unless Ben explicitly requires otherwise.

## Deliverables

- `docs/superpowers/specs/<date>-1454-image-publish-alarm.md`
- `docs/superpowers/plans/<date>-1454-image-publish-alarm.md`
- A focused commit, pushed branch, and draft PR linked to #1454.
- A concise report to the `Coordinator` pane with PR URL, locked decisions, collision surface, and any genuine decision requiring Ben.

Use `~/Jarv1s` in documentation. Do not edit `docs/coordination/`, implement workflow code, change branch protection, publish images, or trigger production deployment.

## Start

Use the relevant pre-development/spec workflow. Ground the workflow semantics, then write the smallest complete spec and plan. Ask Ben only for a material notification-channel decision; otherwise proceed on judgment. Begin now.
