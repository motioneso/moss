# Non-feature backlog burn-down — Wave 1

**Date:** 2026-08-08  
**Tracking epic:** #1470  
**Issues:** #1448, #887, #1412, #903, #1272  
**Status:** Approved by Ben on 2026-08-08

## Context

The 2026-08-08 freshness audit reviewed all 139 issues that were open at audit start. It closed 15
fixed or superseded trackers and grouped 78 current non-feature issues under #1470. This first wave
selects five small, independent, well-grounded defects so the fleet can start with low collision
risk while later security and cross-cutting batches receive deeper plans.

Current `main` (`5a5b0a8a7860`) is green in CI.

## Goals

- #1448: make the News web subpath resolve to its real entry in Vitest without per-test mocks.
- #887: remove the wall-clock-dependent 23:59 UTC quiet-hours failure.
- #1412: preserve a real text/accessible space between shared masthead title and accent.
- #903: make the primary Sports follow deterministic when timestamps are equal, in memory and at
  the repository boundary.
- #1272: pin the structured-state manifest migration list to the SQL files on disk.

## Non-goals

- No new product behavior, packages, abstractions, dependencies, migrations, or configuration.
- No broad alias rewrite, clock abstraction, masthead redesign, Sports ranking change, or generic
  manifest-test framework.
- No unrelated cleanup discovered while implementing a lane.

## Resolved decisions

- Reuse existing repository patterns: a specific News web alias before the bare alias, the nearby
  fixed-time notification-test seam, explicit JSX text whitespace, the existing Sports comparator
  and Kysely ordering, and the simplest existing module migration parity test.
- Each issue remains its own branch and PR. The five lanes do not share production files.
- #1448 and #887 use GPT-5.6 Luna high. #1412, #903, and #1272 use the Claude CLI `sonnet`
  alias requested for Sonnet 5; the coordinator verifies the model shown in each pane.
- Internal-only lanes need focused automated evidence. #1412 and #903 also require live-path proof
  because they change user-visible text/selection behavior.

## Architecture and scope

| Issue | Intended files | Smallest implementation |
| --- | --- | --- |
| #1448 | `vitest.config.ts`; one focused unit/jsdom regression | Add the real `@moss/news/web` entry before `@moss/news`; remove the local workaround only if the owning test proves it is redundant. |
| #887 | Existing notification integration test file | Fix the test clock/window; do not change notification production behavior. |
| #1412 | `packages/ui/src/masthead.tsx`; focused component assertion | Insert semantic whitespace in the shared component. |
| #903 | `packages/sports/src/followed-groups.ts`, `packages/sports/src/repository.ts`, existing Sports unit test | Add a stable ID tie-break and matching secondary repository order. |
| #1272 | One focused structured-state manifest/SQL parity test | Compare the declared migration names with the existing SQL directory using the nearest established test pattern. |

## Exit criteria

- Every issue has one focused regression that fails before its fix and passes after it.
- Each lane runs only the smallest relevant checks locally; CI supplies the full mechanical gate.
- No lane adds a dependency or crosses an unrelated module boundary.
- #1412 live proof shows readable/copyable spaced text through the real UI.
- #903 live proof shows stable primary competition selection through the real Sports surface.
- Each PR carries a release-note sentence, or explicitly says the change is not user-visible.
- QA is green under the coordinated-build workflow before merge; issue and board state are then
  updated from GitHub.

## Hard invariants honored

The wave does not touch auth, secrets, private-data access, RLS, job payloads, VaultContext,
AccessContext, or migrations. Sports repository work keeps the existing `DataContextDb` boundary.
