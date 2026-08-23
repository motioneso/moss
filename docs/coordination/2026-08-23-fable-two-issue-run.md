# Coordination Run — 2026-08-23-fable-two-issue

**Date:** 2026-08-23
**Coordinator lock:** registered agent name `coordinator` + visible pane label `Coordinator`, **stable anchor = Codex session id `01a02e90-46d7-7093-bffd-5e2a4bb029dc`** (match `agent_session.value` in `herdr agent list`). Exactly one live agent named `coordinator` whose session id matches this anchor holds authority. Pane ids are ephemeral; resolve agents fresh by name and immutable session id.
**Approval authority:** Fable holds delegated overnight run-scope and plan approval authority. Durable scope verdict: `~/Jarv1s/fable-next-run-verdict.md` — APPROVE.
**Merge policy:** autonomous after exact-head green QA for both routine lanes; #1497 also requires live-path proof.
**Relay threshold:** routine/sensitive `merges_since_relay` ≥ 2, context-meter warning, or compaction summary. No deferral.
**merges_since_relay:** 0

> GitHub project 2 is source of truth. This manifest holds only operational state.

## Queue

| Spec | Issue | Tier | Status | Agent name | Pane | Branch | PR |
| ---- | ----- | ---- | ------ | ---------- | ---- | ------ | -- |
| `docs/superpowers/specs/2026-08-10-1137-robustness-followups.md` | #1517 | routine | queued | — | — | `build/1517-evidence-escape` | — |
| `docs/superpowers/specs/2026-08-10-css-guard-residue.md` | #1497 | routine | queued | — | — | `build/1497-today-residue` | — |

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

- None.

## Reaped sessions

- Fable scope reviewer `fable-run-scope`, session `c359c706-e66d-4a52-b7c1-823ba3d315c6`: verdict consumed; reap pending manifest commit.
