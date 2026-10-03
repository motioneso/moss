# Coordination Run - overnight-2026-10-03

**Date:** 2026-10-03
**Coordinator lock:** agent name `coordinator`, pane label `Coordinator`, anchor = Claude session id `350800e5-1c37-4fe8-a928-2392ffce7055`. Resolve panes fresh by label; pane ids below are hints only.
**Brief:** ~/.coord-briefs/overnight-2026-10-03.md (Ben asleep, whole queue approved). Lane briefs: ~/.coord-briefs/overnight/.
**Merge policy:** routine/sensitive auto-merge after verified QA + live-path proof. Security tier: Opus adversarial QA + verdict comment, then park for Ben's merge sign-off (needs-ben) in the morning.
**Build lanes:** Muse Spark in the Builders tab (w1:t9J). QA: Opus, own pane in a QA tab.
**Lane worktrees:** nested at ~/Jarv1s/.claude/worktrees/overnight-coord/.claude/worktrees/<branch> (created from this worktree).
**merges_since_relay:** 0

## Queue

| Item | Issue | Tier | Status | Pane label | Pane | Branch | PR | Relays |
| ---- | ----- | ---- | ------ | ---------- | ---- | ------ | -- | ------ |
| Chat drawer browser tests | #2939 | routine (UI, live proof) | building | 2939 chat drawer tests | w1:p0Q | fix-2939-drawer-tests | - | 0 |
| Coverage guard gaps | #2933 | routine | in QA (qa-2962, w1:p0W, QA tab w1:t9K) | 2933 coverage guard | w1:p0R | fix-2933-coverage-guard | #2962 | 0 |
| New chat stops running turn | #2934 | security | building | 2934 new chat stops turn | w1:p0S | fix-2934-newchat-stop | - | 0 |
| Mid-chat tools hint + switched-off refusal test | #2942 | sensitive | queued (after #2939 lands) | - | - | - | - | 0 |
| Activity history redesign (slices A-D, one PR) | #2956 | security (migrations + row security) | building (session 1: plan + slice A) | 2956 activity history | w1:p0T | feat-2956-activity-history | - | 0 |
| Temporary shadow report page | #2957 | security (new private-data read route) | building (reads shadow records, not activity lines, per Ben) | 2957 shadow report | w1:p0X | feat-2957-shadow-report | - | 0 |

## Dependency / merge order

- Parallel now: #2939, #2933, #2934.
- #2942 after #2939 (shared drawer); rebase over #2934 (shared session manager).
- #2956 after #2955 merges; only lane with migrations (after 0255). Slices: A schema/row security/purge, B writers + guard, C activity page, D filters + retire old page + app map.
- #2957 overlaps #2956 slice D on settings and app map; rebase whichever lands second.
- Merge order: #2933, #2939, #2934, #2942, #2957, #2956.

## CI waivers

None.

## Outstanding escalations

- None.

## Merge audit

## Reaped sessions

## Continuation note

Wave 1 spawned. #2933, #2934, #2956 plans approved. #2934 must show each protection failing when removed. #2956: migrations 0256/0257 confirmed, slice A only then draft PR; kill gate after slice A is mine (plan section 6). Opus QA on #2956 should probe the owner-or-null insert rule (spec 5.1 allows any user to write an admin-visible System line). #2939 plan approved (cause: composer swaps the box for a connect link when the model lookup says none; lane must first check whether the lookup is a false negative). #2957 plan approved, kill gate pre-approved (counts, no message text, 30-day default); RLS proof must disable row security, not drop the policy.
