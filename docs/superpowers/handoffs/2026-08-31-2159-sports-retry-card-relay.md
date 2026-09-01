# Relay: issue 2159 tool readiness fix

Branch/worktree: `fix/2159-sports-retry-card`, this worktree (do not switch branch, do not rebase).
Coordinator: agent name `coordinator`, pane label "Coordinator" (currently `w1:p5R`, resolve fresh).
Plan approved on GitHub issue 2159, comment thread (posted plan comment, approved by coordinator
message quoting "Plan approved. Implement exactly the posted issue 2159 plan...").

## What's done

Checkpoint commit `697679a56` on this branch — "fix(chat): gate session readiness on first MCP
tools/list (#2159)", 7 files, 199 insertions / 2 deletions. Verified with `git show --name-only HEAD`
to contain exactly:

- `packages/ai/src/gateway/session-tokens.ts` — added `toolsListObserved` flag + waiter list to
  `TokenEntry`, `markToolsListObserved()` and `waitForToolsListObserved()` methods (10s bounded
  timeout, fail-open to `false`).
- `packages/chat/src/mcp-transport.ts` — calls `deps.tokens.markToolsListObserved(token)` in the
  `tools/list` handler success path, right before the reply.
- `packages/chat/src/live/chat-session-manager.ts` — new optional dep
  `waitForToolsListReady?: (token: string) => Promise<boolean>`; `launchSession` awaits it right
  after `engine.launch()`, before the session becomes visible.
- `packages/chat/src/live/runtime.ts` — extended `mcpTokenLifecycle?` type with `waitForReady?`,
  wired to `waitForToolsListReady` in the manager deps.
- `packages/chat/src/routes.ts` — wired `waitForReady: (token) => wiring.tokens.waitForToolsListObserved(token)`
  into the `mcpTokenLifecycle` object.
- `tests/unit/session-tokens-tools-list-ready.test.ts` — new file, 5 unit tests on the registry
  primitive directly (immediate-true, wait-then-resolve, timeout-false, unknown-token-false,
  idempotent mark).
- `tests/unit/chat-session-manager.test.ts` — new describe block
  `"ChatSessionManager tools/list readiness gate (#2159)"`, 2 tests: manager blocks
  `ensureSession` on an unresolved gate promise and resolves once released; manager proceeds with
  no gate call when no token was minted.

No other files touched. `5feed887e` and all prior commits preserved untouched, no rebase.

## What's left (next concrete steps)

1. Run focused unit tests only (do NOT run `pnpm verify:foundation` or any DB-touching command
   without the `verify-gate` skill):
   - `pnpm vitest run tests/unit/session-tokens-tools-list-ready.test.ts`
   - `pnpm vitest run tests/unit/chat-session-manager.test.ts`
   - `pnpm vitest run tests/unit/mcp-transport.test.ts` if it exists and touches `tools/list`
   - `pnpm typecheck` scoped to touched packages if a targeted script exists, else full `pnpm typecheck`
2. Fix anything red from those specific tests only — do not expand scope.
3. Report to the coordinator (agent name `coordinator`; use `herdr-pane-message` skill, resolve
   pane fresh from `herdr pane list` — do not reuse `w1:p5R` blindly, confirm session id
   `01a05a44-8aea-7730-919b-8be693151e2d` still matches): commit SHA `697679a56`, the file list
   above, and exact test output (pass/fail counts) for the commands run in step 1.

## Still-binding constraints

- Do NOT rebase, push, open a pull request, start a live model or browser, or run UAT.
- Do NOT touch `docs/coordination` or run broad formatting.
- Preserve commit `5feed887e` and all history — no rebase, no history rewrite.
- Avoid PR 2158 collision files: `gateway.ts`, `confirmation-registry.ts`, chat transport tests
  beyond what's listed above, owner-scope tests.
- Never use the default live development database.
- This worktree is shared — never `git add -A`/bare `git commit`; follow the `shared-checkout`
  skill for any further commits (explicit paths, diff-review co-edited files, verify
  `git show --name-only HEAD` after).
- Relay depth budget is ONE for build lanes (this is relay 1). If the successor also hits the
  relay trigger with no PR open yet, it must NOT relay again — report to the coordinator that the
  slice needs re-scoping instead.

Plain English for status reports to the coordinator: no jargon, name exact files/commits/commands,
not internal shorthand.
