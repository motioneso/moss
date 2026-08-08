# Coordination Run — 2026-08-08-non-feature-wave-1

**Date:** 2026-08-08  
**Tracking epic:** #1470  
**Coordinator lock:** label `Coordinator`, stable anchor = Codex session id
`019fe31f-18ba-7342-b5dd-83db98923b31`.  
**Approval state:** Approved by Ben on 2026-08-08.  
**Merge policy:** autonomous after verified QA for routine lanes; the live-path gate still applies.  
**merges_since_relay:** 0

> GitHub project 2 and #1470 are the live status roll-up. This file holds the fleet's operational
> state. Pane IDs are intentionally omitted because they reflow; agents are tracked by label and
> immutable session ID after spawn.

## Queue

| Spec | Issue | Tier | Builder | Status | Agent label | Branch | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `docs/superpowers/specs/2026-08-08-non-feature-wave-1.md` | #1448 | routine | GPT-5.6 Luna high | building | `News alias #1448` / `019fe342-086e-7be3-8ddf-db6a1a5960ad` | `fix-1448-news-vitest-alias` | — |
| same | #887 | routine | GPT-5.6 Luna high | building | `Quiet-hours #887` / `019fe342-08cc-7b70-a574-dae8c26452b9` | `fix-887-quiet-hours-flake` | — |
| same | #1412 | routine | Sonnet 5 (`sonnet`) | building | `Masthead #1412` / `b34dd772-ad76-4bba-88c7-084ac05e9b67` | `fix-1412-masthead-space` | — |
| same | #903 | routine | Sonnet 5 (`sonnet`) | building | `Sports tie-break #903` / `b5d43aea-c5b8-4a5b-bd97-8c914cedd98f` | `fix-903-sports-tiebreak` | — |
| same | #1272 | routine | Sonnet 5 (`sonnet`) | building | `Migration pin #1272` / `162af5a5-c3f1-48a6-82cb-db4b0e33a3bb` | `test-1272-structured-state-migrations` | — |

## Dependency and collision map

- **Parallel group 1:** all five lanes. Their intended production/test files are disjoint.
- **Merge order:** #887 → #1448 → #1272 → #1412 → #903. Internal-only fixes land first; the two
  live-path lanes land after their UI proofs.
- **Known shared pressure:** all branches start from the same green `main`; any merge requires a
  rebase and fresh diff-scoped QA before the next merge.
- **Existing worktree:** `.claude/worktrees/security-1383-credential-guard` is unrelated and must
  not be modified or reaped by this run.

## Status publication

- #1470 first-wave table is updated at every lane transition: building, PR open, QA, live-path,
  merged, or blocked.
- Routine/sensitive merges receive a short digest on #1470, so progress is visible without asking
  the coordinator.
- Blockers are recorded both here and on the affected issue.

## CI waivers

None. A red check stops the lane.

## Outstanding escalations

- None.

## Reaped sessions

- None.
