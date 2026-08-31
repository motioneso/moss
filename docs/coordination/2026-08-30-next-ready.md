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
- [ ] Integrate plan/spec commit `d97af8896` so fresh `origin/main` worktrees contain the approved documents. PR #2108 opened; failed CI's formatting check on the new docs (prettier), sent back to the `fable-next-plans` agent (pane `w1:p2P`, owns that worktree/branch) to fix and push. Waiting on that push, then CI, then merge.
- [x] Ben already approved the specs and instructed one agent per finalized slice (per boot brief) — no separate manifest pause required.

## Continuation note

Coordinator lock re-confirmed under session id `81f073ee-f2af-4788-a6d5-86e8cd824e21` (pane `w1:p2Q`, now named/labeled `coordinator`/`Coordinator`); old coordinator (codex, session `01a050c1-...`, pane `w1:p1`) was idle/done and has been reaped. `coordinator-watchdog.timer` is still not installed on this host (unit not found) — not retried. Next: once PR #2108 (plan/spec docs) is green, merge it, then spawn the wave-1 build agents for #1784, #1860, and #1869 Slice 1 as Sonnet `coordinated-build` agents in isolated worktrees under a new Builders tab. Do not start #1869 Slice 2/3A until Slice 1 passes its kill gate (tests + review + a live hands-on check on the dev site judged by Ben) — and when that wave starts, give Slice 2 and Slice 3A separate worktrees/branches (the current plan draft wrongly assumes they share one).

## Merge audit

No merges in this run yet.

## Reaped sessions

None in this run yet.
