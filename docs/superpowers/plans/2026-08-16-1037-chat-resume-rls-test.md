# Plan — #1037 chat-resume RLS/privacy regression test

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md` (#1037 row)
**Issue:** #1037 (Part of the post-#1632 wave-2 queue)
**Risk tier:** security
**Branch:** `1037-chat-resume-rls-test`

## Goal

One focused integration test: actor A attempts to resume actor B's live private chat thread via
`POST /api/chat/threads/:id/resume`; assert the RLS/ownership check denies it (404, no thread
content, no session disruption). Tests only — no production code change unless the test proves a
real gap (in which case: stop, escalate `[SECURITY]` to the coordinator, do not fix silently).

## Seams check (file:line citations, current tree)

- Route: `packages/chat/src/live-routes.ts:335-366` — `POST /api/chat/threads/:id/resume` resolves
  the caller's `AccessContext` (`resolveOr401`), then calls
  `runtime.manager.resumeThread(access.actorUserId, threadId, surface)`. No body required; `id` is
  a path param, `surface` an optional query param.
- Manager: `packages/chat/src/live/chat-session-manager.ts:671-700` — `resumeThread` calls
  `persistence.touchExistingThread(actorUserId, threadId, chatSurface)` **first**, before touching
  any live session (comment at :674-675: "Validate ownership FIRST — a stale or foreign id must NOT
  disrupt the active session"). Throws `ChatThreadNotFoundError` when `touchExistingThread` returns
  `false`.
- Persistence: `packages/chat/src/live/persistence.ts:334-344` — `touchExistingThread` runs
  `this.run(actorUserId, ...)`, which scopes the DB call to `actorUserId` (RLS context), then calls
  `chat.touchThread(scopedDb, threadId, chatSurface)`.
- Repository: `packages/chat/src/repository.ts:283-302` — `touchThread` is a plain
  `UPDATE app.chat_threads SET last_active_at = now() WHERE id = threadId AND surface = surface`
  with **no explicit `owner_user_id` filter** — ownership scoping is entirely RLS-enforced (comment
  at :285: "Owner-scoped via RLS; app_runtime holds UPDATE on chat_threads."). This is the exact
  trust boundary the spec wants covered: if RLS ever regresses, this query would silently touch (or
  in a worse regression, return) another actor's row.
- Error mapping: `packages/chat/src/live-routes.ts:649-651` — `ChatThreadNotFoundError` → HTTP 404.
- Existing #984-era pattern to mirror: `tests/integration/chat-live-api.test.ts:312-339` — the
  "owner gets 200 / other actor gets 404" shape for `GET /api/chat/threads/:id/messages`, same
  `server.inject` + `dataContext.withDataContext(userAContext(), ...)` seeding style.
  `tests/integration/chat-live-api.test.ts:341-373` shows the same file's share-grantee case (a
  view-level share grant does not unlock this owner-scoped route family either) — informative
  precedent, not something #1037 needs to duplicate since the resume path takes no share arg.
- Shared fixture: `tests/integration/test-database.ts:33-44` — `ids.userA`/`ids.userB` (RLS
  actors) and `ids.sessionA`/`ids.sessionB` (bearer tokens the running `createApiServer` resolves
  to those actors — see existing usage pattern in `chat-live-api.test.ts:300-310`). Reused
  read-only; not modified, per the run's collision ban.
- RLS classification: `chat` module is `owner-or-share` (memory `rls-shareability`), but the resume
  route (like the messages route above) does not consult shares at all — it is a stricter,
  owner-only code path in practice. The test asserts today's actual behavior (404 for a non-owner,
  no share check needed since none is granted).

No new production capability is assumed; every step above is already-shipped code the test
exercises, not builds.

## Non-goals

- No production code change (this is a pure regression test), no new test helper/abstraction, no
  change to `test-database.ts`.
- Do not touch `docs/coordination/`, the board, or merge.
- File name must be distinct from #1038's lane (same test area, parallel worktree) — see below.

## Task (single phase — this is a one-file, ~1-2 hour lane)

**File:** `tests/integration/chat-resume-privacy.test.ts` (new; distinct from #1038's file, which
covers list/detail history endpoints, not the resume route).

**Structure** (mirrors `chat-live-api.test.ts`'s `beforeAll`/`afterAll` scaffold — `createDatabase`,
`DataContextRunner`, `ChatRepository`, `createApiServer` with the fake in-process engine factory
from that same file's pattern, `resetFoundationDatabase()`):

- `describe("Chat resume RLS (#1037)", ...)`
- Test 1 — `"POST /api/chat/threads/:id/resume denies actor B resuming actor A's private thread"`:
  1. Seed a thread owned by `ids.userA` via `dataContext.withDataContext(userAContext(), ...)` +
     `repository.openNewThread` + `repository.recordCompletedTurn` (same helper calls as
     `chat-live-api.test.ts:313-320`), no share grant.
  2. `server.inject({ method: "POST", url": /api/chat/threads/${thread.id}/resume, headers: { authorization: Bearer ${ids.sessionB} } })`.
  3. Assert `response.statusCode === 404` and the body's `error` field is the not-found message —
     never a 200/204, and never thread content.
  4. Assert no disruption to A's row: re-read the thread via
     `dataContext.withDataContext(userAContext(), (scopedDb) => repository /* or a direct select */)`
     and confirm `last_active_at` is unchanged from step 1 (proves B's denied attempt didn't even
     touch the row — the ownership-first ordering cited above).
- Test 2 — `"POST /api/chat/threads/:id/resume lets actor A resume their own thread"` (positive
  control — without this, a route wired to always 404 would pass Test 1 vacuously):
  1. Same seed, owner-scoped.
  2. `server.inject` as `ids.sessionA`.
  3. Assert `response.statusCode === 204`.

**Why each test would fail against a broken implementation:** if `touchThread` regressed to a
plain `WHERE id = threadId` with RLS bypassed (e.g., a stray `BYPASSRLS` role, or the resume path
switched to an unscoped `rootDb` call), Test 1 would observe a `204` and/or a bumped
`last_active_at` for B's request — the exact violation of "RLS applies to every actor" this test
exists to catch. Test 2 fails independently if the resume route itself breaks for the legitimate
owner (catches a false-"secure" state from an over-broad denial).

## Verification

```bash
pnpm test:integration tests/integration/chat-resume-privacy.test.ts > /tmp/1037-test.log 2>&1; echo "EXIT=$?"
```
*(Matches `package.json:56` (`test:integration": "tsx scripts/test-integration.ts"`) and the
per-file pattern at `package.json:60` (`test:chat`). This provisions its own isolated DB per
`test-database.ts:52-62`'s guard.)* Expected exit code: `0`, with both `it()`s reported passing.

Full gate before PR, per `coordinated-wrap-up` (isolated gate DB, per `verify-gate` skill):
```bash
pnpm verify:foundation > /tmp/1037-gate.log 2>&1; echo "EXIT=$?"
```
Expected: `0`.

Pre-push trio:
```bash
pnpm format:check > /tmp/1037-fmt.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/1037-lint.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/1037-tsc.log 2>&1; echo "EXIT=$?"
```
Expected: `0` each.

## Kill gate

There is no phase 2 — this is a single-phase, single-file lane. The kill condition is narrower:
**if Test 1 fails on the first honest run** (i.e., B's resume attempt returns 204 or thread
content), that is not a test bug to iterate past — it is a live RLS/ownership gap. Owner: stop
immediately, do not patch production code, escalate to the coordinator with `[SECURITY]` per the
handoff's exit criteria. Coordinator (and Ben) decide the fix; this lane's job is proving the gap,
not closing it.

## Determinism / UI

N/a — no UI surface, no model-authored content in this lane.

## Open questions

None — every seam cited above is already-shipped code confirmed by direct read on this branch.
