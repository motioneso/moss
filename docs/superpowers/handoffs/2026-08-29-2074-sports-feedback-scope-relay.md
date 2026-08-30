# Handoff: issue #2074 - hide feedback control on the sports Followed strip

Issue: https://github.com/motioneso/moss/issues/2074
PR (open): https://github.com/motioneso/moss/pull/2076
Branch/worktree: `2074-sports-feedback-scope`, this worktree, already checked out here. Do NOT
run `pnpm install` again, `node_modules` is already there.
Coordinator: pane label "Coordinator", session id `bbf6d963-50cd-4184-b079-94d155708085`
(resolve fresh with `herdr pane list` — pane numbers reflow, session id is the only stable id).
Sign every message to it with your own pane id.

## What's done

- Code change committed (`a6992c876`) and pushed. In
  `packages/sports/src/web/sports-ticker.tsx`, the two `StoryFeedbackMenu` call sites inside
  `FeaturedTeamCard` (the ones that render the "More like this / Less like this" control) are now
  wrapped in `{surface !== "sports" ? (...) : null}`. Nothing else in the file changed - confirmed
  by reading the full diff before committing.
- PR #2076 opened against main with release note filled in.
- Typecheck for the sports package is clean (no errors in the changed file).
- No existing tests reference `sports-ticker.tsx` or `story-feedback-menu.tsx` - nothing to
  update there.
- Full local gate is running in the background via `scripts/run-gate.sh` (started, not hand
  rolled). Log: `/tmp/jarv1s-gate/2074_sports_feedback_scope-20260829-225632.log`. Check it with
  `scripts/run-gate.sh wait --follow` in a backgrounded Bash call - read the exit code that call
  returns (0 green, 1 failed, 2 died), never trust the log text alone.
- Dev servers for the live check are already running FROM THIS WORKTREE (so the branch's code,
  not main, is what's being tested):
  - API: `pnpm dev:api`, PID 1222650, log `/tmp/dev-api-2074.log`, confirmed answering on
    `localhost:3000/health`.
  - Web: `pnpm dev:web`, PID 1222940, log `/tmp/dev-web-2074.log`, confirmed answering on
    `localhost:5173` and reachable on the LAN at `http://192.168.50.36:5173`.
  - Remember to stop both by these exact PIDs when done - never kill by name pattern, prod's own
    worker process looks the same in `ps`.
- Test account `ben@ben.com` / `jarvistest123!` had no followed teams, so the Followed strip on
  `/sports` was empty (just a "Follow your teams" prompt) and nothing could be visually checked.
  Fixed by following the Los Angeles Lakers through Settings > Modules > Sports > the "Find a team
  or league..." search box > click the "Follow Los Angeles Lakers" result. That team is now
  followed for this account on the shared dev database, so the Followed strip should render on
  `/sports`.
- A working Playwright script that logs in and can screenshot both pages already exists at
  `verify-2074.mjs` in this worktree's root (repo root, not /tmp - Node module resolution for
  `@playwright/test` only works from inside the repo). Companion scratch files `debug-2074.mjs`
  and `screenshot-now.mjs` are also there; delete all three before finishing, they're not part of
  the PR.

## What's left

1. Run `node verify-2074.mjs` (or extend it) to actually confirm: no "More like this / Less like
   this" control anywhere inside the Followed strip on `/sports` (the section with
   `aria-label="Followed"`, class `sp-ticker`), and the same control still appears on `/today`'s
   equivalent team-card widget. The control's outer wrapper class is `sp-feedback` (see
   `packages/sports/src/web/story-feedback-menu.tsx` line 80) - checking for that div's presence
   inside the Followed section's HTML is a more reliable signal than searching for the visible
   text, since the text only appears after opening the control's own dropdown.
2. Take clean screenshots of both pages as evidence (screenshots already produced during
   investigation are in /tmp and can be reused/regenerated: `/tmp/2074-sports.png`,
   `/tmp/2074-today.png`).
3. Confirm the gate's actual exit code (background `scripts/run-gate.sh wait --follow` call).
4. Post the live-path proof comment on PR #2076 with the gate result and what was visually
   confirmed (path exercised: login as ben@ben.com, followed the Lakers, checked /sports Followed
   strip has no control, checked /today's team card still has it).
5. Tear down: stop the two dev-server PIDs above, delete the three scratch `.mjs` files at the
   worktree root (`git status` should already show them as untracked, don't commit them), and
   optionally unfollow the Lakers again if a clean test account matters for the next person
   (probably fine to leave followed - it's a real "follow" action a real user could take, not
   destructive test data).
6. Report done to the coordinator via `herdr agent prompt` / `herdr-pane-message`, terse and
   result-first, per `coordinated-wrap-up`. Do not touch the board, merge, or close the issue -
   that's the coordinator's job after its own QA pass.

## Standing rules (carry forward verbatim to anyone else you spawn)

Plain English only in every status update and spawn prompt, to Ben or the coordinator - no jargon,
no coined shorthand, name what a thing does rather than its identifier unless the exact identifier
is something the reader must act on. `pnpm install` first (already done, skip it here). Never pipe
a gate command. The default database is the live dev DB, be careful with it. Waits are
event-driven, never polled. Never touch `docs/coordination/`. If the context meter warns at 70%,
relay once - a second relay on this same slice means it was mis-scoped, report back for a re-slice
instead of relaying again (this is that first relay). Sign every message to the coordinator with
your own pane id.
