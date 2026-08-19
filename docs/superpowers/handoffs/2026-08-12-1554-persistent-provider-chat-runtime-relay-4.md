# Continuation: #1554 persistent-provider-chat-runtime (relay #4)

Branch/worktree: 1554-persistent-provider-chat-runtime (this worktree). Clean tree, nothing
committed. Relay #3 (same dir) has full research context; this doc only adds what changed.

## State: plan written, sent for approval, WAITING

Phase 2 plan-build doc is **finished and written**:
`docs/superpowers/plans/2026-08-12-1554-phase2-persistent-pool.md`. Covers: pool admission
architecture (intercepts only at session-construction, not per-turn — confirmed via
chat-session-manager.ts read), the RpcPush `"sessionReaped"` channel extension that resolves the
cross-process MCP-token-revoke-on-reap question flagged in relay #3 (decision made: extend the
existing push envelope in `rpc-contract.ts`, cite exact lines in the plan doc itself), idle-reap
timer ownership, settings registry entries + bounds validation, e2e-P2 spec, kill gate, rulings
ledger. **This plan doc is authoritative — do not re-derive any of it, read the doc directly.**

**Coordinator re-resolved fresh via `herdr pane list` this session** (relay #2's `coord-relay9` /
session `0bb9f516-...` address was confirmed dead, per relay #2). Current live coordinator:
**`coord-overnight-20260810-e7 [19fedb]`** (from `ListAgents`, cwd
`.claude/worktrees/coord-overnight-20260810`, status "busy" at send time). Sent the plan for
approval via `SendMessage` — msg_id `de4a1461-d5ec-444f-b6c3-bd104bbafe33`, succeeded.

**Waiting on their reply. Do not start building until it arrives. Do not re-ping.** A
`ScheduleWakeup` was set for ~25 min after send to check; if this doc is being read because that
fired (or because of a fresh session start), first action is: check for a reply from
`coord-overnight-20260810-e7` (re-resolve via `herdr pane list`/`ListAgents` again if that name no
longer resolves — coordinators rotate across relays, this is expected, don't treat it as an
error). If approved, proceed straight to building (below). If not yet replied, re-schedule a wait
and do not touch code.

## Next steps once approved (in order, unchanged from relay #3 except plan is now done)

1. TDD-build Phase 2 task-by-task per the finished plan doc's Decisions 1-4, committing per task
   (`Co-Authored-By: Claude` trailer, explicit scoped `git add`, never `-A`/`.`).
2. Check lane #1256 collision (worktree `.claude/worktrees/1256-confirmation-registry-bypass`,
   touches `packages/chat/src/routes.ts` and `packages/module-registry/src/index.ts`) before
   editing those files.
3. Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`.
4. `coordinated-wrap-up`: `verify-gate` skill for the full gate, push, open PR, live-path proof
   comment (user-facing feature per CLAUDE.md), report PR + evidence to
   `coord-overnight-20260810-e7` (re-resolve fresh if stale). Never merge/close issues/touch
   board.
5. Relay again on the next 70% context-meter warning or compaction summary.

## If the coordinator's reply raises objections

Revise the plan doc in place (don't create a relay-5-only patch doc), re-send for approval, keep
waiting. Do not build against an un-approved revision.

## Collision note + bans (still binding, unchanged)

Lane #1256 collision above. Worktree/branch-scoped git only. Explicit-path `git add` only. Never
touch `docs/coordination/`, the project board, milestones, or merge. No secrets anywhere.
