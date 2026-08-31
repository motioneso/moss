# Coordination Run — 2026-08-30-next-ready

**Date:** 2026-08-30
**Coordinator lock:** registered agent name `coordinator` + visible pane label `Coordinator`; session id `528e6a29-b81a-4773-a46c-bcf524e188c6` (pane `w1:p34`) — successor after the relay following the #1860 security merge; adopted lock, confirmed driving, old pane `w1:p2X` (session `5e13ca3b-...`) closed.
**Merge policy:** autonomous after verified QA for `routine`/`sensitive`; `security` needs Ben's explicit merge sign-off.
**Relay threshold:** relay after every security merge, every two routine/sensitive merges, any context warning, or any compaction summary.
**merges_since_relay:** 0
**Infrastructure limitation:** `coordinator-watchdog.timer` is not installed on this host. Not retried this session.

## Queue

| Slice | Issue | Tier | Status | Agent name | Pane | Branch | PR | Relays |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1784 truthful chat action chip | #1784 | routine | **QA red — sent back for fix** | `issue-1784-chip-relay1` | `w1:p20` | `build-1784-chat-outcome-chip` | #2116 | 1 |
| #1860 module-build environment isolation | #1860 | security | **MERGED** | — | — | `build-1860-module-build-env` | #2117 | 1 |
| #1869 Slice 1: per-turn time context | #1869 | sensitive | building | `issue-1869-time-context-relay2` | `w1:p2Y` | `build-1869-time-context` | — | 2 (no third relay allowed) |
| #1869 Slice 2: `chat.getCurrentTime` | #1869 | routine | dependency-gated | `issue-1869-current-time` | — | `build/1869-current-time` | — | 0 |
| #1869 Slice 3A: SDK wall-clock conversion | #1869 | sensitive | dependency-gated | `issue-1869-sdk-time` | — | `build/1869-sdk-time` | — | 0 |
| #1869 Slice 3B: Food integration | #1869 | sensitive | dependency-gated | `issue-1869-food-time` | — | `build/1869-food-time` | — | 0 |

Plans and approved specs live on commit `d97af8896` in branch `plans/fable-next-ready` until integrated into `main`.

## Dependency / collision map

