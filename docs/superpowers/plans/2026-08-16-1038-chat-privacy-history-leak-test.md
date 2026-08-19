# Plan — #1038: two-user isolation test for chat privacy/history endpoints

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md` (#1038 row)
**Issue:** #1038 (Part of #984)
**Tier:** security
**Branch:** `1038-chat-privacy-leak-test`

## Seams check (file:line citations from current tree)

- `GET /api/chat/threads` (list) — `packages/chat/src/routes.ts:436-451`. Calls
  `repository.listThreads(scopedDb, surface)` inside `dataContext.withDataContext(accessContext, …)`.
- `ChatRepository.listThreads` — `packages/chat/src/repository.ts:34-46`. Query has **no
  `owner_user_id` filter** — isolation is enforced entirely by RLS on the scoped connection. This is
  the untested surface: `tests/unit/route-coverage.test.ts:54` only asserts the route exists, no
  cross-user test hits it (confirmed via grep, no other match in `tests/**`).
- `GET /api/chat/threads/:id/messages` (detail) — `packages/chat/src/routes.ts:453-475`. Looks up
  the thread, 404s if `thread` is undefined or not owned by the actor, then calls
  `repository.listMessages`.
- `ChatRepository.getThreadById` / `listMessages` — `packages/chat/src/repository.ts:72-99`, same
  RLS-only isolation shape.
- Existing two-user pattern to follow (own new file, not edited) —
  `tests/integration/chat-live-api.test.ts:312-373` (`GET /api/chat/threads/:id/messages returns
  only the owner's stored thread messages` / `…returns 404 for a shared thread grantee`). Confirms
  `dataContext.withDataContext(userAContext(), …)` seeding pattern, `server.inject` with
  `Bearer ${ids.sessionA/B}`, and the `userAContext()`/`userBContext()` helpers
  (`tests/integration/chat-live-api.test.ts:786-792`).
- Shared fixture (reuse, do not rename/edit) — `tests/integration/test-database.ts:22-39` exports
  `connectionStrings`, `ids.userA`/`ids.userB`/`ids.sessionA`/`ids.sessionB`, and
  `resetFoundationDatabase()`.
- `createApiServer` — `apps/api/src/server.ts` — same construction as
  `tests/integration/chat-live-api.test.ts:94-103` (fake `chatEngineFactory`, no tmux/CLI dependency
  needed since this test never calls `/api/chat/turn`).

Open question: none — every capability used is already exercised by the existing #984 test file
cited above, this plan only recombines it against the previously-untested list route.

## Phase 1 (only phase) — cross-user list+detail leak test

**New file:** `tests/integration/chat-privacy-history-leak.test.ts` (distinct name from #1037's
lane per collision notes; does not touch `chat-live-api.test.ts` or `test-database.ts`).

Structure: one `describe` block, `beforeAll` builds `appDb`/`dataContext`/`repository`/`server` via
`resetFoundationDatabase()` + `createApiServer({ appDb, logger: false, chatEngineFactory: fakeEngineFactory })`
(minimal fake engine, copied shape — not imported from the other test file), `afterAll` tears down
`server.close()` / `appDb.destroy()`.

**Seed (in `beforeAll` or a top-of-test setup step):**
- As actor A (`dataContext.withDataContext({ actorUserId: ids.userA, requestId: … }, …)`): open one
  thread via `repository.openNewThread`, record one completed turn via
  `repository.recordCompletedTurn` (question/answer text containing a distinctive marker, e.g.
  `"actor-a-private-question"` / `"actor-a-private-answer"`).
- As actor B: same, with a distinct marker (`"actor-b-private-question"` / `"actor-b-private-answer"`).

**Test case:** `"chat privacy/history endpoints never return another actor's threads or messages"`
1. `GET /api/chat/threads` as actor A (`Bearer ${ids.sessionA}`) → 200. Assert the thread list
   contains A's thread id and does **not** contain B's thread id (`.map(t => t.id)` /
   `expect(...).not.toContain(threadB.id)`).
2. `GET /api/chat/threads` as actor B (`Bearer ${ids.sessionB}`) → 200. Assert the inverse: contains
   B's thread id, not A's.
3. `GET /api/chat/threads/:id/messages` for **B's thread id**, authenticated as actor A → assert
   `statusCode === 404` and the response body contains no message whose `body` matches B's markers.
4. `GET /api/chat/threads/:id/messages` for **A's thread id**, authenticated as actor B → assert
   `statusCode === 404`, no message body matches A's markers.
5. `GET /api/chat/threads/:id/messages` for each actor's **own** thread → 200, and the returned
   messages equal exactly that actor's seeded question/answer (sanity check that the guarantee
   isn't vacuously true because nothing seeded/returned).

**Why it would fail against a broken build:** if RLS were dropped from `app.chat_threads` /
`app.chat_messages`, or the detail route's ownership 404 were removed, steps 1-2 would each start
returning both actors' thread ids in one list, and steps 3-4 would return 200 with the other actor's
message bodies instead of 404. Step 5 guards against a vacuous pass (e.g. an accidentally-empty
list matching "does not contain" trivially).

**Verification (manual, before committing):** temporarily comment out the `dataContext` RLS
session-var set (or the detail route's ownership check) in a scratch/uncommitted edit, run the new
test file alone, confirm it fails (proves the assertions are load-bearing), then discard the scratch
edit (`git checkout -- <file>`) and re-run to confirm green. Record both outcomes in the PR body;
do not commit the scratch edit.

## Kill gate

None needed beyond the standard escalation path — this is a single-phase, single-file, tests-only
lane. If step 3/4/5 above reveals the detail or list endpoint actually leaks cross-user data on the
current `main`-derived branch (i.e. the test fails against unmodified production code), STOP: that
is a `[SECURITY]` finding, escalate to the coordinator immediately, do not silently patch
production code. Owner of that call: Coordinator.

## Verification commands (run at wrap-up, unpiped, exit code checked)

```bash
pnpm format:check > /tmp/1038-format.log 2>&1; echo "EXIT=$?"    # expect 0
pnpm lint > /tmp/1038-lint.log 2>&1; echo "EXIT=$?"               # expect 0
pnpm typecheck > /tmp/1038-typecheck.log 2>&1; echo "EXIT=$?"     # expect 0
```

Targeted test run against an isolated gate DB (recipe: `verify-gate` skill — fresh `DROP
DATABASE IF EXISTS` + `CREATE DATABASE`, `export JARVIS_PGDATABASE=…`, never inline):

```bash
( pnpm vitest run tests/integration/chat-privacy-history-leak.test.ts \
    > /tmp/1038-test.log 2>&1; echo "### FINAL rc=$?" >> /tmp/1038-test.log ) &
# then: grep '### FINAL' /tmp/1038-test.log   — expect rc=0
```

Full gate at wrap-up per `coordinated-wrap-up` (own isolated gate DB, unpiped, `pnpm
verify:foundation`).

## Exit criteria mapping

- Spec exit criterion "#1038 has one focused regression that fails without the RLS/isolation
  guarantee and passes with it" → satisfied by the single test case above plus the manual
  before/after verification step, recorded in the PR body.
- No production code change (tests-only), per Non-goals — unless the manual verification step
  above reveals a real gap, in which case: stop and escalate, not silently fix.
