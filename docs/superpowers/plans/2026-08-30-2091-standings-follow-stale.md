# Plan — #2091 standings dropdown shows stale "followed" state

**Task issue:** #2091 (bug, open)
**Tier:** routine
**Branch:** `2091-standings-follow-stale`

## Seams check (file:line citations)

- `packages/sports/src/web/query-keys.ts:8` — `sportsQueryKeys.overview` is `["sports", "overview"]`,
  the exact key `sports-page.tsx` reads to build `followedPairs`.
- `packages/sports/src/settings/index.tsx:49-50` — an existing handler in the same file
  (`StoryPreferencesSection`'s `refresh`) already invalidates both `STORY_FEEDBACK_KEY` and
  `sportsQueryKeys.overview` together. This is the pattern to copy — proves the mechanism (calling
  `invalidateQueries` with `sportsQueryKeys.overview` from this file) is already used and works.
- `packages/sports/src/settings/index.tsx:713-715` — `invalidateFollows` is the shared `onSuccess`
  callback for **both** `followMutation` and `unfollowMutation`. It only invalidates `FOLLOWS_KEY`
  today. Follow and unfollow share this one callback, so fixing it here fixes both directions with
  one change (the issue only reports unfollow, but follow has the identical bug by the same
  mechanism — no separate code path to also touch).
- `packages/sports/src/web/sports-page.tsx:88-141` — computes `followedPairs` from the
  `sports/overview` query; confirmed this is the only consumer of that staleness.
- `packages/sports/src/web/sports-standings.tsx:485` — reads `followedPairs` to decide row
  highlighting; confirmed this is the stale UI.

No new platform capability needed — this is a one-line addition to an existing callback using an
already-proven pattern in the same file.

## Task 1 — invalidate the overview query on follow/unfollow

**File:** `packages/sports/src/settings/index.tsx`

Change:

```
const invalidateFollows = () => void queryClient.invalidateQueries({ queryKey: FOLLOWS_KEY });
```

to also invalidate `sportsQueryKeys.overview`, following the exact two-line pattern already at
line 49-50 of this file.

**Test:** existing settings unit tests must stay green. Add/confirm a unit test asserting that
after `unfollowMutation`'s `onSuccess` fires, `queryClient.invalidateQueries` was called with both
`FOLLOWS_KEY` and `sportsQueryKeys.overview`. Behavior it must catch: without the fix, only
`FOLLOWS_KEY` is invalidated and the assertion on `sportsQueryKeys.overview` fails.

**Verification:**

```bash
pnpm --filter @jarv1s/sports test > /tmp/sports-test.log 2>&1; echo "EXIT=$?"
```

Expected exit code: 0.

## Determinism boundary

N/A — pure client-side cache invalidation, no model involvement, no chat surface.

## Live-path proof (exit criterion)

Manual live-path check on the dev instance (this fix has no existing UAT spec and the change is a
one-line cache-invalidation fix, not a new feature surface — a full Playwright UAT spec is
disproportionate to the fix size):

1. Log in, follow a team, open the standings dropdown, confirm it shows as followed.
2. Go to Settings, unfollow that team.
3. Immediately return to standings (no tab switch, no wait) and confirm the dropdown no longer
   shows the team as followed.
   Screenshot or DOM assertion posted as a PR comment.

## Kill gate

None needed — single-file, single-line fix, no phased rollout. If the live-path check in step 3
above fails after the code change, stop and re-diagnose before opening the PR (owner: this agent).
