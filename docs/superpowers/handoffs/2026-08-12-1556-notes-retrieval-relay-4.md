# Relay #4 — 1556-notes-retrieval (Phase 2: notes-default retrieval)

Relaying on context-meter 70% checkpoint (harness hook, not the coordinator's ~80% figure — real
work is now in flight so relaying at the safer, earlier point rather than pushing further mid-task).

**Plan APPROVED by coordinator.** Building has started. Task 1 of 12 done and committed.

## State

- Plan: `docs/superpowers/plans/2026-08-12-1556-notes-retrieval.md` — read it in full, it's the
  only source of truth for remaining work. Don't re-derive from older relay docs (`...-relay.md`
  through `...-relay-3.md`) — this doc supersedes all of them.
- **Task 1 DONE, committed `d3045c17a`**: `packages/memory/src/repository.ts` — `RetrievedChunk`
  gained `readonly updatedAt: Date`; both `vectorSearch()` and `listRecentChunks()` now select
  `updated_at` and map it (plan only mentioned `vectorSearch()`, but `listRecentChunks()` also
  constructs a `RetrievedChunk` literal and would fail to typecheck without the same field — fixed
  as an obvious in-scope correction, not an escalation). Test added to
  `tests/integration/memory.test.ts` (DB-touching, ran via `pnpm test:memory` — self-provisions an
  isolated DB via `scripts/test-integration.ts`, no manual `verify-gate` DB setup needed for this
  specific `test:*` script). Verified: 67/67 tests passed, exit 0
  (`/tmp/1556-task1-memory-integration.log`).
- **Correction to plan's Task 7 verification commands**: `pnpm --filter @moss/memory test -- run`
  only runs `packages/memory`'s co-located unit tests — it does NOT run
  `tests/integration/memory.test.ts` (repo-root integration tests are separate). Use
  `pnpm test:memory` (root `package.json:74`) to cover the Task 1 DB test specifically. Keep the
  plan's other two Task 7 commands as-is for `@moss/notes`/`@moss/chat` unit coverage.
- Tasks 2-7 (Phase 1 remainder) not started: notes-recall port, secret filter, incognito gating,
  `NotesContextRetriever`, `renderNotesContextBlock`. All fully specified in the plan with exact
  signatures — no further seams-check reading needed, just build task-by-task, TDD, commit per
  task via the `shared-checkout` skill (never `git add -A`/bare commit; diff co-edited files before
  committing by explicit path — not an issue so far, no other session has touched these files).

## Next concrete steps

1. Task 2: `packages/notes/src/recall.ts` (new) — `NotesRecallSnippet`/`NotesRecallPort`/
   `createNotesRecallPort()`. TDD: `tests/unit/notes-recall.test.ts` first.
2. Task 3: `packages/chat/src/live/notes-secret-filter.ts` (new) — `isCredentialShaped()`. TDD:
   `tests/unit/notes-secret-filter.test.ts` first.
3. Task 4: thread `incognito` through `getThreadContext` (`persistence.ts:384-401`,
   `chat-session-ports.ts:73-76`).
4. Task 5: `NotesContextRetriever` (`packages/chat/src/live/notes-retrieval.ts`, new).
5. Task 6: `renderNotesContextBlock` + extend `combineHiddenContextBlocks` to 3 args
   (`chat-context-blocks.ts`).
6. Task 7: run all three Phase 1 verification commands (see correction above) — all must exit 0.
   **Kill-gate checkpoint** before Task 9: re-confirm Task 3's and Task 5's tests are green.
7. Only then start Phase 2 (Tasks 8-12).
8. Message the `Coordinator` label on Phase 1 completion or if blocked — resolve via `ListAgents`
   to the actual peer name+ref (was `coord-overnight-20260810-e7 [19fedb]` last session; re-check
   with `ListAgents`/`herdr pane list`, it may have changed).

## Task list state

Recreate: #1-5 (orient/verify/seams/plan/approval) — completed. #6 (build) — in_progress, Task 1
of 12 done. #7 (wrap-up) — pending. TaskList does not persist across sessions.
