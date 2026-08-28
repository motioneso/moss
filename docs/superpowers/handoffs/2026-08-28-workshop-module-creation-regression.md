# Workshop module creation regression

## Task

Diagnose and fix the report that Moss still cannot create modules through the Workshop UI, and that the behavior appears worse after recent changes. Find the root cause in the end-to-end create flow rather than papering over one screen.

## Scope and guardrails

- Start from `origin/main` (the base worktree is currently at `098e5dabb`).
- Read `AGENTS.md` and `CLAUDE.md` in full before editing.
- Prefer the codebase-memory MCP graph for code discovery: trace the Workshop create action through the web client, API route, module-build worker/storage, and resulting module registration. Fall back to bounded text search for literals/configuration.
- Reproduce the failure with the smallest existing unit/integration/e2e test or a focused manual check.
- Implement the smallest root-cause fix and add one regression test at the failing boundary.
- Run focused tests plus typecheck/lint/format checks appropriate to changed files. Report any unrelated failures with exact paths.
- Do not reset, stash, or broadly stage. Do not touch the coordinator's working tree or unrelated changes.

The coordinator's worktree at `~/Jarv1s` has unrelated uncommitted work, including recent module-build/workshop edits. If needed, inspect that diff read-only for comparison; do not modify or stage files there. Treat those edits as belonging to another session.

## Start

1. Read the repository instructions and inspect the Workshop page, create-module request, backend route, build/worker path, and module registration path.
2. Trace callers and data flow with the graph before choosing an edit.
3. Reproduce the current failure and identify the first broken boundary (request, authorization, persistence, build execution, or refresh/registration).
4. Patch only the owning boundary, add regression coverage, and verify it.
5. Commit your fix on your branch, push it, open a PR against `main`, and return the PR URL, root cause, changed files, and verification results. Do not merge without coordinator confirmation.
