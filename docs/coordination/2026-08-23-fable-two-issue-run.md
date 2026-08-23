# Coordination Run — 2026-08-23-fable-two-issue

**Date:** 2026-08-23
**Coordinator lock:** registered agent name `coordinator` + visible pane label `Coordinator`, **stable anchor = Claude session id `c60ed2b9-0da3-4fdc-95a9-12113657660e`** (match `agent_session.value` in `herdr agent list`). Exactly one live agent named `coordinator` whose session id matches this anchor holds authority. Pane ids are ephemeral; resolve agents fresh by name and immutable session id. Prior anchor (relayed 2026-08-23): Codex session `01a02e90-46d7-7093-bffd-5e2a4bb029dc`, pane `w1:pPM`, closed after exact-session confirmed transfer.
**Approval authority:** Fable holds delegated overnight run-scope and plan approval authority. Durable scope verdict: `~/Jarv1s/fable-next-run-verdict.md` — APPROVE.
**Merge policy:** autonomous after exact-head green QA for both routine lanes; #1497 also requires live-path proof.
**Relay threshold:** routine/sensitive `merges_since_relay` ≥ 2, context-meter warning, or compaction summary. No deferral.
**merges_since_relay:** 0

> GitHub project 2 is source of truth. This manifest holds only operational state.

## Queue

| Spec | Issue | Tier | Status | Agent name | Pane | Branch | PR |
| ---- | ----- | ---- | ------ | ---------- | ---- | ------ | -- |
| `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` | #1517 | routine | closed — no-op, already satisfied | reaped | — (reaped) | (branch deleted) | — |
| `docs/superpowers/specs/2026-08-10-css-guard-residue.md` | #1497 | routine | building — successor writing plan, will ask one-shot Fable approval before code | `build-1497-today-relay1` (session `50b9cbe9-c6e4-46a8-af12-efc5c4c17435`) | `1497 Today residue r2` (resolve fresh) | `build/1497-today-residue` | — |

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

## Continuation — 2026-08-23, both forks resolved, #1497 on its second build owner

Exact-session transfer complete: authority is session `c60ed2b9-0da3-4fdc-95a9-12113657660e`
(agent name `coordinator`, pane label `Coordinator`, resolve fresh — pane numbers reflow). #1517
resolved as a genuine no-op — issue closed citing PR #1821, lane reaped. #1497's baseline fork
was routed to a one-shot Fable agent, which ruled build to 152 -> 0; recorded on the issue, lane
released to build. That owner (`build-1497-today`, session `dc82fb30-...`) relayed itself at a 70%
context-meter warning with no code written yet — it had spent its budget grounding the split
pattern used by the earlier command-palette sibling change (keep layout in place, copy color/font
into the shared design package) and handed off via
`docs/superpowers/handoffs/2026-08-23-1497-today-residue-relay.md`. Successor confirmed driving on
Sonnet; old pane reaped. Current owner is `build-1497-today-relay1`, session
`50b9cbe9-c6e4-46a8-af12-efc5c4c17435`, pane `1497 Today residue r2` (resolve fresh). It will write
the plan and ask for one-shot Fable approval before touching code, same as the standard flow.
`docs/coordination/AWAITING-BEN.md` has no open decision. Next: watch for its plan-ready
escalation, approve/route to Fable if it's a genuine fork, then supervise build and QA per the
standard coordinate-skill loop. [pane w1:pPR]
