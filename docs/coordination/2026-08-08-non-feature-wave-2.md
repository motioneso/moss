# Coordination Run — 2026-08-08-non-feature-wave-2

**Date:** 2026-08-08
**Tracking epic:** #1470
**Coordinator lock:** label `Coordinator`, stable anchor = Claude session id
`f6461c25-9951-432c-9535-6fb497a92751` (same coordinator driving Wave 1; one `Coordinator` label
across both runs).
**Approval state:** Approved by Ben on 2026-08-08; #1453 brought forward as the Wave 1 unblocker
and merged there (PR #1476, `cbbcedbee6234c8fe3fd1c344e3d7cad2efbd16c`) — do not re-spawn it here.
**Merge policy:** autonomous after verified QA for routine lanes; the live-path gate still applies.
**merges_since_relay:** 0
**Overnight escalation ruling:** see `2026-08-08-non-feature-wave-1.md` header — Ben authorized an
autonomous overnight run across both waves; escalations route to `Agent(model: "fable")` as proxy.

## Queue

| Spec | Issue | Tier | Status | Agent label | Branch | PR |
| --- | --- | --- | --- | --- | --- | --- |
| `docs/superpowers/specs/2026-08-08-non-feature-wave-2.md` | #1155 | routine | **QA GREEN, MERGE-READY** — CI log independently confirmed (186/186 files, 1872 passed/2 skipped, no flake on the CI run), live-path N/A confirmed (zero UI files touched), blocking UAT `module-install.uat.spec.ts` independently run against a live Docker stack, EXIT=0; pg-boss regex mechanism verified against installed package — awaiting its turn in fixed merge order | `pr1155successor` (w1:p2G) | `fix-1155-schedule-key-slash` | #1480 |
| same | #1207 | routine | **merged** — Ben ruled 2026-08-09 approve fable-proxy's scoped waiver (2 UAT specs waived as pre-existing Moss-rename locator break, #1481, unrelated to this diff); squash-merged `dc5b4f0fb`, worktree+branch cleaned up | `pr1207-relay3`/relay4 (reaped) | `fix-1207-transcript-aria-live` | #1479 |
| same | #1115 | routine | **QA GREEN, MERGE-READY** — re-QA independently confirmed the new PR comment's gist-hosted images are real (downloaded + viewed, not just curl'd), each state shows exactly one Overdue indicator (no duplicate), `showBadge`/`drift` logic traced as mutually exclusive by construction, 3 regression tests present, CI all green, invariants ok — awaiting its turn in fixed merge order | `pr1115-relay3` (w1:p2H) | `fix-1115-overdue-indicator` | #1478 |
| same | #1433 | routine | PR open, QA YELLOW resolved — CI "Verify foundation and app" now **pass**; all checks green except "Build and publish images" (pending — known-disabled mid-wave CI job, not a blocker, see memory `ci-image-build-job-disabled-mid-wave`); merge-ready, awaiting its turn in fixed order | `pr1433-wrapup` (w1:p2E) | `fix-1433-dataset-fetch-warning` | #1477 |
| same | #1453 | routine | merged (as Wave 1 unblocker) | `Google schedule root #1453 r2` (reaped) | `fix-1453-google-schedule-root` | #1476 |

## Grounding evidence

- `docs/coordination/wave2-prep/backend-grounding.md`
- `docs/coordination/wave2-prep/ui-grounding.md`
- `docs/coordination/wave2-prep/flake-grounding.md`
- `docs/coordination/wave2-prep/candidate-challenge.md`
- Live GitHub recheck on 2026-08-08: all five issues open; no candidate PR assigned.
- Current `main` CI run 31279428199 passed at
  `00ec6d5f5bca3312ce7b639cecdd35fec91e5a7a`.

## Dependency and merge order

- **Parallel group 1:** all five lanes; intended production/test paths are disjoint.
- **Wave 1 collision check:** none. Wave 2 does not spawn until separately approved.
- **Merge order:** #1207 → #1155 → #1115 → #1433 → #1453.
- #1207 and #1115 require live-path proof. #1207 also has four blocking mapped UAT specs.
- #1433 requires explicit log-safety review. #1453 requires repeated focused integration evidence.

## CI waivers

None. A red check stops the lane.

## Outstanding escalations

- None.

## Reaped sessions

- `Google schedule root #1453` / `71e557a4-1ea4-40a8-9134-1137bdc5c2cf` — relayed at the
  context threshold after committing the approved one-file test edit as `28e85777a`; r2 confirmed
  driving the same worktree before the old pane was closed.
- `PR1115 overdue indicator` / `544d62a0-6d70-428e-b1a3-9a96c9205bb7` — relayed after committing
  plan+handoff doc fix as `e4c064cd2`; successor `pr1115-relay` (`39efc7c2-f3bc-4334-b0e3-55896a542a5c`,
  w1:p2D) confirmed driving `coordinated-wrap-up` (gate running) before the old pane (w1:p2B) was
  closed.
- `PR1433 dataset fetch warning` / `5d82b132-fa9d-4cb1-a6a2-af5207275c3e` — relayed at 70% during
  wrap-up (build committed `d4f162343`, gate running in background); self-reported and reverted an
  accidental main-tree commit (`f76e619ae` → revert `e0ad2b885`, verified clean, no lasting effect).
  Successor `pr1433-wrapup` (`243bca59-b019-41d2-9e4a-bf45f01ffbf1`, w1:p2E) confirmed driving
  before the old pane (w1:p2C) was closed. Note: #1155 and #1433 both wrote their plan docs to the
  shared main tree instead of their worktree (untracked, harmless, left for the lane to self-clean
  — same pattern #1115 caught).
- `PR1115 relay` / `39efc7c2-f3bc-4334-b0e3-55896a542a5c` — relayed again at its own context
  threshold while mid-debug on the live-path proof (Playwright sign-in POSTs 200 but UI doesn't
  navigate past sign-in). PR #1478 already open, gate green (VF_EXIT=0). Continuation doc
  `docs/superpowers/handoffs/2026-08-09-fix-1115-overdue-indicator-relay-2.md` (`87c4d6e28`). Dev
  instance left running for the successor (API pid 405565 :3299, web pid 405285 :5299) —
  successor owns teardown. Successor `pr1115-relay2` (`9907b0d5-55ec-4393-ae36-55ae00ba09a6`,
  w1:p2F) confirmed actively driving before the old pane (w1:p2D) was closed.
- `PR1155 schedule key slash` / `8337a11c-8d9a-4b3a-ac27-183fbc25df87` — relayed at 70% during
  pre-push checks/wrap-up. Both commits (fix + real-pg-boss integration test) green and clean on
  branch; gate flaked twice on unrelated concurrent-tuple contention, a different file each time
  (connectors-google.test.ts, then news-discovery-repository.test.ts), not this diff. Continuation
  doc `docs/superpowers/handoffs/2026-08-09-fix-1155-schedule-key-slash-relay.md` (`febb7b133`).
  Successor `pr1155successor` (`3837a7d0-b917-40b1-bbe9-17b4d8ed43ef`, w1:p2G) confirmed actively
  driving (session freshly re-resolved via `herdr pane list`) before the old pane (w1:p2A) was
  closed.
- `PR1207 transcript aria-live` / `e363dadd-442d-4e7a-b40f-343194239a18` — relayed at context-meter
  70% after opening PR #1479, committing code fix + regression test, and running gate 3x on an
  isolated DB (green on the 3rd run; first two flaked on unrelated sibling-worktree DDL contention).
  Live-path proof (4 blocking UAT specs + aria-live DOM evidence) not yet started. Successor
  `pr1207-relay2` (`ae627f40-5e40-48ea-a43e-9e07c92f9f8f`, w1:p2J) confirmed actively driving
  (`run-uat.ts`) before the old pane (w1:p29) was closed.
- `PR1115 relay2` / `9907b0d5-55ec-4393-ae36-55ae00ba09a6` — relayed after QA posted RED on PR
  #1478 (narrative-only live-path comment, no attached images). Wrote+committed+pushed continuation
  doc `docs/superpowers/handoffs/2026-08-09-fix-1115-overdue-indicator-relay-3.md` (fix plan:
  gist-hosted real screenshots, CI-check reconfirmation, teardown). Successor `pr1115-relay3`
  (`2601aeeb-0e8f-497a-acee-3d4c0435217b`, w1:p2H) confirmed actively driving (generating real
  screenshots, e.g. `done-overdue.png`) before the old pane (w1:p2F) was closed.
- `PR1207 transcript aria-live (relay2)` / `ae627f40-5e40-48ea-a43e-9e07c92f9f8f` — coordinator
  directed this relay proactively at 9-10% until auto-compact (past the 70% trigger, mid live-path
  UAT run) to avoid an in-context compaction. Committed continuation doc `736a66df1` before
  spawning. Successor `pr1207-relay3` (`d119adac-77d3-4a9d-ae46-3f3e023dd43f`, w1:p2K) self-reported
  resuming from the handoff doc (coordinated-build step 4, DOM aria-live proof) before the old pane
  (w1:p2J) was closed.
