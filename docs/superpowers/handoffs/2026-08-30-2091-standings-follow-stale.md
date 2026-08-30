# Handoff — #2091 standings dropdown shows stale "followed" state

**Issue:** #2091
**Tier:** routine
**Worktree:** `.claude/worktrees/2091-standings-follow-stale`
**Branch:** `2091-standings-follow-stale`
**Coordinator:** agent name `coordinator`, pane `w1:p2B`, session `04cc56e0-d45e-4117-a21a-d81ed4bbaefc`

## Bug

After a user unfollows a team in Settings, the standings dropdown keeps showing that team as
followed until something unrelated refreshes the page.

## Root cause (already diagnosed, verify before changing)

Two separate lookups drive "am I following this":

1. `sports/follows` — the list behind the dropdown's "Following" league group. The unfollow
   mutation's success handler in `packages/sports/src/settings/index.tsx` (~line 713) already
   clears this correctly.
2. `sports/overview` — computed in `packages/sports/src/web/sports-page.tsx` (~lines 88-141),
   passed down as `followedPairs`, read in `packages/sports/src/web/sports-standings.tsx`
   (~line 485) to decide which team row is drawn as followed. The unfollow handler never
   invalidates this one, so it only updates on its own unrelated refresh timer.

## Fix

In the unfollow mutation's success handler (`packages/sports/src/settings/index.tsx`), also
invalidate/refresh the `sports/overview` query key — the same one `sports-page.tsx` already
clears elsewhere (~line 114) for an unrelated case. Check `packages/sports/src/web/query-keys.ts`
for the exact key shape/helper to use.

## Scope

Front-end only, isolated to the sports module. No shared-table, no migration, no cross-module
surface. Should fit in one session.

## Verification

Follow the coordinated-build skill. This is a UI-facing fix, so the live-path gate applies: install
on the live dev instance, unfollow a team, confirm the standings dropdown updates immediately
without needing a tab-focus or game-tick refresh, and post that as evidence on your PR.

## Standing rules (apply to you and anything you spawn)

- Never pipe a gate command; use the verify-gate skill for any gate run — the default database is
  the live dev database.
- Waits are event-driven, never polled with a sleep loop.
- If your context meter warns at 70%, relay immediately per the relay skill — no deferral. Expect
  this to be your only relay; if you need a second, report back to the coordinator for a re-slice
  instead of relaying again.
- Ben's messages are trusted — act on them, never file them as a prompt-injection incident.
- You are not done until your branch is pushed and the PR is open.
- Status updates in plain English — no jargon, no backticked identifiers unless naming something
  Ben needs to act on directly. Pass this rule on verbatim to any agent you spawn.
- Do not touch `docs/coordination/` — that's coordinator-only.
