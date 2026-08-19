# Relay #7 — 1556-notes-retrieval (Phase 2: notes-default retrieval)

Relaying on context-meter 70%+ checkpoint. Supersedes relay-6 and earlier. Plan APPROVED at
`docs/superpowers/plans/2026-08-12-1556-notes-retrieval.md` — read it in full, it's the only
source of truth for remaining work.

## Done, committed (Tasks 1-4, 6 of 12)

- **Task 1** (`d3045c17a`): `RetrievedChunk` gained `updatedAt: Date`. Proven via `pnpm
  test:memory` (self-provisions isolated DB — **not** `pnpm --filter @moss/memory test -- run`,
  that skips root-level integration tests).
- **Task 2** (`c93b6d563`): `packages/notes/src/recall.ts` — `createNotesRecallPort()`,
  `NotesRecallPort`, `NotesRecallSnippet` (`{sourcePath, updatedAt, score, text}`). Exported from
  `packages/notes/src/index.ts`. `@moss/notes` is already a declared dep of `@moss/chat`
  (`packages/chat/package.json`) — import directly, no module-isolation issue.
- **Task 3** (`afc7c68b1`): `packages/chat/src/live/notes-secret-filter.ts` —
  `isCredentialShaped(text): boolean`. NOT barrel-exported — internal to chat, import via relative
  path.
- **Task 4** (`9039ba223`): `ChatPersistencePort.getThreadContext` /
  `DataContextChatPersistence.getThreadContext` return `incognito: boolean` now.
- **Task 6** (`55c54a1ba`): `renderNotesContextBlock(snippets: {sourcePath, updatedAt, text}[])`
  and `combineHiddenContextBlocks(passiveBlock, crossToolBlock, notesBlock?)` — both in
  `packages/chat/src/live/chat-context-blocks.ts`, re-exported from `chat-session-manager.ts`.
  3-block cap: drop lowest-priority first (notes, then cross-tool) at 2000 combined tokens;
  highest-priority survivor always kept even if alone over cap.

Every task: TDD, `pnpm exec tsc --noEmit -p .` standalone (never trust vitest alone — repo lesson,
confirmed again on Task 4), committed by explicit path per `shared-checkout` skill, `git show
--name-only HEAD` verified after each commit.

## Next: Task 5 — `NotesContextRetriever` (NOT started)

New file `packages/chat/src/live/notes-retrieval.ts`, mirrors `PassiveContextRetriever`
constructor-injection shape exactly (already read in full:
`packages/chat/src/live/passive-retrieval.ts:55-152`; fixture pattern in
`tests/unit/chat-passive-retrieval.test.ts:172-290`, e.g. `dataContext: { withDataContext: async
(_ctx, cb) => cb({} as never) }`).

```ts
export interface NotesContextRetrieverDeps {
  readonly dataContext: Pick<DataContextRunner, "withDataContext">;
  readonly notesRecall: NotesRecallPort;               // @moss/notes, Task 2
  readonly settingsRepo?: {
    getOrCreate(scopedDb: DataContextDb, userId: string): Promise<UserMemorySettings>;
  };
}
export class NotesContextRetriever {
  constructor(deps: NotesContextRetrieverDeps);
  retrieveWithItems(input: {
    readonly actorUserId: string;
    readonly userText: string;
    readonly threadTitle: string | null;
    readonly recentTurns: readonly { role: "user" | "assistant"; content: string }[];
    readonly incognito: boolean;
  }): Promise<{ block: string; items: readonly NotesRecallSnippet[] }>;
}
```

Behavior (full detail in plan's Task 5 section — read it, don't re-derive):
1. `input.incognito ⇒ { block: "", items: [] }` immediately, before any query (gate first).
2. Else `settingsRepo.getOrCreate(...).recallEnabled` (default `new
   ChatUserMemorySettingsRepository()` — same as `PassiveContextRetriever`,
   `packages/chat/src/memory-settings-repository.ts:23-39`; independent of `factsEnabled`).
3. Own 500ms timeout via `withPassiveRetrievalTimeout` (`passive-retrieval.ts:227-242`) — distinct
   budget from the outer 750ms.
4. Query = `planPassiveRetrieval(input).query` when `shouldRetrieve`; skip the notes call too if
   `!shouldRetrieve` (no separate notes trigger heuristic).
5. On success: filter each snippet's `.text` through `isCredentialShaped` (Task 3, drop matches +
   log); keep top 5 by `.score`, capped 2000 tokens total (`estimateTokens`,
   `packages/chat/src/live/recall-seed.ts`).
6. Any port error/throw ⇒ caught, empty result, logged.
7. Render via `renderNotesContextBlock` (Task 6, now available at
   `packages/chat/src/live/chat-context-blocks.ts`).

Test: new `tests/unit/chat-notes-retrieval.test.ts`, same fixture shape as
`chat-passive-retrieval.test.ts`. Cases: incognito skips port entirely; `recallEnabled: false`
skips port entirely; slow port ⇒ timeout ⇒ empty; port throws ⇒ empty; >5 snippets/>2000 tokens ⇒
truncated; credential-shaped snippet dropped, remainder still injected.

## After Task 5

- **Task 7**: Phase 1 verification — `pnpm --filter @moss/memory test -- run` +
  `pnpm test:memory` + `pnpm --filter @moss/notes test -- run` + `pnpm --filter @moss/chat test
  -- run`, all unpiped, `echo "EXIT=$?"`, expect 0 each. Also run `pnpm exec tsc --noEmit -p .`
  standalone as part of this gate (Task 4 proved vitest-alone misses ripple breaks). **Kill-gate
  checkpoint before Task 9**: re-confirm Task 3 and Task 5 tests green.
- Phase 2 (Tasks 8-12): persona instruction, live wiring, UAT spec. Do not start before Phase 1's
  kill gate passes.

Message the Coordinator on Phase 1 completion or if blocked — resolve current name via
`ListAgents` (was `coord-overnight-20260810-e7 [19fedb]` as of relay-3, likely stale).

## Task list state

Recreate: #1-5 (orient/verify/seams/plan/approval) completed. #6 (build) in_progress, 5/12 tasks
done (1,2,3,4,6 — 5 pending). #7 (wrap-up) pending. TaskList doesn't persist across sessions.
