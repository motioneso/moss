# Relay #6 — 1556-notes-retrieval (Phase 2: notes-default retrieval)

Relaying on context-meter 70%+ checkpoint. Plan is APPROVED, build in progress: 4 of 12 tasks
done and committed. Read `docs/superpowers/plans/2026-08-12-1556-notes-retrieval.md` in full — it
is the only source of truth for remaining work. Don't re-derive from `...-relay.md` through
`...-relay-5.md` — this doc supersedes all of them.

## Done, committed

- **Task 1** (`d3045c17a`): `RetrievedChunk` gained `updatedAt: Date`. Proven via `pnpm test:memory`
  (self-provisions its own isolated DB). **Correction to plan's Task 7**: use `pnpm test:memory`,
  not `pnpm --filter @moss/memory test -- run` (that filter skips root-level integration tests).
- **Task 2** (`c93b6d563`): `packages/notes/src/recall.ts` (new) — `createNotesRecallPort()`.
  Exported from `packages/notes/src/index.ts`. Test mocks `@moss/memory`+`@moss/settings` — no
  prior repo precedent, gotcha: `MemoryRetriever` mock needs `function MemoryRetriever(this) {...}`
  form, not an arrow fn (arrow isn't a constructor, `new` throws).
- **Task 3** (`afc7c68b1`): `packages/chat/src/live/notes-secret-filter.ts` (new) —
  `isCredentialShaped()`. NOT in the `./live` public barrel — internal to chat. Test imports via
  relative path (deep `@moss/chat/live/*` subpath imports fail at runtime, `exports` map only has
  `.` and `./live`).
- **Task 4** (`9039ba223`): `ChatPersistencePort.getThreadContext` (`chat-session-ports.ts:73-76`)
  and `DataContextChatPersistence.getThreadContext` (`persistence.ts:384-401`) now return
  `incognito: boolean` (from `thread?.incognito ?? false`). Additive field. **Two other
  `ChatPersistencePort` implementers had to be updated to keep typecheck green** (found via
  standalone `tsc`, not vitest): `tests/unit/chat-live-manager.test.ts`'s `FakePersistence` class,
  and two inline fakes in `tests/integration/chat-token-budgets.test.ts` (lines ~423, ~456). New
  test `tests/unit/chat-live-persistence-thread-context.test.ts` covers the round-trip (true/
  false/no-current-thread) against `DataContextChatPersistence` directly, using the
  `dataContext(): DataContextRunner` fake pattern from `chat-runtime-persona.test.ts:47-54`
  (`withDataContext` calls `fn({} as DataContextDb)` directly, no real DB).

Every task above: TDD (watched red for the right reason before implementing), `pnpm exec tsc
--noEmit -p .` run standalone and clean (vitest alone doesn't prove typecheck — a repo-specific
lesson, confirmed again this task: vitest was green while tsc caught 2 real errors), committed by
explicit path per `shared-checkout` skill, `git show --name-only HEAD` verified after each commit.

## Not started

- **Task 5**: `NotesContextRetriever` (new `packages/chat/src/live/notes-retrieval.ts`), mirrors
  `PassiveContextRetriever`. Applies Task 3's `isCredentialShaped()` filter per-snippet before the
  5-item/2000-token cap. Will consume Task 4's `threadCtx.incognito` and Task 2's
  `createNotesRecallPort()`.
- **Task 6**: `renderNotesContextBlock` + extend `combineHiddenContextBlocks` to a third optional
  `notesBlock` param (`chat-context-blocks.ts`).
- **Task 7**: Phase 1 verification — `pnpm --filter @moss/memory test -- run` (unit only) +
  `pnpm test:memory` (integration, covers Task 1) + `pnpm --filter @moss/notes test -- run` +
  `pnpm --filter @moss/chat test -- run`, all unpiped, `echo "EXIT=$?"`, all expect 0. Given
  Task 4's typecheck-only breakage in `tests/integration/`, also run `pnpm exec tsc --noEmit -p .`
  standalone as part of this gate, not just the package-scoped vitest runs. **Kill-gate checkpoint
  before Task 9**: re-confirm Task 3's and Task 5's tests are green.
- Phase 2 (Tasks 8-12) not started — persona instruction, live wiring, UAT spec. Do not start
  until Phase 1's kill gate passes.

## Next concrete step

Task 5, then Task 6, then Task 7 (verification + kill gate), each TDD + standalone `tsc --noEmit`
+ commit-by-explicit-path, same pattern as Tasks 1-4 above. Before implementing Task 5/6, grep for
ALL implementers/consumers of whatever signature changes (as Task 4 required) — don't rely on
vitest alone to surface them.

Message the Coordinator on Phase 1 completion or if blocked — resolve via `ListAgents`, not the
raw "Coordinator" label (was `coord-overnight-20260810-e7 [19fedb]` as of relay-3, re-check, may
have changed).

## Task list state

Recreate: #1-5 (orient/verify/seams/plan/approval) — completed. #6 (build) — in_progress, 4/12
tasks done. #7 (wrap-up) — pending. TaskList does not persist across sessions.
