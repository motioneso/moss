# Handoff — #1108 UAT subnet safety spec and plan

## Scope

Create a design spec and implementation plan for GitHub task/bug #1108. Do not implement code.

The UAT provisioner currently defaults to a fixed subnet and can be manually pointed at a subnet overlapping a live Docker network. Design the smallest safe solution that auto-selects a free `/24`, rejects an explicitly requested overlap before compose starts, supports concurrent UAT runs, and cleans up only networks demonstrably owned by the current UAT run. Never broaden cleanup to production, infra, or ambiguous leftover networks.

## Required grounding

- Read `CLAUDE.md`, `AGENTS.md`, GitHub issue #1108, and `docs/DEVELOPMENT_STANDARDS.md`.
- Use codebase-memory graph tools first for the UAT provisioner/teardown flow, then inspect Docker/config scripts as needed.
- Prefer Docker/Node/platform primitives already in the repo; no new dependency unless unavoidable.
- Specify fail-closed boundary validation, concurrency behavior, ownership markers, and a non-destructive acceptance proof. No production network mutations.

## Deliverables

- `docs/superpowers/specs/<date>-1108-uat-subnet-safety.md`
- `docs/superpowers/plans/<date>-1108-uat-subnet-safety.md`
- A focused commit, pushed branch, and draft PR linked to #1108.
- A concise report to the `Coordinator` pane with PR URL, locked decisions, collision surface, and any genuine decision requiring Ben.

Use `~/Jarv1s` in documentation. Do not edit `docs/coordination/`, implement code, run UAT against production, or delete any existing network.

## Start

Use the relevant pre-development/spec workflow. Ground the actual provisioner and teardown seams, then write the smallest complete spec and plan. Ask Ben only for a material safety fork. Begin now.
