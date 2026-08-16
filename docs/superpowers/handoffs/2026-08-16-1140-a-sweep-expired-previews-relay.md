# Relay — 1140-A sweep expired news previews

**Issue:** #1523. **Spec:** `docs/superpowers/specs/2026-08-10-1140-backend-low-followups.md` §
"1140-A" (lines 71-99) — read only that section. **Plan (coordinator-approved):**
`docs/superpowers/plans/2026-08-16-1140-a-sweep-expired-previews.md`.
**Worktree/branch:** `.claude/worktrees/1140-a-sweep-expired-previews`, branch
`1140-a-sweep-expired-previews`. `node_modules` already installed — skip `pnpm install`.
**Coordinator label:** `Coordinator` — verify with `herdr pane list` before messaging (session id
changes across coordinator relays; re-resolve fresh, don't trust an id written here).

## Done

- Plan written and approved by coordinator.
- Commit `509e6145c`: added 2 new tests to `tests/unit/news-preview-store.test.ts`
  (cross-owner sweep, exact-ttlMs boundary).
- **Resolved finding, no longer open:** ran those 2 tests against the *unmodified* production code
  first (proper TDD RED check) — both passed vacuously. Proved (and escalated) that this specific
  acceptance criterion isn't black-box observable via `put()`/`take()` alone: `take()` already
  self-heals on any expired read regardless of sweep, and cap eviction is strictly oldest-first so
  it already flushes an owner's own garbage on their own next put. Coordinator decided **(a)**:
  keep these tests as contract/regression documentation, do NOT add a test-only introspection
  accessor. This is settled — do not re-litigate or re-escalate it.

## Next steps (in order)

1. Implement the locked sweep contract in `packages/news/src/discovery/preview-store.ts`, at the
   top of `put()`, before the existing per-owner cap block:
   ```
   const nowTs = now();
   for (const [id, value] of entries) {
     if (nowTs - value.createdAt > ttlMs) entries.delete(id);
   }
   ```
   (Exact contract from spec: single `now()` read, global sweep, `age > ttlMs` strict — matches
   `take()`'s existing inclusive `<= ttlMs` validity.)
2. Run `pnpm vitest run tests/unit/news-preview-store.test.ts > /tmp/1140a-vitest.log 2>&1; echo "EXIT=$?"` — expect `EXIT=0`, 4 tests passing. All 4 (2 old + 2 new) should stay green; this is
   confirming no regression, not a RED→GREEN transition (see "Resolved finding" above).
3. Commit as a `feat(#1523): ...` commit, `git add` by explicit path only.
4. Run the pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck`), fresh
   `git fetch origin main && git rebase origin/main`.
5. Invoke `coordinated-wrap-up`: full gate on isolated gate DB (`verify-gate` skill — never
   improvise), push, open PR against #1523.
6. This is backend-only, no UI/user-facing surface (cron-adjacent preview-store internals) — per
   CLAUDE.md's release-note rule, say so explicitly in the PR body instead of skipping the
   live-path gate silently. No UAT spec needed.
7. Report PR + gate evidence to the coordinator. Do not merge, touch the board, or close the issue
   — coordinator's job.

## Collision notes (unchanged from original handoff)

Sibling 1140-B is sensitive-migration tier, 1140-F is security tier — neither in this wave. If a
migration file appears unexpectedly in this worktree, stop and check with the coordinator.
