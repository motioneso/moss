# Non-feature backlog burn-down — Wave 2

**Date:** 2026-08-08
**Tracking epic:** #1470
**Issues:** #1155, #1207, #1115, #1433, #1453
**Status:** Approved by Ben on 2026-08-08

## Context

Four read-only grounding reports under `docs/coordination/wave2-prep/` revalidated these five
open issues against live GitHub, current `main`, and the active Wave 1 paths. Current `main`
(`00ec6d5f5bca3312ce7b639cecdd35fec91e5a7a`) is green in CI. The candidate paths are mutually
disjoint and do not collide with Wave 1.

## Goals

- #1155: replace the invalid `:` in proactive-monitoring pg-boss schedule keys with `/` and prove
  the real pg-boss v12 path accepts the key.
- #1207: restore `aria-live="polite"` on the embedded assistant transcript container.
- #1115: show one overdue indicator, keeping the stronger overdue pill.
- #1433: emit one sanitized warning when an ordinary dataset fetch falls back or uses stale cache.
- #1453: replace the fixed 1.2-second negative timing assertion with direct singleton/dedup proof.

## Non-goals

- No new dependency, abstraction, migration, product behavior, or configuration.
- No generic schedule-key helper, assistant redesign, Tasks visual pass, logging/metrics subsystem,
  or connector scheduling change.
- #1433 does not log error messages, bodies, URLs, headers, credentials, or other private data.
- #1453 does not remove or weaken singleton behavior and does not absorb #1454.

## Scope

| Issue | Tier    | Intended seam                                                                  | Smallest implementation and proof                                                                                                                             |
| ----- | ------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1155 | routine | `packages/module-registry/src/index.ts`; focused real-pg-boss integration test | Change `${actorUserId}:${source}` to `${actorUserId}/${source}`; assert the persisted schedule key is accepted and contains no `:`.                           |
| #1207 | routine | `apps/web/src/chat/assistant-surface/surface.tsx`; focused render assertion    | Add `aria-live="polite"` to the transcript container; run all four blocking UAT triggers and post live-UI proof.                                              |
| #1115 | routine | `apps/web/src/tasks/task-list-view.tsx`; existing Tasks surface test           | Suppress the icon/text overdue label only when the overdue pill is present; post manual real-UI proof because no mapped UAT exists.                           |
| #1433 | routine | `packages/datasets/src/client.ts`; `tests/unit/dataset-client.test.ts`         | Warn once with source ID, dataset key, safe error class/status, and outcome; preserve fallback semantics and assert sensitive fields are absent.              |
| #1453 | routine | `tests/integration/connectors-google-schedule-root.test.ts`                    | Hold the first job active, directly attempt the duplicate with the same singleton key, and assert pg-boss returns `null`; repeat the focused integration run. |

## Exit criteria

- Each issue has one focused regression that fails without its fix and passes with it.
- #1207 runs every blocking UAT emitted by the trigger map and carries a real live-path PR comment.
- #1115 carries a real `/tasks` live-path PR comment showing one overdue indicator.
- #1155 exercises real pg-boss v12 rather than a fake-only seam.
- #1433 preserves responses and fallback behavior, and proves no message, body, URL, headers, or
  credentials enter logs.
- #1453 proves the negative singleton property without elapsed-time waiting and includes repeated
  focused-run evidence.
- No lane crosses an unrelated module boundary or adds a dependency.

## Dependency and merge order

All five lanes may build in parallel after approval. Merge in increasing verification risk:
#1207 → #1155 → #1115 → #1433 → #1453. Every lane rebases on current `main` and receives fresh
independent QA after earlier merges. #1207 and #1115 cannot merge without live-path evidence.

## Hard invariants honored

No lane changes auth, RLS, private-data access, job payloads, VaultContext, AccessContext, or
migrations. #1433 receives an explicit log-safety review against the secrets-never-escape
invariant; all other hard invariants are unchanged.
