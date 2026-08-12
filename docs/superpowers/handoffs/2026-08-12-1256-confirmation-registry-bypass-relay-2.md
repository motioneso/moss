# Relay 2 — #1256 confirmation registry bypass

**Branch/worktree:** `1256-confirmation-registry-bypass` (this worktree, unchanged — do not
`pnpm install`). **Coordinator label:** `Coordinator` (Herdr, confirmed exactly one pane holds it
at `w1:p7P` as of this relay — re-verify with `herdr pane list` before messaging, don't trust the
pane id). **Risk tier:** security.

## State

Plan approved (see relay-1 doc + `docs/superpowers/plans/2026-08-12-1256-confirmation-registry-bypass.md`).
**Zero code written yet** — this relay is pure implementation-design (found every exact edit site
+ resolved both open decisions) so the next session builds immediately instead of re-deriving.
**Do not re-read relay-1, the issue, or re-verify seams — everything needed is below or in the plan.**

Gate DB already provisioned: `jarvis_gate_1256` (created, empty schema — `resetFoundationDatabase()`
in the test's `beforeAll` will populate it). Export before any test run (Bash tool does not persist
env across calls — put this in every command that runs tests):
`export JARVIS_PGDATABASE=jarvis_gate_1256`. Drop it at wrap-up time per `verify-gate` skill (or let
`coordinated-wrap-up` provision its own fresh one — either is fine, this one is disposable).

## Two build-time decisions — RESOLVED, do not re-litigate

1. **Task 4(a) vs (b): callback form**, per coordinator's prior approval. `ChatRoutesDependencies`
   gets `adoptChatGateway?: (gateway: AssistantToolGateway) => void`.
