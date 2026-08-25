# State note — issue #1949 (Workshop page part 2)

This replaces the earlier relay note in this file. Do not follow older versions.

**Where things stand:** all four Phase 1 tasks from the committed plan
(`docs/superpowers/plans/2026-08-25-workshop-live-build-1949.md`) are built, unit-tested,
typechecked, and committed on this branch:

- Task 1.1 persist written files — commit `da4130039`
- Task 1.2 navigate to Workshop on approval — commit `97a4bafd8`
- Task 1.3 poll the build list while a build is running — commit `a4395ff5c`
- Task 1.4 notify the owner when a build finishes or fails — commit `b0a74a443`

A pull request should now be open for this branch (check with `gh pr view` on branch
`fleet/lane-1949` if this note is stale) — if not, the push/PR step did not finish; do that
first before anything else.

**What is NOT done:** the Phase 1 live proof. Plan text (search the plan doc for "Phase 1 e2e
test") describes extending `tests/live/workshop-1888-uat.spec.ts` to click "Build it", assert the
URL becomes `/workshop`, assert the chat drawer stays visible, poll the Workshop page for the
build's status text to change, then visit `/notifications` and assert a notification with title
"Your module is ready for a look" or "Your module build failed" appears (the notification list
page fetches fresh on mount, so this sidesteps the known trap where a simulated browser focus
event never reaches the network in Playwright — do not rely on the header badge for this
assertion).

Key facts gathered for that test, so the next session does not need to re-derive them:

- The building card's status text is `build.step`, rendered inside
  `packages/workshop/src/web/workshop-groups.tsx`'s `BuildingNowCard`, inside an element with
  class `jds-indicator jds-indicator--ready jds-indicator--live`.
- The notification title text lives in `.jds-task__title` on `/notifications`
  (`apps/web/src/notifications/notifications-page.tsx`).
- The "Build it" button locator already exists in the test as `planCards`.

**Not yet started:** Phase 2 (the three inert buttons: Stop/cancel, Ask for a change, Turn on for
everyone) and the UAT trigger map row additions. Read Phase 2 in the plan doc fresh; it was not
re-verified against the branch this session.

## Suggested split

Recommend the daemon cut a follow-up: finish the Phase 1 live proof only (small, well-scoped from
the notes above), then a second follow-up for Phase 2 once Phase 1's PR is merged — Phase 2's live
proof can reuse a build that Phase 1's proof already starts.

## Commands

- If no PR exists yet when you pick this up, finish that first: pre-push trio
  (`pnpm format:check && pnpm lint && pnpm typecheck`), rebase on `origin/main`, push, `gh pr
create`, then `node /home/ben/jarv1s-fleet/fleetctl.mjs set 1949 status=pr-open pr=<number>`.
- Blocked/re-slice marker (if remaining work still doesn't fit):
  `node /home/ben/jarv1s-fleet/fleetctl.mjs set 1949 status=blocked blocked_reason="needs re-slice: ..."`
