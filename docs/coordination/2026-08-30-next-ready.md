# Coordination Run — 2026-08-30-next-ready

**Date:** 2026-08-30
**Coordinator lock:** registered agent name `coordinator` + visible pane label `Coordinator`; stable anchor = session id `01a050c1-071d-7331-87c8-da8ab80a3909`. Exactly one matching coordinator was confirmed before this manifest was written.
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

- Initial parallel wave: #1784, #1860, and #1869 Slice 1.
- Kill gate: later #1869 slices do not start until Slice 1 passes its focused tests and review.
- Wave 2 after the kill gate: #1869 Slice 2 and Slice 3A may run in parallel because their file ownership is exclusive.
- Wave 3: #1869 Slice 3B starts only after Slice 3A lands or its branch is rebased onto 3A.
- No two agents share a worktree or branch. Build agents may not edit `docs/coordination/`.
- Planned merge order: #1784 → #1869 Slice 1 → #1860 (security sign-off, then coordinator relay) → #1869 Slice 2 → #1869 Slice 3A → #1869 Slice 3B. A one-shot Opus collision review must confirm this before the first wave starts.

## Verification gates

- Latest `main` CI must be green before any build agent starts; GitHub was temporarily unreachable during this coordinator session, so this remains pending.
- #1784 and user-facing #1869 work require live-path proof before merge.
- #1860 requires Opus adversarial QA, a durable PR verdict comment, and Ben's explicit merge sign-off.
- DB-touching verification must use `verify-gate`.

## CI waivers

None.

## Outstanding escalations

- [ ] Run the required one-shot Opus dependency/collision review against the three approved plans.
- [ ] Confirm latest `main` CI is green.
- [ ] Integrate plan/spec commit `d97af8896` so fresh `origin/main` worktrees contain the approved documents.
- [ ] Present this manifest to Ben and receive approval before spawning the first wave.

## Continuation note

Compaction tripwire fired immediately after plan review. Per the coordinate skill, this session must relay before spawning or merging. The successor should read this section, verify its coordinator lock, complete the four outstanding items above, then launch only the initial three-agent wave in a dedicated Builders tab with Sonnet confirmed in every pane.

## Merge audit

No merges in this run yet.

## Reaped sessions

None in this run yet.
