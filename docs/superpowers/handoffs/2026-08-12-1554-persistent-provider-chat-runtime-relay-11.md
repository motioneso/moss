# #1554 persistent-provider-chat-runtime — relay #11

Task #6 done. Commit: `21723cde5`.

## #1256 re-verification (Finding B protocol, fresh not trusted from relay-10)

Relay-10 said "still open, unmerged, no PR." Re-checked fresh:
- `gh issue view 1256` → OPEN.
- `gh pr list --head 1256-confirmation-registry-bypass` → **PR #1587 now exists, OPEN**, `mergedAt: null`, `mergeable: MERGEABLE`.
- Diffed sibling worktree `.claude/worktrees/1256-confirmation-registry-bypass`'s `routes.ts`/`index.ts` against `origin/main` — its changes (adds `adoptChatGateway` field + call site) match the plan's Finding B citation exactly, and are NOT present in this worktree's base.

Applied Finding B **step 3** (not-yet-merged case): proceeded against current origin/main without blocking on #1256's merge order. Placed the new `adoptMcpTokenRevoke` call site in `routes.ts` *after* `createChatSessionRuntime(...)` (grouped with the other post-runtime adopt calls), not at the pre-runtime insertion point where #1256's `adoptChatGateway` will land — minimizes textual collision. Whichever PR merges second gets an ordinary additive rebase conflict; resolve by keeping both sides, per the plan.

## Deliberate deviation from the literal task text — read before assuming task #6 is wrong

The task prompt (and the plan's Finding B text) says "construct the real `PersistentRuntimePool` instance in `routes.ts` alongside `tokens = new SessionTokenRegistry()`." **That text is stale.** Task #5's actual implementation already builds the one real, production-live pool inside `runtime.ts`'s `createRealEngineFactory`, reached via `chat-multiplexer.ts`'s `resolveChatEngineFactory` (called from `module-registry/index.ts`'s `onReady` hook). `routes.ts` always passes an explicit `engineFactory: dependencies.chatEngineFactory` (non-undefined in production) into `createChatSessionRuntime`, which makes `createChatSessionRuntime`'s own internal pool-composition path (`engineSelection`) dead code in production — `engineSelection: dependencies.chatEngineFactory ? undefined : dependencies.engineSelection` never runs the composition branch when a factory is supplied.

Building a second `PersistentRuntimePool` in `routes.ts` would be disconnected dead code. Instead, implemented what relay-10 itself recommended: a new late-bound "adopt" seam (`adoptMcpTokenRevoke`, same pattern as `adoptChatRpcConnection`/`adoptDropSessionsForProvider`) that publishes `wiring.tokens.revokeBySessionId` from `routes.ts`'s `registerChatRoutes` closure, through `module-registry/index.ts`, into `chat-multiplexer.ts`'s `resolveChatEngineFactory`'s new `onPersistentReap` dep — closing task #5's documented gap (`chat-multiplexer.ts:596-609` in the old code, now removed).

## Files changed (commit `21723cde5`)

- `packages/module-registry/src/chat-multiplexer.ts` — `resolveChatEngineFactory` gains `onPersistentReap?: (sessionKey, reason: ReapReason) => void`, forwarded straight to `createRealEngineFactory`. Old KNOWN-GAP comment removed.
- `packages/chat/src/routes.ts` — `ChatRoutesDependencies` gains `adoptMcpTokenRevoke?`; `registerChatRoutes` calls it (only when `wiring` is non-null) with a closure over `wiring.tokens.revokeBySessionId`.
- `packages/module-registry/src/index.ts` — `BuiltInRouteDependencies` gains `adoptMcpTokenRevoke?`; forwarded into the chat module's `registerRoutes` call; `registerBuiltInApiRoutes` adds a `revokeMcpTokenBySessionId` late-bound ref + adopt setter; `onReady`'s `resolveChatEngineFactory({...})` call gains `onPersistentReap: (sessionKey) => revokeMcpTokenBySessionId?.(sessionKey)`.
- `tests/unit/chat-multiplexer-persistent-pool-settings.test.ts` — +2 tests: `onPersistentReap` forwards through; forwards as `undefined` when omitted.
- `tests/unit/module-registry-mcp-url.test.ts` — +1 test: chat module's `registerRoutes` forwards `adoptMcpTokenRevoke`.
- `tests/unit/chat-routes-mcp-token-revoke-adopt.test.ts` — new file, 2 tests: adopt seam fires and forwards to `SessionTokenRegistry.revokeBySessionId` (via `vi.spyOn(SessionTokenRegistry.prototype, ...)`) when `wiring` is present; never fires when no gateway is wired.

## Verification

- `npx tsc --noEmit -p .` from repo root: exit 0, no output.
- `npx vitest run` on the 4 directly-relevant test files: 4 files / 12 tests, all pass.
- Regression sweep: 37 non-DB `tests/unit/*` files touching `routes.ts`/`module-registry/index.ts`/`chat-multiplexer.ts` (found via `grep -rl`, DB-backed `tests/integration/*` deliberately excluded — those need the `verify-gate` skill's DB isolation, out of scope here): 37 files / 311 tests, all pass, no regressions.
- No TaskGet/TaskUpdate tools present in this session's toolset (same as relay-10 hit) — could not mark task #6 completed via tooling; recording completion here instead.

## Next: task #7 (NOT started — do not assume otherwise)

e2e-P2 per the plan (~lines 345-377): `tests/integration/persistent-pool-reap.test.ts` (new file, real pool + reap-triggers-revoke assertion, DB-backed — needs `verify-gate` skill discipline), plus a `test:persistent-pool` script in root `package.json`. Task #6 did not touch either.
