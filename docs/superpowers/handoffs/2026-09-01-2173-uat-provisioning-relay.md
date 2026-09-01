# Relay handoff — issue 2173 UAT provisioning (relay 1 of 1 max)

Spec: `docs/superpowers/specs/2026-09-01-2173-uat-provisioning.md`
Plan: `docs/superpowers/plans/2026-09-01-2173-uat-provisioning.md` (coordinator-approved, no fork)
Issue: #2173, risk tier: security
Worktree/branch: this worktree, `fix/2173-uat-provisioning` off `origin/main`
Coordinator: registered agent name `coordinator` (confirm with `herdr agent list` before messaging —
do not guess a pane; re-resolve fresh)

## Done (committed)

- `8032ec69b` — added `captureFailureEvidence(projectName)` to `tests/uat/provisioner.ts` (private
  function, sits after `runCapture`, ~line 490) and wired it into `provisionForUat`'s terminal-failure
  branch (the non-retry `catch` path), immediately before `await cleanupAttempt({ error });`. Uses
  `buildUatComposeArgs` for Compose project + `jarv1s` service scoping — `docker compose ... logs
  --tail 50 jarv1s` and `docker compose ... ps jarv1s --format json`. Never the hardcoded `moss`
  container name, never a full `docker inspect`, never the settings file. Typechecks clean
  (`npx tsc --noEmit -p .` showed no provisioner.ts errors).
- `98c76a5f7` — the plan doc itself.

**Not yet done, not yet proven.** This commit is unverified — no test or real run has exercised it
yet. Treat it as a checkpoint, not a finished deliverable.

## Coordinator's exact approved build order (follow this, do not reorder)

1. ~~Add the evidence-capture code~~ (done, see above).
2. **Run the real cached-image repro once now, with the integrations key still missing**, and
   confirm the RED output shows the actual cause via the new bounded capture (the
   `JARVIS_INTEGRATIONS_SECRET_KEY is required in production` line from the real crash, plus the
   health status) — this is deliverable 2's only proof; no unit test for it (coordinator's lock:
   no synthetic truncation helper/test).
3. Extend `tests/unit/uat-provisioner.test.ts`'s `writeUatEnvFile` test (~line 205-230, the
   `"writes an env file pinning..."` test) with the two new assertions for
   `JARVIS_INTEGRATIONS_SECRET_KEY` (see plan doc's Task 1 for exact assertion text). Run
   `pnpm vitest run tests/unit/uat-provisioner.test.ts` and confirm RED (key still absent).
4. Add the one line to `writeUatEnvFile` in `tests/uat/provisioner.ts` (after the existing
   `JARVIS_NEWS_CREDENTIAL_SECRET_KEY` line, ~line 236):
   `"JARVIS_INTEGRATIONS_SECRET_KEY=33333333333333333333333333333333",`
   Fixed value only — not read from `process.env`, not added to `uatComposeInterpolationEnv`.
   Rerun the same vitest command, confirm GREEN.
5. Rerun the same cached-image repro once more (both fixes now in place). Confirm GREEN: no
   `unhealthy`, stack reaches `/health/ready`.
6. Commit by deliverable (evidence-capture commit already made in step 1 above — amend/extend
   commit history as needed per deliverable, or add a second commit for the key + test). Run the
   full gate via the `verify-gate` skill (`scripts/run-gate.sh start` then
   `scripts/run-gate.sh wait --follow` as a backgrounded call — never hand-roll, never pipe). Push
   (after the pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main`). Open a security-tier PR (do not merge). Post
   the two repro run tails (RED-with-evidence and GREEN) as the PR's live-path proof comment. Report
   PR link + evidence to the coordinator, then stop — coordinator owns QA/merge/board.

## Repro tooling already built (throwaway, not committed, in /tmp — survives this session)

- `/tmp/bug-2173/repro.ts` — the original diagnosis-comment repro (manually replays the compose
  plan steps; imports from a DIFFERENT, unrelated worktree path — do not reuse as-is).
- `/tmp/bug-2173/repro2.ts` — written this session, imports `provisionForUat` directly from THIS
  worktree's `tests/uat/provisioner.ts`, calls it with level `"bare"`, and relies on the new
  in-function `captureFailureEvidence` to print evidence via `console.error` before it throws. This
  is the one to run for step 2/5 above:
  ```bash
  npx tsx /tmp/bug-2173/repro2.ts
  ```
  Cached image confirmed present: `ghcr.io/motioneso/moss:uat-smoke` (no rebuild needed — set
  `JARVIS_UAT_BUILD=0` if `provisionForUat` tries to rebuild anyway; check
  `tests/uat/provisioner.ts` around line 850 for the `resolveMossEnv(..., "JARVIS_UAT_BUILD")`
  gate).
- `/tmp/bug-2173/comment.md`, `plan.md`, `run1.log`..`run3.log` — prior diagnosis artifacts, useful
  background, not required reading.

**Before running repro2.ts:** check `herdr pane list` / recent gate runs for a live UAT or gate
process from another session — concurrent UAT runs on the same host can collide (known trap, not
this issue's problem to fix). Stagger if one is active.

## Standing rules (unchanged from the original brief)

- Never run DB-touching gate commands outside `verify-gate`; never pipe a gate command.
- Plain English in every human-facing update (coordinator messages, PR body) — no jargon, name
  files/commands exactly where the coordinator or Ben must act on them.
- Never edit `docs/coordination/`. Never touch PR 2164 or 2101's feature branches (collision note).
- Stage explicit files only; this is a shared checkout — use `git diff <path>` to confirm every
  added line is yours before each commit (`shared-checkout` skill).
- Done means pushed branch + open PR, not merged.
- **This is relay 1. Do not relay again** — if the 70% warning fires again before the PR is open,
  push whatever is green, write the state, and report to the coordinator that the slice needs
  re-slicing instead of relaying.
