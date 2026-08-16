# Relay — #1038 chat privacy/history two-user isolation test

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md` (#1038 row)
**Plan:** `docs/superpowers/plans/2026-08-16-1038-chat-privacy-history-leak-test.md`
**Issue:** #1038 (Part of #984)
**Branch/worktree:** `1038-chat-privacy-leak-test` @ `/home/ben/Jarv1s/.claude/worktrees/1038-chat-privacy-leak-test`
**Coordinator:** `coordinator-take25` (herdr label/name), relay status message already sent.

## Done

- Plan approved by coordinator.
- New test file `tests/integration/chat-privacy-history-leak.test.ts` (164 lines, 3 tests) written
  and committed as `eeaaddbdc` (on top of `bcb3c2765`), via explicit `git add <path>` — no other
  files staged.
- Targeted run green: 3/3 pass (`pnpm vitest run tests/integration/chat-privacy-history-leak.test.ts`).
- **Load-bearing verification done:** temporarily removed the app-level ownership check in
  `packages/chat/src/routes.ts` (messages route, the `if (thread?.owner_user_id !== access.actorUserId)
  return null;` line) as an uncommitted scratch edit. Test suite **stayed green (3/3)** — RLS on the
  request-scoped connection independently blocks the cross-actor read even with that app check gone.
  Edit fully reverted; confirmed via `git diff --stat packages/chat/src/routes.ts` (no diff).
  **Conclusion, corrected 2026-08-16 per QA (PR #1643 review):** this holds only for the *unshared*
  case exercised by the test fixture (no `app.shares` row). `chat_threads_select` /
  `chat_messages_select` RLS is **owner-OR-share** (`app.has_share('chat_thread', id, 'view')`), but
  the app-level check at `routes.ts:464` is **owner-strict**. For a view-shared thread, RLS alone
  would permit the share-grantee to read the thread's messages — the app check is the **sole guard**
  currently blocking that (not a redundant backstop), because it enforces a narrower rule than RLS
  does. Not exploitable today (zero production callers of `shares-repository.ts`), but the app check
  is **load-bearing for the share case** and must not be removed as "RLS already covers it."
- Pre-push trio green: `pnpm format:check`, `pnpm lint`, `pnpm typecheck` all `rc=0`.
- Scratch gate DB `jarvis_gate_1038` created, used, and **already dropped**.
- `git status --short` clean except the one committed test file (verified before commit).

## Not yet done (successor picks up here)

1. **Full isolated gate**: create a fresh gate DB (new name, e.g. `jarvis_gate_1038b`; the prior one
   was dropped), `export JARVIS_PGDATABASE=...`, run `pnpm verify:foundation` unpiped per the
   `verify-gate` skill recipe, confirm `rc=0`. Drop the gate DB when done.
2. **Rebase**: `git fetch origin main && git rebase origin/main` (branch was current as of
   `bcb3c2765` at start; re-check for drift).
3. **Pre-push trio** re-run after rebase if any conflict resolution touched files.
4. **Push + open PR** (`gh pr create`). PR body must state explicitly: **internal-only test change,
   no live-path proof needed** (per exit criteria — tests-only lane), and should include the manual
   verification finding above (RLS enforces isolation independently of the app-level check).
5. **Report to coordinator** per `coordinated-wrap-up` — PR link + verified evidence — then stop.
   Coordinator owns QA, merge, board, close.

## Guardrails still in force

Work ONLY in this worktree/branch; `git add` by explicit path only; never touch
`docs/coordination/`, the project board, milestones, or merge; no secrets anywhere; test file name
must stay distinct from #1037's lane (already is); do not touch `tests/integration/test-database.ts`.
