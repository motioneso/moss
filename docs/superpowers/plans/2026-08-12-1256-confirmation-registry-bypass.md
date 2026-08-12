# Plan — #1256 confirmation registry bypass

**Spec:** issue #1256 body is the spec (no separate spec doc on disk — see handoff). **Risk tier:**
security. **Branch:** `1256-confirmation-registry-bypass` off `origin/main` @ `33f57b1fa`.

## Seams check (file:line, verified on this branch)

- Bug site: `packages/ai/src/routes.ts:533-553` — `POST /api/ai/assistant-actions/:id/resolve`
  calls `repository.resolveAssistantAction` directly, no gateway/registry involvement. Confirmed
  still present, unchanged from issue's citation.
- Fail-closed guard it bypasses: `packages/ai/src/gateway/gateway.ts:433-458`
  (`AssistantToolGateway.resolveActionRequest`) — returns `"resolved" | "expired" | "not_found"`;
  on `status === "confirmed"` with no live waiter (`!confirmations.isAwaiting(id)`) returns
  `"expired"` without writing. On resolve it already holds the updated row internally (local
  `resolved` var, discarded) before returning just the string outcome.
- Working precedent for the same call: `packages/chat/src/routes.ts:346-382` — POST
  `/api/chat/action-requests/:id/resolve` calls `wiring.gateway.resolveActionRequest`, maps
  `"expired"→409`, `"not_found"→404`, else `204`.
- **The gateway instance does not exist at `packages/ai` registration time.** It's constructed
  inside `registerChatRoutes` (`packages/chat/src/routes.ts:221`, inside the `wiring = ... ? (() =>
{...})() : null` block), because it needs chat-only collaborators
  (`buildChatGatewayDependencies`). `packages/ai` cannot import `@moss/chat` — tried and reverted
  before, per the existing comment at `packages/ai/src/routes.ts:122-126` on `connectTerminalRpc`.
  Same comment documents the established fix pattern: composition root injects a plain callback
  into `AiRoutesDependencies` so `packages/ai` never needs the `@moss/chat` edge.
- Module registration order: `packages/module-registry/src/index.ts` registers the `ai` module
  (line ~1314) **before** the `chat` module (line ~1353) — so `registerAiRoutes` runs before the
  gateway is constructed. A same-tick "pass the instance in" is not possible; needs a late-bound
  setter, same "adopt" pattern already used for `adoptChatRpcConnection` /
  `adoptDropSessionsForProvider` (`packages/chat/src/routes.ts:137-153`, wired through
  `packages/module-registry/src/index.ts:451-461` and set at `:2269-2277`). Also matches the
  sports-module precedent: "the briefing tool adopts the client via a late-bound setter" (comment
  at `packages/module-registry/src/index.ts:1608-1610`). Route **handlers** only run after
  `server.ready()`, i.e. after every module's `registerRoutes` has run — so a lazily-read holder
  populated during chat's registration is guaranteed set before any real request hits the ai route.
- In real deployments `resolveActiveModules` + `mcpServerUrl` are always supplied
  (`apps/api/src/server.ts:441,519-520`), so chat's `wiring` is non-null and the adopt call always
  fires. Still code defensively for the case it doesn't (test harnesses that build a partial
  composition): ai route returns 503 rather than silently no-op'ing.
- Repository has no single-row getter for an assistant action
  (`packages/ai/src/repository.ts` — confirmed via grep, only `listAssistantActions` and the
  update-returning `resolveAssistantAction` exist). Needed because the gateway's
  `resolveActionRequest` returns only the outcome string, not the row, and the ai route's existing
  200 response serializes `{ action }`.
- Response schema: `packages/shared/src/ai-api.ts:841-849` (`resolveAiAssistantActionRouteSchema`)
  — currently `response: { 200, 400, 401, 404 }`. No `409`. Additive change per issue's own note
  ("If the response must carry the resolution outcome, that is an additive schema change").
