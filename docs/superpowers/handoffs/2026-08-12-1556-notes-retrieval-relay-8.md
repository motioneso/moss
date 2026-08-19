# Relay #8 — 1556-notes-retrieval (Phase 2: notes-default retrieval)

Relaying on context-meter 70%+ checkpoint. Supersedes relay-7 and earlier. Plan APPROVED at
`docs/superpowers/plans/2026-08-12-1556-notes-retrieval.md`.

## Phase 1 build (Tasks 1-6) — ALL DONE, committed

- Task 1 `d3045c17a`, Task 2 `c93b6d563`, Task 3 `afc7c68b1`, Task 4 `9039ba223`, Task 6 `55c54a1ba`
  (all detail in relay-7, unchanged).
- **Task 5** `40ea714db`: `packages/chat/src/live/notes-retrieval.ts` (new) —
  `NotesContextRetriever`, mirrors `PassiveContextRetriever`. Gates on `incognito` first, then
  `settingsRepo.getOrCreate(...).recallEnabled` (default `new ChatUserMemorySettingsRepository()`).
  Own 500ms timeout via reused `withPassiveRetrievalTimeout` (distinct from passive's 750ms).
  Query/gate via reused `planPassiveRetrieval` (no separate notes heuristic). Filters
  `isCredentialShaped` snippets (dropped + `console.warn` logged), caps top-5-by-score / 2000
  combined tokens, renders via `renderNotesContextBlock`. Port throw/timeout ⇒ caught, empty
  result, logged. Test `tests/unit/chat-notes-retrieval.test.ts`, 7 cases, all green. **Not**
  barrel-exported from `packages/chat/src/index.ts` (same as Task 3's `isCredentialShaped` —
  internal to chat, import via relative path; Phase 2 live-wiring will import it directly).
  **Gotcha hit**: a shared `const dataContext = {...}` fixture (unlike passive-retrieval's test,
  which inlines the object literal at each call site) loses contextual typing and TS infers
  `unknown` params, which then fails structural assignability against
  `Pick<DataContextRunner, "withDataContext">`. Fix: annotate the const explicitly —
  `const dataContext: Pick<DataContextRunner, "withDataContext"> = { withDataContext: async (_ctx,
  cb) => cb({} as never) };` — restores contextual typing on the arrow fn params.

Every task: TDD, `pnpm exec tsc --noEmit -p .` standalone (never trust vitest alone — confirmed
again on Task 5's fixture-typing gotcha above), committed by explicit path per `shared-checkout`
skill, `git show --name-only HEAD` verified after each commit.

## Task 7 — Phase 1 verification / kill gate: IN PROGRESS, running in background

Started via `run_in_background`, log at `/tmp/1556-task7-verify.log`, sentinel `### FINAL` appended
at the end. Runs in order, each with its own `EXIT_*=<code>` line appended right after it (grep for
these, don't tail blindly — the file interleaves 5 command outputs):

1. `pnpm --filter @moss/memory test -- run` → `EXIT_MEMORY_UNIT`
2. `pnpm test:memory` (integration, self-provisions its own DB — **not** the `--filter` unit
   command, that skips root-level integration tests, per Task 1's relay-6 correction) →
   `EXIT_MEMORY_INTEGRATION`
3. `pnpm --filter @moss/notes test -- run` → `EXIT_NOTES`
4. `pnpm --filter @moss/chat test -- run` → `EXIT_CHAT`
5. `pnpm exec tsc --noEmit -p .` (standalone, catches ripple breaks vitest misses — Task 4 lesson) →
   `EXIT_TSC`

**On resume**: `grep -E 'EXIT_|### FINAL' /tmp/1556-task7-verify.log`. If the file doesn't exist or
has no `### FINAL` line, the background job died with the session — re-run the block from Task 7's
plan section (or copy the command from this relay's git history at commit time).

### If all 5 exit 0 (expected — kill gate passes)

- Mark Task 7 done. Do **not** start Phase 2 (Tasks 8-12: persona instruction, live wiring, UAT
  spec) in this session — that's a fresh planning/build cycle per the plan's phase boundary.
- Message the Coordinator that Phase 1 (#1556) is done, committed, verified — resolve the
  Coordinator's current name via `ListAgents` first (was `coord-overnight-20260810-e7 [19fedb]` as
  of relay-3, likely stale, re-check).
- Update the relay/task state, then this session's remaining job is Task #7 "Wrap up" in the
  TaskList (recreate: #1-6 completed if not already, #7 in_progress → completed after the
  Coordinator message is sent).

### If any exit non-zero — kill gate fails, STOP, diagnose

- Read only the failing command's slice of the log (grep between its header line and the next
  `EXIT_` line — don't read the whole file).
- Do not proceed to message the Coordinator with a pass claim. Fix, re-run just that command
  (unpiped, sentinel pattern), confirm 0, then re-run the full Task 7 block once more end-to-end
  before declaring the gate green (a single fixed command passing alone doesn't prove no new
  breakage was introduced by the fix).

## Task list state

Recreate: #1-5 (orient/verify/seams/plan/approval) completed. #6 (build) — all 6 Phase-1 tasks
done, mark completed once Task 7 confirms green. #7 (wrap-up) — pending, blocked on Task 7's
verification result above.
