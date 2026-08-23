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
| `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` | #1517 | routine | blocked — pre-build no-op verification | `build-1517-evidence` (session `29f132f4-0ba5-4dec-962a-b6539869be1f`) | `1517 evidence escape` (resolve fresh) | `build/1517-evidence-escape` | — |
| `docs/superpowers/specs/2026-08-10-css-guard-residue.md` | #1497 | routine | blocked — pre-plan baseline fork | `build-1497-today` (session `dc82fb30-071e-4959-925d-98e05416d6c1`) | `1497 Today residue` (resolve fresh) | `build/1497-today-residue` | — |

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

- #1517 pre-build discovery: the owner reports the issue's escaping/truncation behavior already
  exists on current `origin/main` in `packages/commitments/src/repository.ts`; the lane is held
  unchanged until the successor verifies the full issue acceptance and decides whether this is a
  no-op/issue-close path or missing scope. This is not a Ben-only decision.
- #1497 pre-plan baseline fork: current `origin/main` contains 152 banned visual declarations
  across the three Today sheets (34 + 25 + 93), while the approved spec records 147. The lane is
  held before plan/source edits. Route the exact 147-versus-152 question to Fable for one-shot plan
  authority; do not silently absorb the five-declaration drift. This is not a Ben-only decision.

## Reaped sessions

- Fable scope reviewer `fable-run-scope`, session `c359c706-e66d-4a52-b7c1-823ba3d315c6`: verdict consumed; session and isolated worktree fully reaped.

## Continuation — 2026-08-23, compaction relay required

The Fable-approved run was launched from green `origin/main` at `2996f6cf6c068a2567cbec62580879e0cd9ee527`,
but both routine lanes stopped safely before edits: #1517 found an apparent no-op on main, and
#1497 found a 147-versus-152 declaration baseline fork. Exact owner sessions and decisions needed
are recorded above; both worktrees remain unchanged. `docs/coordination/AWAITING-BEN.md` has no
open decision, and neither fork is Ben-only. A compaction summary fired the mandatory relay
tripwire, so this session must transfer authority before any further supervision or merge action.
The successor must re-adopt both owners, verify delivery of their hold instructions, route #1497
to Fable plan approval, and resolve #1517 against the issue's complete acceptance criteria.
Authority remains session `01a02e90-46d7-7093-bffd-5e2a4bb029dc` until the exact-session transfer
finishes. [pane w1:pPM]