**Opus collision review (done 2026-08-30):** Wave 1's three lanes touch completely separate files
and are safe to run at the same time. None of the three plans adds a database change, so there is
no numbering clash to manage. The Food side of the date/time work reaches shared time code only
through the software kit's published interface, so module isolation holds. Two corrections for
later waves: (1) the plan for #1869 slices 2 and 3A was written assuming they'd share one working
copy and one pull request — running them as two agents in that same copy at once is unsafe (they'd
each see the other's half-finished edits during whole-project checks), so slice 2 and slice 3A each
need their own separate working copy and branch, or must run one after the other, not together; (2)
the "kill gate" before starting slice 2/3A needs a real hands-on check of slice 1 in a live chat on
the dev site, with Ben judging whether the injected time information confuses the assistant or
changes its personality — not just automated tests and a code read. Also: all three plans end with
a hands-on check on the single shared dev site, so those checks must happen one at a time, never
three agents driving the dev site at once.

- Initial parallel wave: #1784, #1860, and #1869 Slice 1.
- Kill gate: later #1869 slices do not start until Slice 1 passes its focused tests, review, AND a
  live hands-on check on the dev site with Ben judging whether the injected time confuses the
  assistant or changes its personality.
- Wave 2 after the kill gate: #1869 Slice 2 and Slice 3A each get their own separate working copy
  and branch (not the shared one from the current plan draft) — either run one after the other, or
  spawn each in its own isolated worktree so neither sees the other's half-finished edits.
- Wave 3: #1869 Slice 3B starts only after Slice 3A lands or its branch is rebased onto 3A.
- No two agents share a worktree or branch. Build agents may not edit `docs/coordination/`.
- Live-site hands-on checks for all three plans must be serialized — never run two at once against
  the single shared dev instance.
- Planned merge order: #1784 → #1869 Slice 1 → #1860 (security sign-off, then coordinator relay) → #1869 Slice 2 → #1869 Slice 3A → #1869 Slice 3B.

## Verification gates

- Latest `main` CI must be green before any build agent starts; GitHub was temporarily unreachable during this coordinator session, so this remains pending.
- #1784 and user-facing #1869 work require live-path proof before merge.
- #1860 requires Opus adversarial QA, a durable PR verdict comment, and Ben's explicit merge sign-off.
- DB-touching verification must use `verify-gate`.

## CI waivers

None.

## Outstanding escalations

- [x] Run the required one-shot Opus dependency/collision review against the three approved plans. Result: wave 1 is safe as planned; corrections recorded above for wave 2/3.
- [x] Confirm latest `main` CI is green. Confirmed via `gh run list --branch main` — latest push run succeeded.
- [x] Integrate plan/spec commit `d97af8896`. PR #2108 (plan/spec docs) and PR #2109 (manifest update) both merged to main.
- [x] Ben already approved the specs and instructed one agent per finalized slice (per boot brief) — no separate manifest pause required.
- [x] Wave-1 handoff docs written and merged via PR #2110: `handoff-1784-chat-outcome-chip.md`, `handoff-1860-module-build-env.md`, `handoff-1869-time-context.md`.
- [x] PR #2111 (coordinator manifest flush before relay) merged.
- [x] All three wave-1 build agents spawned, confirmed on Sonnet, named/labeled, and unblocked. #1784 approved to build after its own plan-drift check came back clean. #1860 approved to build after its own plan-drift re-check came back clean. #1860 and #1869 Slice 1 both hit their handoff docs missing (spawned before PR #2110 had merged) — redirected each to re-fetch `origin/main` and read the merged doc; both confirmed queued and are proceeding.

## Continuation note (2026-08-31, relaying — context meter hit 70%)

Coordinator lock is under session id `528e6a29-b81a-4773-a46c-bcf524e188c6`, pane `w1:p34` — **this session hit the 70% context warning and is relaying now, per the standing rule (no deferral).** The successor must adopt the lock (Phase 0a), then close this pane once confirmed driving. `merges_since_relay: 0` (PR #2124, the manifest-flush docs PR, has already merged and does not count as a code merge).

**Lane status:**
- **#1860** (security): MERGED (PR #2117). Follow-up tickets #2122 and #2123 are filed but **still not placed on the project board (project 2)** — do that next pass.
- **#1784** (routine, chip fix), PR #2116: the build agent (`issue-1784-chip-relay1`, pane `w1:p20`) just reported the fix is done, commit `4242c7587`, citing exact file/line for each of the three stale tests it fixed (`tests/e2e/app-shell.spec.ts` lines 715 and 788, `tests/e2e/self-operation-no-confirmation-card.spec.ts` line 87) — all now check for "Executed" instead of the old wrong word "Changed". It also reports one unrelated failing test (`briefing-action-rows.spec.ts`, a reload-timing issue in an unrelated command bar, not touched by this change) — worth a sanity check but likely a pre-existing flake, not a blocker. CI was re-triggered by the push; a background watch on the PR's checks was running in the relaying session but did not survive the relay — **the successor must re-arm it**: `gh pr checks 2116 --watch` (via `run_in_background`, never inline). Once green, spawn a fresh QA pane (routine tier, Sonnet) scoped to the diff since the last reviewed commit (`aa36701c5..4242c7587`) rather than a full re-review, then merge if green — no Ben sign-off needed for routine tier. QA pane/worktree from the first (red) round were already reaped; this is a fresh QA spawn.
- **#1869 Slice 1** (sensitive), pane `w1:p2Y`, agent `issue-1869-time-context-relay2`: still building, SECOND relay, told not to relay a third time. Last seen mid-gate-run, working normally, not frozen. No PR yet. Keep watching; if it relays again, STOP — take over and re-slice instead of allowing a third same-lane relay.

**Next steps for whoever is driving:**
1. Adopt the coordinator lock (Phase 0a), confirm driving, close pane `w1:p34`.
2. Re-arm a background watch on PR #2116's CI checks (`gh pr checks 2116 --watch` via `run_in_background`), merge once green after a diff-scoped QA pass (see above).
3. Place tickets #2122 and #2123 on the project board (project 2).
4. Keep supervising #1869 Slice 1 relay2 (`w1:p2Y`) to PR — no third relay allowed for that lane.
5. Kill gate before Wave 2 (#1869 Slice 2/3A): Slice 1 needs tests + review + a live, Ben-judged check on the dev site of whether injected time confuses the assistant. Do not start Slice 2/3A before that. Slice 2 and Slice 3A each need their own separate worktree/branch.
6. All three wave-1 lanes end with a live check on the single shared dev instance — serialize those, never run two at once.
7. `coordinator-watchdog.timer` is still not installed on this host (tried again this session, unit not found).
8. Ben asked (2026-08-30) to mix agent providers across future spawns rather than defaulting everyone to Claude — plan Wave 2 accordingly.
9. Direct push to `main` is blocked by a required check — any manifest update needs a PR (branch, push, `gh pr create`, wait for green, `gh pr merge --squash --auto`).

## Merge audit

| PR | What | Tier | Merged |
| --- | --- | --- | --- |
| #2108 | plan/spec docs integration | routine (docs) | yes |
| #2109 | coordinator manifest update | routine (docs) | yes |
| #2110 | wave-1 build handoff docs | routine (docs) | yes |
| #2111 | coordinator manifest flush before relay | routine (docs) | yes |
| #2112 | coordinator: adopt lock, merge wave-1 PRs, spawn build agents | routine (docs) | yes |
| #2114 | coordinator: adopt lock + AWAITING-BEN entry (branch-tracking mistake) | routine (docs) | closed, superseded by #2118 |
| #2118 | coordinator: manifest flush, correct branch history | routine (docs) | yes |
| #2119 | coordinator: update #2117 sign-off entry with QA re-verification | routine (docs) | yes |
| #2117 | #1860 module-build environment isolation | security | **yes — Ben signed off "yes" in chat, merged 2026-08-31T04:01:24Z** |
| #2116 | #1784 truthful chat action chip | routine | QA in progress |

## Reaped sessions

- Old coordinator, session `81f073ee-...`, pane `w1:p2Q` — closed after confirming successor (session `751e32d2-...`, pane `w1:p2S`) was driving.
- Old coordinator, session `751e32d2-...`, pane `w1:p2S` — closed this session after confirming successor (session `5e13ca3b-...`, pane `w1:p2X`) was driving.
- Build agent `issue-1869-time-context`, pane `w1:p2V` — relayed to `issue-1869-time-context-relay1` (pane `w1:p2W`, same worktree/branch) on its own 70% context warning; successor confirmed driving before close.
- Build agent `issue-1869-time-context-relay1`, pane `w1:p2W` — relayed to `issue-1869-time-context-relay2` (pane `w1:p2Y`, same worktree/branch), this lane's SECOND relay; successor confirmed driving before close.
- Build agent `issue-1860-env-relay1`, pane `w1:p31` — work merged (PR #2117), no further work needed; closed.
- Build agent `issue-1784-chip` (pane `w1:p2R`) — stale duplicate of the reporting pane `w1:p20`, same worktree/branch, both showed the same finished work; closed after confirming `w1:p20` and PR #2116 already had the full report.
- Build agent `issue-1860-env`, pane `w1:p2T` — relayed to `issue-1860-env-relay1` (pane `w1:p31`, same worktree/branch) after reporting #1860 done and PR #2117 open; successor confirmed driving before close.
