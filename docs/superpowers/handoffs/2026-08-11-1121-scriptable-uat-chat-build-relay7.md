# #1121 scriptable UAT chat — relay7 handoff

Tasks 5 and 6 are DONE and committed. Nothing else was touched.

## Commits (both green, both pushed to local branch only — not yet pushed to origin)

- `61b0a6e4e` — Task 5: `seedScriptedChatProviderChunk` (`tests/uat/seed/chunks/chat-script.ts`)
  + wiring (`cli.ts`, `level-validation.ts`/`.test.ts`, `levels.ts`, `levels.test.ts`) +
  `chunks/chat-script.test.ts`. Verified: `pnpm vitest run tests/uat/seed` (fresh
  `jarvis_gate_1121t5`, dropped+recreated+migrated) → **29/29 passed, rc=0**. Gate DB has been
  dropped after verification.
- `90ca495c4` — Task 6: `packages/chat/src/live/engine-selection.test.ts` (2 tests) + a one-line
  `vitest.config.ts` include addition (`"packages/chat/src/live/*.test.ts"` — needed because root
  vitest only globs `tests/**`, `spikes/**`, and two `__tests__` package exceptions; this
  co-located file wasn't covered without it). Verified:
  `pnpm vitest run packages/chat/src/live/engine-selection.test.ts` → **2/2 passed, rc=0**.
  `pnpm --filter @moss/chat typecheck` (i.e. `cd packages/chat && pnpm typecheck`) → clean.

## The one real bug fixed this relay (worth knowing, not re-deriving)

`resolveDefaultProviderId` (`packages/ai/src/repository.ts:816`) only auto-resolves a default
chat provider when the admin owns **exactly one** active assistant-purpose provider. Earlier
`it()` blocks in `levels.test.ts` (admin+data, multi-user) already seed one provider for the
fixed `UAT_ADMIN_ID` in the same shared, un-reset gate DB, so by the time the new "solo-admin with
chatScript" test ran, the admin owned 2+ providers and resolution silently returned `null`.

Tried `repo.setInstanceDefaultProvider(...)` in the seed chunk first — fixed that test but broke
`tests/uat/seed/chunks/ai.test.ts`'s pre-existing "#1121 red check" (expects `null` with no chat
script), because `is_instance_default` is a DB-wide flag that leaks across every file/test sharing
that gate DB. **Reverted that approach.** Final fix is test-local only: the new "with chatScript"
test disables (`status: "disabled"`) any pre-existing assistant providers for the admin, inside its
own `it()`, before calling `seedLevel`, using a properly `withDataContext`-scoped update (NOT
`createMigrationOwnerDb()` — that connection has no actor context and RLS silently filters it to
zero rows/no-ops on owner-scoped tables like `app.ai_provider_configs`). No production seed code
changed for this part. Full suite (`tests/uat/seed`, 29 tests across 12 files) passes clean with
this fix.

## Remaining steps (per the original task brief — unchanged)

1. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck` (repo root).
2. `git fetch origin main && git rebase origin/main`.
3. Full gate via the `verify-gate` skill: fresh gate DB, `export JARVIS_PGDATABASE=...`,
   `pnpm verify:foundation`, expect `rc=0` (log-to-file-with-sentinel, never piped).
4. `coordinated-wrap-up`: push, open/update PR, live-path proof or honest
   **"code-complete, unverified"** (Task 5/6 don't touch a UI surface directly — this phase's exit
   criteria are the vitest/tsc/eslint/verify:foundation gates, not a browser walkthrough).
5. Message the `Coordinator` label pane — **re-resolve fresh via `herdr pane list`, do not reuse
   `w1:p7P`** (pane ids reflow) — tagging tier `sensitive`.
6. Never touch `docs/coordination/`, no repo-wide `pnpm format`, no broad `git add`, never move the
   board/close the issue/merge.

None of steps 1-6 have been started yet. Worktree is clean (`git status` — nothing pending) other
than these two commits sitting on `build/1121-scriptable-chat`, not yet pushed to origin.
