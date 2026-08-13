# Build Handoff — 1248-vault-ingestion

**GitHub issue:** #1248. **Spec + plan already approved and on `main`:**
`docs/superpowers/specs/2026-08-12-1248-vault-ingestion.md` and
`docs/superpowers/plans/2026-08-12-1248-vault-ingestion.md` (Fable, authored per `plan-build`).
**Read the plan before anything else — this lane skips the draft-plan-and-wait-for-review step
that the other lanes tonight require; the review already happened.**
**Risk tier:** `sensitive` (not security) — no auth/RLS/credential surface per the spec; standard
QA + matched e2e-UAT + per-merge digest to Ben, no sign-off pause required. Reassess as `security`
if the build touches anything the spec didn't anticipate.
**Sequencing constraint (binding, from the plan):** 3 phases. Phase 1–2 are independent of #1556.
**Phase 3 is blocked until #1556's retrieval phase merges to `main`, and must not touch the port
while #1556 is mid-build.** #1556-P2 is still active in `.claude/worktrees/1556-notes-retrieval`
(pane `w1:p8S`) — check the manifest / ask the Coordinator before starting Phase 3, don't assume.
**Kill gate:** after Phase 1, owner Ben, evaluated after a day on dev — do not self-evaluate this
gate, flag it to the Coordinator when Phase 1 lands.
**Worktree:** `.claude/worktrees/1248-vault-ingestion` **Branch:** `1248-vault-ingestion` (off `origin/main` @ `513672aa5`)
**Coordinator label:** `Coordinator` — resolve fresh via `herdr pane list`.
**Coordinator session id:** `caef4e32-df22-4310-a42d-866771a0ba6c`
**Plan author/reviewer for questions:** pane labelled `spec-1248 (Fable)` / `spec-1248-fable`.

## Start

1. `[ -d node_modules ] || pnpm install`.
2. Read the plan doc, Phase 1 only, in full. Do not read Phase 2/3 yet.
3. Build Phase 1 per `coordinated-build`, TDD, commit per step, matched e2e for the phase.
4. Report Phase 1 done to the Coordinator and STOP — do not start Phase 2 until told to (kill
   gate is Ben's, evaluated after a day on dev; the Coordinator will relay the call).

## Exit criteria (per phase)

- Each phase ships its own observed-passing e2e test (per `plan-build`).
- Full gate green on an isolated gate DB (`verify-gate` skill).
- PR open, rebased on `origin/main`, tagged with tier.
- Live-path proof required if the phase adds a user-facing surface — check the plan's own
  criteria per phase, it should say.

## Run-specific bans

- Work only in this worktree/branch; `git add` by explicit path.
- Never touch `docs/coordination/`, the project board, or merge anything yourself.
- No secrets in any doc, payload, log, or prompt.
- Do not touch the port sequencing described above until #1556 is confirmed merged to `main`.

## Collision notes

- Phase 3 / port work collides with #1556 until #1556 lands — see sequencing constraint above.
- No other collisions with tonight's 4 other lanes (#1489, #943, #1141, #1591).
