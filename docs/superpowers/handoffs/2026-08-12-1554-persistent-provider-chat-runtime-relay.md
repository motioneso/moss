# Continuation: #1554 persistent-provider-chat-runtime

Branch/worktree: 1554-persistent-provider-chat-runtime (this worktree). No uncommitted changes — pure investigation session, nothing to commit.

## Key finding (already escalated to coordinator, awaiting reply)
This spec was already built in phases under now-closed task issue #1557 ("Part of #1554").
- Phase 1 MERGED to origin/main via PR #1561 (adjudicated REVISE, fixed). Present on this branch:
  - `packages/chat/src/live/provider-runtime.ts` — neutral ProviderChatRuntime contract
  - `packages/chat/src/live/persistent-runtime-engine.ts` — CliChatEngine adapter wrapper
  - `packages/chat/src/live/claude-persistent-runtime.ts` — Claude adapter (piped-stdio spawn)
  - `packages/chat/src/live/persistent-stream-decoder.ts` — bounded incremental line decoder
  - `packages/settings/src/instance-settings-keys.ts:24` — `chat.persistent_runtime.enabled` present
- Approved phased plan already exists and covers the rest: `docs/superpowers/plans/2026-08-10-1557-persistent-provider-chat-runtime.md`
  - Phase 2 (pool/LRU eviction/idle-reap/admin settings) — NOT built. Confirmed: `chat.persistent_pool_cap` / `chat.persistent_idle_reap_minutes` absent from `packages/settings/src/runtime-config-keys.ts`; no cross-child pool/LRU logic exists (only single-child `reap()` in claude-persistent-runtime.ts:177).
  - Phase 3 (crash recovery + cancel-resolves-approvals) — NOT built.
  - Phase 4 (rollout instrumentation/drain/canary) — NOT built.
  - Phase 5 (post-stability cleanup) — explicitly out of scope now.

## Escalation sent
Sent to Coordinator pane (agent_session 0bb9f516-c026-454f-bc97-dc9faf43bd20, name "coord-relay9", re-resolve pane fresh via `herdr pane list` — do not reuse `w1:p7P`, it's ephemeral) proposing: continue the existing Phase 2-5 plan under #1554 (since #1557 is closed) rather than authoring a fresh plan-build. Message was delivered (coordinator was busy "Moonwalking" — queued). **Reply not yet received as of this handoff.**

## Next steps for successor
1. Check for the coordinator's reply first (message may arrive async — check inbox / re-read pane, or just proceed if reply confirms the re-scope).
2. Per `coordinated-build` step ½: re-run the seams check for Phase 2 specifically — the 2026-08-10 plan's seams table (`engine-host.ts:162-181`, `engine-selection.ts` fork, settings registries) is 2 days stale; re-grep current line numbers before trusting it.
3. Still-open question from the plan (P1.0): confirm which session-identity posture actually shipped in `claude-persistent-runtime.ts` — `--no-session-persistence` flag vs. fallback fresh-`--session-id`-per-launch-plus-purge. This affects whether Phase 2/3 pool-eviction/reap logic must also trigger purge-on-every-termination-path. Read the file directly (352 lines) to confirm — not yet inspected this session.
4. Invoke `plan-build` for Phase 2 only (not a full re-plan), incorporating the seams-check refresh.
5. Message coordinator with the Phase-2 plan for approval; STOP for approval before writing code.
6. TDD-build Phase 2 task-by-task, committing per task (`Co-Authored-By: Claude` trailer, scoped `git add`).
7. Continue to Phase 3/4 as time/context permits, each needing its own live-dev e2e evidence per the plan.
8. Pre-push trio before any push: `pnpm format:check && pnpm lint && pnpm typecheck` + `git fetch origin main && git rebase origin/main`.
9. Close out via `coordinated-wrap-up` — own gate via `verify-gate` skill, PR, live-path proof comment, report to coordinator. Never merge/close issues/touch board.

## Collision note (from original handoff, still binding)
Lane #1256 (worktree `.claude/worktrees/1256-confirmation-registry-bypass`) touches `packages/chat/src/routes.ts` and `packages/module-registry/src/index.ts`. Check for conflicts before editing those files; rebase onto origin/main before opening a PR.

## Bans (still binding)
Worktree/branch-scoped git only. Explicit-path `git add` only (never `-A`/`.`). Never touch `docs/coordination/`, the project board, milestones, or merge. No secrets anywhere.
