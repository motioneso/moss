# Coordination Run — 2026-08-23-fable-two-issue

**Date:** 2026-08-23
**Coordinator lock:** registered agent name `coordinator` + visible pane label `Coordinator`, **stable anchor = Claude session id `c190651f-819e-4ca2-855b-be976d6f4220`** (match `agent_session.value` in `herdr agent list`). Exactly one live agent named `coordinator` whose session id matches this anchor holds authority. Pane ids are ephemeral; resolve agents fresh by name and immutable session id. Prior anchor (relayed 2026-08-23, context-meter 70% after #1497 plan approval): Claude session `c60ed2b9-0da3-4fdc-95a9-12113657660e`, pane `w1:pPR`, closed after exact-session confirmed transfer.
**Approval authority:** Fable holds delegated overnight run-scope and plan approval authority. Durable scope verdict: `~/Jarv1s/fable-next-run-verdict.md` — APPROVE.
**Merge policy:** autonomous after exact-head green QA for both routine lanes; #1497 also requires live-path proof.
**Relay threshold:** routine/sensitive `merges_since_relay` ≥ 2, context-meter warning, or compaction summary. No deferral.
**merges_since_relay:** 0

> GitHub project 2 is source of truth. This manifest holds only operational state.

## Queue

| Spec | Issue | Tier | Status | Agent name | Pane | Branch | PR |
| ---- | ----- | ---- | ------ | ---------- | ---- | ------ | -- |
| `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` | #1517 | routine | closed — no-op, already satisfied | reaped | — (reaped) | (branch deleted) | — |
| `docs/superpowers/specs/2026-08-10-css-guard-residue.md` | #1497 | routine | building — plan approved, proceeding to code | `build-1497-today-relay2` (session `a3d101ab-0506-4b30-ac42-434e663afa9a`) | resolve fresh | `build/1497-today-residue` | — |

## Dependency / merge order

- **Parallel group 1:** #1517 and #1497 launch together; their modules and files are disjoint.
- **Merge order:** whichever reaches exact-head green QA first may merge; the other lane rebases on the new `origin/main` and receives fresh exact-head QA before merge.
- #1497 must branch from `origin/main` at or after `2996f6cf6c068a2567cbec62580879e0cd9ee527`; its sibling CSS/package work just landed.
- #1511 remains excluded while #1246 is open. All other exclusions and reasons are in the Fable verdict.

## CI waivers

| Check | PR | Proven red on `main` @ SHA | Proof | Ben-approved |
| ----- | -- | -------------------------- | ----- | ------------ |
| none | — | — | — | — |

## Outstanding escalations

None open.

## Resolved forks

- #1517: confirmed genuine no-op. PR #1821 (merged 2026-08-22, commit `50cdc2f08`) already fully
  implements and tests the escaping/truncation contract in `packages/commitments/src/repository.ts`
  and `tests/integration/commitments.test.ts`. Issue closed with the PR cited; lane stood down,
  worktree and branch reaped, pane closed.
- #1497: one-shot Fable plan ruling — build to the as-measured 152 -> 0, not the spec's literal
  147; the acceptance target is the three named sheets reaching zero, not a fixed number, and the
  spec's own per-child rule requires recording a differing baseline on the child issue rather than
  silently absorbing it. Recorded on issue #1497 (comment). Lane released to plan/build.

## Reaped sessions

- Fable scope reviewer `fable-run-scope`, session `c359c706-e66d-4a52-b7c1-823ba3d315c6`: verdict consumed; session and isolated worktree fully reaped.

## Continuation — 2026-08-23, coordinator relay (context-meter 70%), #1497 plan approved

Both forks are resolved (see Resolved forks). #1517 is fully closed and reaped. #1497: baseline
ruled 152 -> 0 by one-shot Fable, recorded on the issue. The build lane relayed twice while
grounding and planning (no code written either time) — `build-1497-today` -> `build-1497-today-relay1`
-> `build-1497-today-relay2` (session `a3d101ab-0506-4b30-ac42-434e663afa9a`, worktree
`.claude/worktrees/1497-today-residue`, branch `build/1497-today-residue`). Each successor was
confirmed driving on Sonnet before the prior pane was closed; no orphaned panes/worktrees.

The plan at `docs/superpowers/plans/2026-08-23-1497-today-css-residue.md` was reviewed and
**approved as-is** (mechanical extraction, guard-tool-verified declaration list, both `font:
inherit` cascade couplings handled, clean collision boundaries with children B-E/F/G, live-path +
UAT plan present) — no fork, this coordinator approved directly without escalating to Fable. The
approval was delivered to `build-1497-today-relay2` and confirmed processing.

This coordinator's own context meter hit 70% immediately after that send, firing the mandatory
relay trigger. No merge has happened yet this session (`merges_since_relay: 0`, unchanged).
Handing off now: a successor coordinator is being spawned in this same pane's tab. It should
confirm `build-1497-today-relay2` is actually building (not another relay-without-code loop —
if it relays a third time before any commit, that is worth a closer look, not just another
silent adopt), then continue the standard coordinate-skill loop: QA on green, merge, close #1497
and its board item, report to Ben. `docs/coordination/AWAITING-BEN.md` has no open decision.
[pane w1:pPR]

## Continuation — 2026-08-23, coordinator relay to Codex (Ben's explicit instruction, not a threshold trigger)

Adopted from the prior Claude coordinator (session `c60ed2b9-0da3-4fdc-95a9-12113657660e`, pane
`w1:pPR`, exact-session match confirmed, closed cleanly). No merges happened this session
(`merges_since_relay: 0`). `docs/coordination/AWAITING-BEN.md` has no open decision.

Build lane since adoption: `build-1497-today-relay2` (session `a3d101ab-0506-4b30-ac42-434e663afa9a`,
worktree `.claude/worktrees/1497-today-residue`, branch `build/1497-today-residue`) did real work —
all 152 style violations moved into the shared design package, verified and committed across 4
commits. It then used its own internal subagent (`build-1497-today-relay3`, NOT a separate Herdr
pane — confirmed via `herdr agent list`, no such agent/pane exists) to do the browser proof, the
UAT spec, and now the full test gate, ahead of writing the release note and opening the PR. As of
this handoff the PR is not yet open — still waiting on that gate. relay2's own pane is at ~69%
context (11% until its own auto-compact), so it may relay again on its own before the PR lands;
that is normal per the build-agent relay protocol, not a stall.

**Ben instructed this coordinator relay explicitly** (not a context-meter/merge-count trigger) —
model `gpt-5.6-sol` at medium reasoning effort, via Codex, and he asked the successor to **stay on
Codex relays only for the rest of this run** — i.e. do not relay back to a Claude coordinator;
every further coordinator self-handoff in this run should also spawn a Codex successor.

Successor's next steps: re-confirm the Codex session id as the new lock anchor, watch
`build-1497-today-relay2`'s pane (`w1:pPT`) for the PR to open, then run the standard
coordinate-skill QA-on-green -> merge -> close #1497 -> report-to-Ben loop. [pane w1:pPV]
