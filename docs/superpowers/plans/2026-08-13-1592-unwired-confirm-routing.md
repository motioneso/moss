# Build plan — #1592 scope the unwired-gateway 503 to confirm only

**Spec:** `docs/superpowers/specs/2026-08-13-1592-unwired-confirm-routing.md` (approved — PR
#1617 comment 5290446273)
**Task issue:** #1592
**Precondition — satisfied 2026-08-14:** #1591 / PR #1613 merged to `main` (`322e6afb6`); this
branch is rebased onto it and citations below are re-verified against that tree.
Single phase, three tasks.

## Seams check (every capability cited from the current tree)

| Assumed capability                                                                                                                                    | Citation                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-server resolver getter + adoption seam exist                                                                                                      | `packages/module-registry/src/index.ts:2212-2216`, `:2372-2375`                                                                            |
| Ai-route closure is the only unconditional-503 site when composed                                                                                     | `packages/module-registry/src/index.ts:1388-1393`                                                                                          |
| Route 400-parses status before the 503 guard                                                                                                          | `packages/ai/src/routes.ts:547` before `:548-550`; validator `:861-869`                                                                    |
| Owner-scoped, pending-only persist exists and returns row-or-undefined                                                                                | `packages/ai/src/repository.ts:1760-1780`                                                                                                  |
| `HttpError` thrown from the resolver surfaces with its status code                                                                                    | rejected `HttpError(503)` already reaches clients via `handleRouteError` (`packages/ai/src/routes.ts:1176`, observed in PR #1587 QA NEW-2) |
| `@moss/ai` re-exports the gateway barrel (new export is public API)                                                                                   | `packages/ai/src/index.ts:37` → `packages/ai/src/gateway/index.ts`                                                                         |
| `AiRepository` and `DataContextRunner` importable outside packages/ai                                                                                 | `packages/chat/src/routes.ts:235` (`new AiRepository()` in chat), `tests/integration/ai-assistant-action-resolve.test.ts:6-7`              |
| Unwired full-server harness: `mcpServerUrl: ""` is type-valid (`string`, required — `apps/api/src/server.ts:133`) and falsy at the wiring conditional | `packages/chat/src/routes.ts:230-231`; config override seam `apps/api/src/server.ts:102`, `:214`                                           |
| `mcpServerUrl` has no other consumer that would break on `""`                                                                                         | grep: only `packages/module-registry/src/index.ts:421`, `:1426` (pass-through) and inside chat's `if (wiring)` closure                     |

Open question (build-time verify, not a blocker): confirm a server actually boots cleanly with
`mcpServerUrl: ""` — Task 3's harness proves it; if boot fails, fall back to composing
`registerChatRoutes` without wiring deps as in `tests/unit/chat-routes-mcp-token-revoke-adopt.test.ts`.

## Determinism boundary

No model involvement anywhere on this path. The route's success response renders from the DB
record (re-fetch + `serializeAssistantAction`, `packages/ai/src/routes.ts:562-570`). The model
gets zero jobs in this change.

## Task 1 — unwired resolver export (`packages/ai/src/gateway/gateway.ts`)

New standalone export in the same file as the gateway class, so every caller of
`repository.resolveAssistantAction` remains in `gateway.ts`:

```ts
export function createUnwiredActionResolver(deps: {
  readonly runner: DataContextRunner;
  readonly repository?: AiRepository; // defaults to new AiRepository()
}): AssistantToolGateway["resolveActionRequest"];
```

Contract (no body here; behavior is the contract):

- `status === "confirmed"` → throw `new HttpError(503, "Assistant action resolution is not
available")` — byte-identical message to `packages/module-registry/src/index.ts:1392`, before
  any DB access.
- `"rejected" | "cancelled"` → owner-scoped pending-only persist via
  `repository.resolveAssistantAction` under `runner.withDataContext` with
  `{ actorUserId, requestId: "unwired_" + randomUUID() }` → `"not_found"` when no row matched,
  else `"resolved"`. No confirmation-registry calls.

Re-export through `packages/ai/src/gateway/index.ts` (barrel already re-exported by
`packages/ai/src/index.ts:37`).

## Task 2 — fallback wiring (`packages/module-registry/src/index.ts`)

In the ai module's `registerRoutes` scope, build the fallback once per server and use it when the
getter yields nothing. The closure at `:1388-1393` becomes (decision, exact code at build):
`const fn = deps.getResolveActionRequestFn?.() ?? unwiredResolver; return fn(actorUserId, id,
status);` where `unwiredResolver = createUnwiredActionResolver({ runner: deps.dataContext })`.

Unchanged on purpose: the route-level guard `packages/ai/src/routes.ts:548-550` (floor for direct
`registerAiRoutes` callers), the chat route, the gateway class, all SQL.

## Task 3 — tests (new file, avoids #1613 merge friction)

`tests/integration/ai-assistant-action-resolve-unwired.test.ts` — full server via
`createApiServer` with `apiServerConfig: { host: "127.0.0.1", port: 0, mcpServerUrl: "",
externalModulesDir: <tmp> }` (harness pattern: `tests/integration/external-modules-routes.test.ts:66-75`;
seed pattern: `tests/integration/ai-assistant-action-resolve.test.ts`). Two users (owner A,
member B), actions seeded as A.

Test cases — behavior, and why each fails against a broken implementation:

1. **A rejects own pending action → 200**, response `action.status === "rejected"`, DB row
   `rejected`. Fails against today's tree (503) — the headline regression test.
2. **A cancels own pending action → 200**, row `cancelled`. Same failure mode; proves the fix
   isn't reject-only.
3. **A confirms own pending action → 503**, row still `pending`, `resolved_at` null. Fails if
   the fallback wrongly persists confirm (phantom-confirmed — the exact hazard
   `gateway.ts:455-461` documents) or maps it to 409.
4. **B rejects A's pending action → 404**, row still `pending` under A's scope. Fails if the
   fallback skips the RLS-scoped runner (cross-user resolution — would re-open the #1256 class).
5. **A rejects an unknown v4 UUID → 404.** Fails if the fallback throws instead of returning
   `"not_found"` (500 regression).
6. **A rejects an already-`rejected` row → 404**, status unchanged. Fails if the persist is not
   pending-only (terminal rows must never flip).
7. **A posts `status: "executed"` → 400.** Pins the parse-before-503 ordering row of the matrix.
8. Wired parity untouched: the existing `tests/integration/ai-assistant-action-resolve.test.ts`
   suite passes unmodified (asserted by the full gate, not by editing that file).

## Verification (unpiped, expected exit codes; DB runs via the `verify-gate` skill on an isolated gate DB)

```bash
pnpm vitest run tests/integration/ai-assistant-action-resolve-unwired.test.ts > /tmp/1592-test.log 2>&1; echo "EXIT=$?"   # EXIT=0
pnpm vitest run tests/integration/ai-assistant-action-resolve.test.ts > /tmp/1592-parity.log 2>&1; echo "EXIT=$?"          # EXIT=0
pnpm verify:foundation > /tmp/1592-gate.log 2>&1; echo "EXIT=$?"                                                            # EXIT=0
```

Pre-push trio: `pnpm format:check`, `pnpm lint`, `pnpm typecheck` — each `; echo "EXIT=$?"`,
each EXIT=0. Root `pnpm typecheck`, never package-filtered.

## E2E / live-path statement

The executable proof for this change **is** the Task 3 integration suite: the unwired topology is
unreachable through any real UI or deployment (`apps/api/src/server.ts:179` always sets
`mcpServerUrl`), so no Playwright/live-dev run can exercise it — live-path gate n/a, per its own
out-of-scope clause (no user-visible surface). PR body states this plainly and carries the
release-note line: "Internal correctness fix (test topologies only); no user-visible change."

## Kill gate

Owner: Coordinator (Ben for any security-behavior fork). Ends the line: unwired reject/cancel
turns out to require editing the wired `resolveActionRequest` body, the `ConfirmationRegistry`,
or any RLS policy — scope escape from a non-blocking test-topology fix; stop and report instead
of widening.

## Rulings ledger (facts established during spec grounding, 2026-08-13)

- Pre-#1587 route persisted all statuses directly (`git show 2c00c3ace~1:packages/ai/src/routes.ts`)
  — that direct persist _was_ the #1256 bypass; only confirm needed gating.
- "Execute" is not an API status (`packages/ai/src/routes.ts:861-869`); execution = confirm
  unblocking a live waiter inside the gateway.
- Chat's resolve route does not exist unwired (`packages/chat/src/routes.ts:370-410`) — no chat-side
  work in #1592.
- `#1587` QA invariant to preserve: `repository.resolveAssistantAction` callers all live in
  `gateway.ts` (`:300`, `:467` post-#1613 merge; was `:451`).
- `ApiServerConfig.mcpServerUrl` is required `string` but `""` is falsy at
  `packages/chat/src/routes.ts:230-231` — the cast-free unwired harness.
- #1613 overlap: `gateway.ts` + `ai-assistant-action-resolve.test.ts`; wired confirm on a
  non-pending/foreign row → 404 post-#1591 (was 409 for already-resolved). Landed on `main` as
  `322e6afb6` (2026-08-14); branch rebased onto it — no serialization constraint remains.