2. **Lazy-fallback outcome (the plan's "open question"): throw, don't fake `not_found`.** When the
   module-registry holder is empty at call time, the injected `resolveActionRequest` closure throws
   `new HttpError(503, "Assistant action resolution is not available")` (same message as Task 3's
   `dependencies.resolveActionRequest === undefined` branch) instead of resolving to a value. This
   keeps `AiRoutesDependencies.resolveActionRequest`'s return type exactly
   `Promise<"resolved" | "expired" | "not_found">` — unchanged from the plan's Task 3 signature, so
   Task 5's ai/chat parity assertions need no extra outcome variant. `HttpError` is exported from
   `@moss/module-sdk` (`packages/module-sdk/src/route-errors.ts`) and is not yet imported in
   `packages/module-registry/src/index.ts` — add the import. Falling through the ai route's existing
   `try { ... } catch (error) { return handleRouteError(error, reply); }` (already present at the
   resolve handler) turns this into a 503 for free — no new catch needed.

## Exact edit sites (all verified on this branch just now — trust these, don't re-grep)

**`packages/ai/src/repository.ts`** (Task 1) — add right before `createPendingAssistantAction`
(~line 1719, after `listAssistantActions` ends at 1721... actually insert between 1721 and 1723):
```ts
async getAssistantAction(
  scopedDb: DataContextDb,
  actionId: string
): Promise<AiAssistantActionRequestSafeRow | undefined> {
  assertDataContextDb(scopedDb);
  return this.safeAssistantActionQuery(scopedDb).where("id", "=", actionId).executeTakeFirst();
}
```
`safeAssistantActionQuery` private helper is at line 1871 (`selectFrom(...).selectAll().orderBy(...)`)
— reuse as shown, ordering is harmless on a single-row query.

**`packages/ai/src/routes.ts`** (Task 3):
- `AiRoutesDependencies` interface: add after `connectTerminalRpc` (ends ~line 128):
  ```ts
  readonly resolveActionRequest?: (
    actorUserId: string,
    actionRequestId: string,
    status: "confirmed" | "rejected" | "cancelled"
  ) => Promise<"resolved" | "expired" | "not_found">;
  ```
- Replace the resolve handler body, lines 531–549 (`server.post<{ Params: IdParams }>("/api/ai/assistant-actions/:id/resolve", ...)`):
  ```ts
  const accessContext = await dependencies.resolveAccessContext(request);
  const body = parseResolveAssistantActionBody(request.body);
  if (!dependencies.resolveActionRequest) {
    return reply.code(503).send({ error: "Assistant action resolution is not available" });
  }
  const outcome = await dependencies.resolveActionRequest(
    accessContext.actorUserId,
    request.params.id,
    body.status
  );
  if (outcome === "expired") {
    return reply.code(409).send({ error: "This request expired — ask again." });
  }
  if (outcome === "not_found") {
    return reply.code(404).send({ error: "Assistant action request not found" });
  }
  const action = await dependencies.dataContext.withDataContext(accessContext, (scopedDb) =>
    repository.getAssistantAction(scopedDb, request.params.id)
  );
  if (!action) {
    return reply.code(404).send({ error: "Assistant action request not found" });
  }
  return { action: serializeAssistantAction(action) };
  ```
  (keep the existing outer `try {} catch (error) { return handleRouteError(error, reply); }`
  wrapper — only the body inside changes). `body.status` type is already the
  `"confirmed"|"rejected"|"cancelled"` union from `parseResolveAssistantActionBody` — confirm at
  build time, don't assume.

**`packages/shared/src/ai-api.ts:841-849`** (`resolveAiAssistantActionRouteSchema`) — add
`409: errorResponseSchema` to the `response` map. Additive only.

**`packages/chat/src/routes.ts`** (Task 4, chat side):
- `ChatRoutesDependencies` interface: add near `adoptDropSessionsForProvider` (~line 147-150):
  `readonly adoptChatGateway?: (gateway: AssistantToolGateway) => void;` (needs
  `AssistantToolGateway` type import from `./gateway/gateway.js` or wherever chat currently imports
  the gateway type from for `wiring.gateway`'s type — check the existing import at top of file).
- Right after the `wiring = resolveActiveModules && mcpServerUrl ? (() => {...})() : null;` block
  finishes (ends ~line 249, immediately before `const runtime = createChatSessionRuntime({...`):
  ```ts
  if (wiring) dependencies.adoptChatGateway?.(wiring.gateway);
  ```

**`packages/module-registry/src/index.ts`** (Task 4, composition root):
- Add `import { HttpError } from "@moss/module-sdk";` (not currently imported in this file —
  confirmed via grep).
- `BuiltInRouteDependencies` interface: add near `adoptDropSessionsForProvider` field (~line 461):
  `readonly adoptChatGateway?: ChatRoutesDependencies["adoptChatGateway"];`
- Inside `registerBuiltInApiRoutes`, near the existing `let dropSessionsForProvider` /
  `getDropSessionsForProvider` pair (~line 2135-2141), add the same late-bound pattern:
  ```ts
  let resolveActionRequestFn: AssistantToolGateway["resolveActionRequest"] | undefined;
  ```
  (needs `AssistantToolGateway` type import here too — check existing imports, it's likely already
  imported for other typing in this huge file; grep first before adding a duplicate).
- In the `deps: BuiltInRouteDependencies = { ... }` object literal (~line 2265-2280, alongside
  `adoptChatRpcConnection` / `adoptDropSessionsForProvider`), add:
  ```ts
  adoptChatGateway: (gateway: AssistantToolGateway) => {
    resolveActionRequestFn = gateway.resolveActionRequest.bind(gateway);
  },
  ```
- `ai` module's `registerRoutes` call site (~line 1321, inside the `registerAiRoutes(server, {...})`
  call, alongside `connectTerminalRpc`), add:
  ```ts
  resolveActionRequest: (actorUserId, id, status) =>
    resolveActionRequestFn
      ? resolveActionRequestFn(actorUserId, id, status)
      : Promise.reject(new HttpError(503, "Assistant action resolution is not available")),
  ```
- `chat` module's `registerRoutes` call site (~line 1358-1372, alongside `adoptChatRpcConnection:
  deps.adoptChatRpcConnection,`), add: `adoptChatGateway: deps.adoptChatGateway,`

## Task 5 — regression test

`tests/integration/ai.test.ts` already has a `beforeAll` building a real `createApiServer({ appDb,
boss, logger: false })` — confirmed this wires `resolveActiveModules`/`mcpServerUrl` from defaults
(same as prod per `apps/api/src/server.ts:441,519-520`), so chat's `wiring` is non-null and
`adoptChatGateway` fires for real in this test file — no extra server config needed. Add a new
`describe("assistant action resolve parity")` block per the plan's Task 5 section verbatim (seed via
`repository.createPendingAssistantAction`, hit both
`/api/ai/assistant-actions/:id/resolve` and `/api/chat/action-requests/:id/resolve`). Full case list
is in the plan file — don't re-derive, just implement it.

Run: `export JARVIS_PGDATABASE=jarvis_gate_1256 && pnpm test:ai` (repo has a dedicated script —
`package.json`: `"test:ai": "tsx scripts/test-integration.ts tests/integration/ai.test.ts
tests/integration/ai-capability-routes.test.ts tests/integration/ai-structured.test.ts"`). Capture
with `; echo "EXIT=$?"`, never pipe.

## Next steps

1. TDD each task (repo → route → schema → wiring → test), one commit per task, `git add` by
   explicit path.
2. Pre-push trio + rebase before push.
3. `coordinated-wrap-up`: gate on a fresh isolated DB (or reuse `jarvis_gate_1256`, drop after),
   push, PR, note "code-complete, no UAT needed (internal API contract fix)" unless a UI caller
   turns up, flag security tier for Opus QA in the report to Coordinator.

## Constraints (verbatim, unchanged)

Work only in this worktree/branch. `git add` by explicit path only, never `-A`/`.`. Never touch
`docs/coordination/`, the board, milestones, or merge. No secrets anywhere. Do not delete the
resolve route (manifest-declared, `packages/ai/src/manifest.ts:350-356`,
`permissionId: "ai.assistant-actions"`) — additive schema changes only.
