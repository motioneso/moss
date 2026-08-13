# Continuation: #1554 persistent-provider-chat-runtime (relay #6)

Branch/worktree: 1554-persistent-provider-chat-runtime. Clean tree, all committed
(`7f8b0b916`, `dcbe994eb`, `3e500d96b`, `b2e757a73`). Plan is Fable-APPROVED, coordinator
confirmed no objection (user relayed: "Confirmed... No objection, core design unchanged.
Proceed to build."). **Build is in progress — this is a mid-build checkpoint, not a waiting
state.**

**IMPORTANT — the root gate command matters, not per-package tsconfigs:** Decision 1's original
typecheck pass (`npx tsc --noEmit -p packages/chat`) came back clean but was WRONG — that command
doesn't load the root `tsconfig.json` (which has `noUncheckedIndexedAccess: true`, the actual
`pnpm typecheck` gate config, since `packages/chat` has no tsconfig of its own). Running
`npx tsc --noEmit -p .` (root) caught 5 real errors in Decision 1's code, now fixed in `3e500d96b`.
**Always typecheck with `npx tsc --noEmit -p .` (root, unpiped, check EXIT=$?), never `-p
packages/<name>` unless that package has its own `tsconfig.json`** (most don't — check first with
`find packages -maxdepth 2 -iname tsconfig*`).

## Source of truth

`docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md` — read it directly, do not
re-derive. Both Fable rounds recorded in its "Rulings ledger" section. No further review needed.

## Build progress (task list — recreate with TaskCreate if starting fresh, or just follow this)

1. **DONE** — Decision 1: `packages/chat/src/live/persistent-runtime-pool.ts` +
   `persistent-runtime-pool.test.ts`. 6 tests passing (`npx vitest run
   packages/chat/src/live/persistent-runtime-pool.test.ts` → EXIT=0). Typechecks clean.
   Committed `7f8b0b916`.
   - **One resolved ambiguity, not a design change:** the plan's stated `admit(sessionKey: string)`
     signature omits an `opts` param, but `PersistentRuntimePoolDeps.createRuntime` requires
     `(sessionKey, opts: EngineLaunchOpts)`. Resolved by adding `opts: EngineLaunchOpts` as
     `admit`'s second parameter — mechanically necessary (the pool has no other source for a
     session's launch opts; `EngineLaunchOpts` fields like `mcpToken` are minted per-session by
     the caller, not derivable pool-side). All other signatures/behavior exactly as the plan
     states. If this surfaces in a later review, point to this note.
2. **DONE** — Decision 4 (settings registry): `minValue?`/`maxValue?` added to
   `RuntimeConfigKeyEntry`, two new entries (`chat.persistent_pool_cap` default "4" minValue 1;
   `chat.persistent_idle_reap_minutes` default "30" minValue 1), bounds check added to
   `validateRuntimeValue()`. All 3 plan test cases (lines 256-260) implemented in
   `tests/unit/runtime-config-routes.test.ts`, plus a `resolveInt` case in
   `runtime-config-resolver.test.ts` and a registry-shape case in
   `runtime-config-registry.test.ts` (which needed its pre-existing `toHaveLength(3)` bumped to
   `5` — a real registry it already asserted the exact count of). 26/26 tests passing, root
   typecheck clean. Committed `b2e757a73`.
3. **NOT STARTED** — Decision 2 (RpcPush `sessionReaped` channel + `handleRemoteReap`). Plan
   lines 130-208, 4 test cases. Biggest remaining task — touches `rpc-contract.ts`,
   `engine-host.ts`, `chat-engine-rpc-client.ts` (push handling currently only handles
   `frame.t === "ok"` at line 643 — not yet re-verified this session, re-grep), plus new
   `ChatSessionManager.handleRemoteReap(sessionKey, reason)` (sibling to
   `reconcileLiveSessions` at `chat-session-manager.ts:814`), plus `runtime.ts`'s in-process
   direct-callback path.
4. **NOT STARTED** — Decision 3 (idle-reap timer ownership, composition-root-owned, live-reads
   the settings key per tick). Plan lines 210-228, 3 test cases. Depends on Decision 4's settings
   key existing and Decision 2's timer needing somewhere to call `pool.sweepIdle()`.
5. **NOT STARTED** — Wire pool into `engine-selection.ts:76-92` (single fork), lift
   `persistentRuntimeEnabled: false` pin in `engine-host.ts:~252`, `runtime.ts`'s
   `createRealEngineFactory()` (~117-146).
6. **NOT STARTED** — `routes.ts` wiring. **Read plan's "Finding B" section first** — binding
   5-step conflict protocol with lane #1256 (touches the same region, confirmed via sibling
   worktree diff in a prior session — re-check #1256's merge state fresh, don't trust that
   finding's staleness). Pool constructed alongside `tokens = new SessionTokenRegistry()`
   (`:217`), threaded into `createChatSessionRuntime` near `mcpTokenLifecycle`
   (`:272-299`). Any commit touching `routes.ts` goes through `shared-checkout` skill (already
   invoked once this session, know the drill: explicit paths, diff-and-verify co-edited files,
   never `-A`/bare commit).
7. **NOT STARTED** — e2e-P2: `tests/integration/persistent-pool-reap.test.ts` (plan lines
   345-377, 3 steps) + `test:persistent-pool` root package.json script. Note: unlike
   Decision 1-4's unit tests (which live in `packages/chat/src/live/*.test.ts`, run via
   `npx vitest run <path>` directly — confirmed this session that's how `engine-selection.test.ts`
   is exercised, NOT via `pnpm test:unit` which defaults to filtering to `tests/unit` only and
   would miss it), e2e-P2 is a root-level integration test with its own isolated test DB per
   `scripts/test-integration.ts`.
8. **NOT STARTED** — Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`), rebase
   onto `origin/main`, `verify-gate` skill, push, PR (state explicitly: no UI surface, no
   live-path Playwright proof applicable — plan's own "Determinism boundary"/"Finding A"
   sections say so), report to coordinator (`coord-overnight-20260810-e7` — re-resolve fresh via
   `ListAgents`/`herdr pane list` if stale). Never merge/close issues/touch board.

## Commit convention in use

Explicit-path `git commit <paths> -m "..."` per task (never `-A`/`.`/bare), `Co-Authored-By:
Claude Sonnet 5 <noreply@anthropic.com>` trailer, `Part of #1554` in the body.

## Bans (still binding)

Worktree/branch-scoped git only. Never touch `docs/coordination/`, the project board,
milestones, or merge. No secrets anywhere.

## Next action

Pick up at task 3 (Decision 2 — `RpcPush` `sessionReaped` channel + `handleRemoteReap`). This is
the biggest remaining task. Read plan lines 130-208 directly (do not re-derive), then TDD it the
same way Decisions 1 and 4 were done: write tests first against the stated contracts, implement,
run tests, typecheck with `npx tsc --noEmit -p .` (root — see the note above), commit. Re-grep
`chat-engine-rpc-client.ts`'s push-handling switch (was at `frame.t === "ok"` around line 643 as
of relay-5, not re-verified since) before assuming its current shape.