- Manifest declaration (route must not be deleted, `permissionId` unchanged):
  `packages/ai/src/manifest.ts:350-356`.

## Task 1 — repository: add single-row getter

`packages/ai/src/repository.ts`, near `resolveAssistantAction` (~line 1752):

```ts
async getAssistantAction(
  scopedDb: DataContextDb,
  actionId: string
): Promise<AiAssistantActionRequestSafeRow | undefined>
```

Plain `selectFrom("app.ai_assistant_action_requests").selectAll().where("id","=",actionId).executeTakeFirst()` shape, RLS-scoped via `scopedDb` like every other repository method here (see `listAssistantActions` immediately above it for the exact column-safety pattern already in use).

## Task 2 — gateway: expose the adopt seam

No behavior change to `AssistantToolGateway.resolveActionRequest`'s signature or logic — reuse it
as-is (`packages/ai/src/gateway/gateway.ts:433`). Nothing to edit here; task kept only to record
that this was checked and intentionally left alone (its return-type contract is shared with the
chat route and must not drift).

## Task 3 — `packages/ai/src/routes.ts`: consume the injected resolver

Add to `AiRoutesDependencies` (after `connectTerminalRpc`, same doc-comment style pointing at the
composition root):

```ts
readonly resolveActionRequest?: (
  actorUserId: string,
  actionRequestId: string,
  status: "confirmed" | "rejected" | "cancelled"
) => Promise<"resolved" | "expired" | "not_found">;
```

Replace the handler body at `packages/ai/src/routes.ts:536-552` (`POST
/api/ai/assistant-actions/:id/resolve`):

- Parse body first (unchanged: `parseResolveAssistantActionBody`).
- If `dependencies.resolveActionRequest` is undefined → `reply.code(503).send({ error:
"Assistant action resolution is not available" })`.
- Else call it with `(accessContext.actorUserId, request.params.id, body.status)`.
- `"expired"` → `reply.code(409).send({ error: "This request expired — ask again." })` (same
  message text as `packages/chat/src/routes.ts:372`, so the two routes are trivially diffable).
- `"not_found"` → `reply.code(404).send({ error: "Assistant action request not found" })`
  (existing message, unchanged).
- `"resolved"` → fetch via `dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
repository.getAssistantAction(scopedDb, request.params.id))`; if somehow absent, 404 (defensive,
  shouldn't happen); else `{ action: serializeAssistantAction(action) }` (unchanged shape).

`resolveAiAssistantActionRouteSchema` in `packages/shared/src/ai-api.ts:841-849`: add `409:
errorResponseSchema` to the `response` map. Additive only — do not touch 200/400/401/404.

## Task 4 — module-registry: wire the late-bound adopt seam

`packages/module-registry/src/index.ts`:

- Composition-root holder, declared once above the module-registration array (same file, near
  where other cross-module mutable state for this array is declared): a mutable box holding the
  bound `resolveActionRequest` function once chat wiring exists.
- `ai` module's `registerRoutes` (line ~1321 call site): pass `resolveActionRequest: (actorUserId,
id, status) => holder.resolveActionRequest?.(actorUserId, id, status) ?? Promise.resolve("not_found" as const)`
  — read lazily at call time (route handler invocation), not at registration time, so it observes
  whatever the holder holds by the time a real request arrives (registration order, not call-time
  order, is what's fixed).

  _Open question the plan does not settle in code:_ `"not_found"` is not quite honest as the
  fallback when the gateway was simply never wired (vs the row genuinely not existing) — but 503
  from Task 3 is only reached when the field itself is `undefined`, not when the holder is empty at
  call time. Decide at build time whether the lazy fallback should also read as 503-equivalent
  (e.g. throw and let `handleRouteError` map it, or extend the outcome union) — pick whichever
  keeps `packages/ai` and `packages/chat` outcome vocab identical, since Task 5's regression test
  asserts exact parity. Do not silently ship a `"not_found"` that isn't real.

- `chat` module's `registerRoutes` (line ~1358 call site, alongside the existing
  `adoptChatRpcConnection` / `adoptDropSessionsForProvider` passthroughs at `:1369-1372`): after
  `registerChatRoutes` returns... **but the gateway is a local `const` inside `registerChatRoutes`,
  never returned.** Two options, pick one at build time:
  (a) give `ChatRoutesDependencies` its own `adoptChatGateway?: (gateway: AssistantToolGateway) =>
