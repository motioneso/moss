# Relay #5 — 1556-notes-retrieval (Phase 2: notes-default retrieval)

Relaying on context-meter 70%+ checkpoint. Plan is APPROVED, build in progress: 3 of 12 tasks
done and committed. Read `docs/superpowers/plans/2026-08-12-1556-notes-retrieval.md` in full —
it is the only source of truth for remaining work. Don't re-derive from `...-relay.md` through
`...-relay-4.md` — this doc supersedes all of them.

## Done, committed

- **Task 1** (`d3045c17a`): `RetrievedChunk` gained `updatedAt: Date`; `vectorSearch()` and
  `listRecentChunks()` (plan only named the former, latter needed the same fix to typecheck —
  in-scope correction) both select/map it. Test in `tests/integration/memory.test.ts`, proven via
  `pnpm test:memory` (self-provisions its own isolated DB — no manual gate-DB setup needed for
  this specific `test:*` script). **Correction to plan's Task 7**: use `pnpm test:memory`, not
  `pnpm --filter @moss/memory test -- run` (that filter skips root-level integration tests).
- **Task 2** (`c93b6d563`): `packages/notes/src/recall.ts` (new) — `createNotesRecallPort()`,
  mirrors `tools.ts`'s `getRetriever`/`notesSearchExecute`. Exported from
  `packages/notes/src/index.ts`. Test `tests/unit/notes-recall.test.ts` mocks `@moss/memory` +
  `@moss/settings` (no existing repo precedent for this — first one). One gotcha: `vi.fn()
  .mockImplementation(() => ({...}))` is NOT a constructor — `MemoryRetriever` mock needed a
  `function MemoryRetriever(this) {...}` form so `new MemoryRetriever(...)` works.
- **Task 3** (`afc7c68b1`): `packages/chat/src/live/notes-secret-filter.ts` (new) —
  `isCredentialShaped()`. NOT in the `./live` public barrel (`public.ts`) — it's internal to chat,
  only Task 5's retriever needs it, no external package consumes it. Test imports it via relative
  path (`../../packages/chat/src/live/notes-secret-filter.js`), matching how other internal
  chat/live modules are tested (deep `@moss/chat/live/*` subpath imports fail at runtime —
  `exports` map only has `.` and `./live`).

Every task above: TDD (watched red for the right reason before implementing), `pnpm exec tsc
--noEmit -p .` run standalone and clean (vitest alone doesn't prove typecheck — a repo-specific
lesson), committed by explicit path per `shared-checkout` skill, `git show --name-only HEAD`
verified after each commit.

## Not started

- **Task 4**: thread `incognito` through `getThreadContext` (`persistence.ts:384-401`,
  `chat-session-ports.ts:73-76`).
- **Task 5**: `NotesContextRetriever` (new `packages/chat/src/live/notes-retrieval.ts`), mirrors
  `PassiveContextRetriever`. Applies Task 3's filter per-snippet before the 5-item/2000-token cap.
- **Task 6**: `renderNotesContextBlock` + extend `combineHiddenContextBlocks` to a third optional
  `notesBlock` param (`chat-context-blocks.ts`).
- **Task 7**: Phase 1 verification — `pnpm --filter @moss/memory test -- run` (unit only) +
  `pnpm test:memory` (integration, covers Task 1) + `pnpm --filter @moss/notes test -- run` +
  `pnpm --filter @moss/chat test -- run`, all unpiped, `echo "EXIT=$?"`, all expect 0. **Kill-gate
  checkpoint before Task 9**: re-confirm Task 3's and Task 5's tests are green.
- Phase 2 (Tasks 8-12) not started — persona instruction, live wiring, UAT spec. Do not start
  until Phase 1's kill gate passes.

## Next concrete step

Task 4, then Task 5, then Task 6, then Task 7 (verification + kill gate), each TDD + standalone
`tsc --noEmit` + commit-by-explicit-path, same pattern as Tasks 1-3 above.

Message the Coordinator on Phase 1 completion or if blocked — resolve via `ListAgents`, not the
raw "Coordinator" label (was `coord-overnight-20260810-e7 [19fedb]` as of relay-3, re-check, may
have changed).

## Task list state

Recreate: #1-5 (orient/verify/seams/plan/approval) — completed. #6 (build) — in_progress, 3/12
tasks done. #7 (wrap-up) — pending. TaskList does not persist across sessions.
