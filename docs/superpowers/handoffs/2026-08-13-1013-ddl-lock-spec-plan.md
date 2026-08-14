# Handoff — #1013 cluster-global DDL serialization spec and plan

## Scope

Create the approved-ready design materials for GitHub task #1013. Produce a focused design spec and an implementation plan only; do not implement code.

The problem is parallel `verify:foundation` runs using separate `JARVIS_PGDATABASE` databases but colliding on Postgres cluster-global role/catalog DDL, causing `tuple concurrently updated` failures. The result must preserve per-agent database isolation while serializing only the truly cluster-global bootstrap/migration/reset seam. Lock acquisition, release, crash recovery, and database targeting must fail safely and must never delete or migrate a sibling/shared database.

## Required grounding

- Read `CLAUDE.md`, `AGENTS.md`, GitHub issue #1013, and `docs/DEVELOPMENT_STANDARDS.md`.
- Use codebase-memory graph tools first to trace the gate, reset, migration, and role/catalog DDL call paths. Read only the relevant code.
- Reuse existing repo/platform locking primitives before proposing a new abstraction or dependency.
- Treat this as sensitive infrastructure. Include a concurrent two-worktree proof and a smallest-runnable verification strategy.

## Deliverables

- `docs/superpowers/specs/<date>-1013-cluster-global-ddl-serialization.md`
- `docs/superpowers/plans/<date>-1013-cluster-global-ddl-serialization.md`
- A focused commit, pushed branch, and draft PR linked to #1013.
- A concise report to the `Coordinator` pane with PR URL, locked decisions, collision surface, and any genuine decision requiring Ben.

Use `~/Jarv1s` in documentation, never an absolute local path. Do not edit `docs/coordination/`, do not implement feature code, and do not run the full gate.

## Start

Use the relevant pre-development/spec workflow. Inspect first, then write the smallest complete spec and plan. Ask Ben only for a material product or safety fork; otherwise proceed on grounded judgment. Begin now.
