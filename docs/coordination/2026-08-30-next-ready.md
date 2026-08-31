# Coordination Run — 2026-08-30-next-ready

**Date:** 2026-08-30
**Coordinator lock:** registered agent name `coordinator` + visible pane label `Coordinator`; stable anchor = session id `81f073ee-f2af-4788-a6d5-86e8cd824e21` (pane `w1:p2Q`). Previous coordinator (codex, session `01a050c1-071d-7331-87c8-da8ab80a3909`, pane `w1:p1`) was found idle/done and was reaped after this successor confirmed it was driving.
**Merge policy:** autonomous after verified QA for `routine`/`sensitive`; `security` needs Ben's explicit merge sign-off.
**Relay threshold:** relay after every security merge, every two routine/sensitive merges, any context warning, or any compaction summary.
**merges_since_relay:** 0
**Infrastructure limitation:** `coordinator-watchdog.timer` is not installed on this host. One start attempt returned “unit not found”; no retry loop was run.

## Queue

| Slice | Issue | Tier | Status | Agent name | Pane | Branch | PR | Relays |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #1784 truthful chat action chip | #1784 | routine | queued | `issue-1784-chip` | — | `build/1784-chat-outcome-chip` | — | 0 |
| #1860 module-build environment isolation | #1860 | security | queued | `issue-1860-env` | — | `build/1860-module-build-env` | — | 0 |
| #1869 Slice 1: per-turn time context | #1869 | sensitive | queued | `issue-1869-time-context` | — | `build/1869-time-context` | — | 0 |
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
- [x] Integrate plan/spec commit `d97af8896`. PR #2108 (plan/spec docs, formatting fix by the owning agent) and PR #2109 (this manifest's earlier update) both merged to main.
- [x] Ben already approved the specs and instructed one agent per finalized slice (per boot brief) — no separate manifest pause required.
- [x] Wave-1 handoff docs written and merged via PR #2110: `handoff-1784-chat-outcome-chip.md`, `handoff-1860-module-build-env.md`, `handoff-1869-time-context.md` (all in `docs/coordination/`).
- [ ] Spawn the wave-1 build agents. Worktrees exist for all three (`.claude/worktrees/build-1784-chat-outcome-chip`, `build-1860-module-build-env`, `build-1869-time-context`, all branched off `origin/main`). Boot briefs written to `~/.coord-briefs/boot-issue-1784-chip.txt`, `boot-issue-1860-env.txt`, `boot-issue-1869-time-context.txt`. Only the #1784 pane has been created so far (`w1:p2R`, moved into the new "builders" tab `w1:tP`) — the `herdr agent start` command for it has NOT been run yet. #1860 and #1869 Slice 1 panes/agents are not yet created.

## Continuation note (relay fired on context-meter 70% warning — immediately after creating the #1784 pane, before starting any agent)

Coordinator lock is under session id `81f073ee-f2af-4788-a6d5-86e8cd824e21`, pane `w1:p2Q`, named/labeled `coordinator`/`Coordinator`. The old coordinator (codex, session `01a050c1-...`, pane `w1:p1`) was idle/done and was reaped earlier this session. `coordinator-watchdog.timer` is still not installed on this host (unit not found) — not retried.

**What the successor must do, in order:**
1. Adopt the coordinator lock per the `coordinate` skill (Phase 0a): rename/relabel your own pane to `coordinator`/`Coordinator` only after confirming you're driving; this session (`81f073ee-...`) will then be the stale one to reap.
2. Finish spawning wave 1. Pane `w1:p2R` (tab `w1:tP`, "builders") already has `cwd` set to `.claude/worktrees/build-1784-chat-outcome-chip` but no agent started yet — run:
   `herdr agent start issue-1784-chip --kind claude --pane w1:p2R -- --model sonnet --permission-mode bypassPermissions "Read the file /home/ben/.coord-briefs/boot-issue-1784-chip.txt in full. It is your task brief. Follow it exactly."`
   then confirm the pane says "Sonnet" and rename it (`herdr agent rename w1:p2R issue-1784-chip`, `herdr pane rename w1:p2R "1784 chat outcome chip"`).
3. Split two more panes off `w1:p2R` (inside the `w1:tP` "builders" tab, NOT off the coordinator pane) for #1860 (`cwd .claude/worktrees/build-1860-module-build-env`, brief `~/.coord-briefs/boot-issue-1860-env.txt`, agent name `issue-1860-env`) and #1869 Slice 1 (`cwd .claude/worktrees/build-1869-time-context`, brief `~/.coord-briefs/boot-issue-1869-time-context.txt`, agent name `issue-1869-time-context`). Start each with `--model sonnet --permission-mode bypassPermissions`, confirm Sonnet, name in both namespaces, record pane/branch in the Queue table below.
4. Update the Queue table (Status → `building`, fill in Pane/Agent name) for all three as they come up.
5. Do NOT start #1869 Slice 2 or 3A yet — they wait on Slice 1's kill gate (tests + review + a live, Ben-judged check on the dev site of whether injected time confuses the assistant). When that wave does start, give Slice 2 and Slice 3A **separate** worktrees/branches — the plan document wrongly assumes they share one; see the collision-review note above.
6. All three wave-1 lanes end with a live check on the single shared dev instance — do not let two run that check at the same time.

No PRs from wave-1 build agents exist yet. No merges pending review. `merges_since_relay: 0`.

## Merge audit

No merges in this run yet.

## Reaped sessions

None in this run yet.
