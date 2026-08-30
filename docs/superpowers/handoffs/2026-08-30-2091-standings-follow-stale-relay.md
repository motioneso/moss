# Relay — #2091 standings dropdown shows stale "followed" state

**Original handoff:** `docs/superpowers/handoffs/2026-08-30-2091-standings-follow-stale.md`
**Plan (approved by coordinator):** `docs/superpowers/plans/2026-08-30-2091-standings-follow-stale.md`
**Branch/worktree:** `2091-standings-follow-stale` (this worktree, unchanged)
**Coordinator:** agent name `coordinator` — re-resolve pane fresh, never trust a written `w1:p2B`
**Relay depth:** 1 (this is the only relay budgeted — if you also hit 70% with no PR open yet,
report to the coordinator for a re-slice instead of relaying again)

## Done (committed, on this branch)

Commit `c6db634b5`: `fix(sports): refresh standings overview cache on team follow/unfollow`
- `packages/sports/src/settings/index.tsx` — the shared `invalidateFollows` callback (used by both
  the follow and unfollow success handlers) now also invalidates `sportsQueryKeys.overview`, not
  just the follows list. This is the query the standings dropdown reads for "followed" state.
- New test `tests/unit/sports-settings-follow-invalidates-overview.test.tsx` — renders the real
  settings screen with `react-test-renderer`, clicks follow and unfollow, and checks that both the
  follows-list query and the overview query get invalidated each time. Written before the fix and
  confirmed red (only checked logically, not run — see next step), fix applied after.

## Not yet done — pick up here

1. **Run the new test and confirm it passes.** I wrote it but had not yet run it when the context
   warning fired.
   ```bash
   pnpm vitest run tests/unit/sports-settings-follow-invalidates-overview.test.tsx > /tmp/vt.log 2>&1; echo "EXIT=$?"
   ```
   If it fails, check first whether the failure is a real bug in the fix, or a mistake in my test
   fixture (I hand-wrote a small fetch router — double check the `stubFetch` helper's response
   shapes match `SportsFollowsResponse`/`SportsCatalogResponse` if something looks like a
   parse/shape error rather than an invalidation assertion failure).
   Also confirm I did not break the existing suite: `tests/unit/settings-sports-pane.test.tsx`.

2. **Pre-push trio + rebase**, per `coordinated-build`:
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck
   git fetch origin main && git rebase origin/main
   ```

3. **Full gate** — use the `verify-gate` skill, never pipe the command directly (default DB is
   live dev, per project CLAUDE.md).

4. **Live-path proof** (this is a UI fix, gate applies): on the live dev instance
   (`http://192.168.50.36:5173`, login `ben@ben.com` / `jarvistest123!`), follow a team, open the
   standings dropdown, confirm it shows followed; unfollow in Settings; return to standings without
   a tab-switch or wait and confirm it updates immediately. Screenshot or note as PR evidence.

5. **`coordinated-wrap-up`**: push, open PR, post the live-path proof as a PR comment, report the
   PR link + evidence to the coordinator. Then stop — merge/board/close are the coordinator's.

## Notes

- Scope is deliberately small: one file changed for the fix, matching an already-used pattern
  elsewhere in the same file (`StoryPreferencesSection`'s `refresh`, lines ~49-50 pre-fix) that
  already invalidates both a local key and `sportsQueryKeys.overview` together.
- The fix covers both directions (follow and unfollow) because they share one success-handler
  callback — the coordinator already signed off on that as in-scope, not scope creep.
- Plain-English rule for any status update or further handoff: no jargon, no backticked identifiers
  unless naming something Ben needs to act on directly. Pass this to any agent you spawn.