void` callback (mirrors `adoptChatRpcConnection` exactly) and call it right after `wiring` is
  constructed inside `registerChatRoutes` (`packages/chat/src/routes.ts:249`, right after the
  `wiring = ...` block, `if (wiring) dependencies.adoptChatGateway?.(wiring.gateway);`); or
  (b) have `registerChatRoutes` return `{ gateway }` and have the composition root capture it from
  the call's return value instead of a callback.
  (a) matches the existing precedent exactly (two prior examples in this same file use a callback,
  none use a return value) — prefer (a) unless build turns up a reason not to.
- Wire the composition-root holder's setter into the `adoptChatGateway` passthrough, same as
  `adoptChatRpcConnection` is wired at `packages/module-registry/src/index.ts:2269-2277`.

## Task 5 — regression test: prove the two paths can't drift

New or extended integration test (repo tests live under top-level `tests/`, not co-located —
see `tests/integration/ai.test.ts`, which already builds a full `createApiServer` and already
imports `AiRepository`, `dataContext`, `ids`). Add a `describe("assistant action resolve parity")`
block there (reuses the existing `beforeAll` server):

- **Case: expired / no live waiter.** Seed a `pending` row directly via repository/SQL (no live
  MCP tool call in flight, so `confirmations.isAwaiting` is false for both paths — this is the
  exact scenario the bug lets through). Hit `POST /api/ai/assistant-actions/:id/resolve` with
  `{status:"confirmed"}` on one seeded row and `POST /api/chat/action-requests/:id/resolve` with
  the same body on a second seeded row. Assert **both** return `409` with an error body, and assert
  via a direct repository read that **neither row's `status` changed from `pending`** (this is the
  behavior the bug violates today — currently the ai route would flip it to `confirmed`).
- **Case: not found.** Both routes, random UUID, both `404`.
- **Case: reject (always terminal, no waiter needed).** Seed a pending row, `POST
.../resolve {status:"rejected"}` on the ai route; assert `200` with `action.status === "rejected"`
  and the DB row updated. (No chat-side comparison needed here since reject doesn't depend on a
  live waiter — this just proves the re-pointed route still does its ordinary job.)
- Run: `pnpm --filter @moss/api test -- ai.test.ts` (or the repo's actual per-file test invocation
  — confirm exact command from `package.json` scripts at build time) — expect exit 0. Do **not**
  pipe; capture with `; echo "EXIT=$?"`.

## Kill gate

After Task 3+4 land and Task 5's expired-case assertion passes locally (proving the persist-without-
waiter bug is closed), that's the whole fix — there is no phase 2. If Task 4's adopt-wiring turns
out to need a bigger seam than described (e.g. module registration order must change), stop and
escalate to the coordinator before restructuring `module-registry`'s array — that's a bigger blast
radius than this issue's scope. Owner of that call: coordinator.

## Exit criteria (from handoff, unchanged)

- `resolve` route re-pointed at `gateway.resolveActionRequest`; both paths behave identically
  including the expired/no-waiter case.
- Route not deleted; manifest declaration and `permissionId` unchanged.
- Regression test proving the two paths can't drift.
- Full gate green on an isolated gate DB (`verify-gate` skill). PR open, rebased on `origin/main`,
  security tier — Opus adversarial QA required before merge (per handoff).
- No UI surface — note "code-complete, no UAT needed (internal API contract fix)" in the PR per
  handoff, unless build turns up a UI caller.
