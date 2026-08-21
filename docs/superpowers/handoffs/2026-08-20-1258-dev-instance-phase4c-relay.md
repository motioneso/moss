# Relay: #1258 dev-instance provisioning, Phase 4 (continued again)

Written 2026-08-20 by the session that did T20 and T21, on hitting the context-meter 70% warning.
Read this instead of the earlier Phase 4 relay docs, which are now stale.

## Where the work lives

- Issue **#1258**. Branch **build-1258-dev-instance-provisioning**, in the shared checkout
  `~/Jarv1s` — use the `shared-checkout` skill before every commit.
- Spec: `docs/superpowers/specs/2026-08-19-1258-dev-instance-provisioning.md`
- Plan: `docs/superpowers/plans/2026-08-19-1258-dev-instance-provisioning.md`, Phase 4 section
  (around line 671). Read by section, not front to back.
- Coordinator: the Herdr pane labelled **Overnight Coordinator**. Re-resolve its pane number fresh
  with `herdr pane list` every time — do not trust a written pane number.
- No fresh plan-approval message needed — this phase runs against the already-approved plan.
- `node_modules` already exists — do not run `pnpm install`.

## What is done in this phase so far

**T19 — committed (`746e265d5`).** The CLI entry point `scripts/dev-instance.ts` with guard
ordering. Done by an earlier session.

**T20 — committed (`ab89fdf83`).** New file `tests/unit/dev-instance-not-bundled.test.ts`: walks
the real import graph from `apps/api/src/server.ts` and `apps/worker/src/worker.ts` and asserts
neither ever reaches `scripts/dev-instance`. Green: `npx vitest run
tests/unit/dev-instance-not-bundled.test.ts` (2 passed), `npx tsc --noEmit -p tsconfig.json`
(exit 0). **Not yet pushed to a PR** — no PR exists yet for this phase.

**T21 — code written, not yet committed.** New file `scripts/dev-instance/fix.ts` exports
`runFix(deps, report)`. It always returns two outcomes (`flag-instance-default`,
`purge-uat-fixture-rows`) but only touches the database for whichever check the given report
names as failing — on a healthy report both outcomes come back `changed:false` with nothing
written. `scripts/dev-instance.ts`'s `"fix"` case is now wired for real (mirrors `"doctor"`: runs
`runDoctor`, then `runFix`, logs each outcome) — the `"fix"` case is no longer in the deferred
list, only `"providers"`/`"reset"` still are.

Tests added to `tests/integration/dev-instance-doctor.test.ts` (three new cases under a
`describe("runFix", …)` block near the end): two-providers-none-flagged → flags one and
`runDoctor` then passes; UAT fixture rows present → purges and the check passes afterward;
healthy database → every outcome `changed:false`.

`npx tsc --noEmit -p tsconfig.json` is clean (exit 0) as of this write.

**Integration test run in flight, not yet confirmed green.** I started (background, in this same
worktree) a scoped run against a fresh gate database:
```
GATEDB=jarvis_gate_1258p3   # already DROP+CREATEd this run — reuse as-is, or DROP+CREATE again if
                             # your session doesn't share the same shell state
export JARVIS_PGDATABASE=jarvis_gate_1258p3
pnpm test:integration -- tests/integration/dev-instance-doctor.test.ts
```
Output file: `/tmp/t21-doctor-int.log` (in this same session's filesystem — check it first; if
it's gone or the process died, just re-run the command above, DROP+CREATE the gate DB first).
**Your first move: check that log, confirm the run finished, confirm it's green.** If it's still
running, wait on it (bounded, not a blocking sleep loop) rather than re-launching a second one —
concurrent runs against the same gate DB will collide.

Once green: commit `scripts/dev-instance/fix.ts`, the `scripts/dev-instance.ts` wiring change, and
the three new integration test cases together as T21. Diff each shared file (`dev-instance.ts` and
the integration test file) before committing — confirm every added line is yours — then commit by
explicit path, then `git show --name-only HEAD` to confirm the file list.

## What is left — T22 (not started)

Condensed from the plan; full detail in `docs/superpowers/plans/2026-08-19-1258-dev-instance-provisioning.md`
Phase 4 section if you need it.

1. Add to `package.json` `"scripts"`:
   `"dev:instance": "tsx scripts/dev-instance.ts"` and
   `"db:reset": "pnpm db:down && pnpm db:up && pnpm db:migrate && pnpm dev:instance provision"`.
   **Not yet added — check `grep -n '"dev:instance"\|"db:reset"' package.json` returns nothing
   before you add them, in case a parallel session already did.**
2. **Nine doc lines already updated to recommend `pnpm db:reset` instead of `pnpm db:down` — this
   part of T22 is DONE, uncommitted.** Files touched (all uncommitted, all safe to commit as-is,
   no need to re-verify): `docs/archive/HANDOFF-memory-foundation.md`,
   `docs/coordination/2026-06-13-phase2-5-test-plan.md`,
   `docs/superpowers/handoffs/2026-06-18-onboarding-service-testing-webwright.md`,
   `docs/superpowers/plans/2026-06-06-slice-1b-tasks-owner-or-share.md` (two spots),
   `docs/superpowers/plans/2026-06-07-slice-3-memory-index.md` (three spots),
   `docs/superpowers/plans/2026-06-06-slice-1c-core-calendar-email-connectors-ai.md` (two spots),
   `docs/superpowers/plans/2026-06-07-slice-4-structured-state.md`,
   `docs/superpowers/plans/2026-06-13-p5-wellness-module.md`.
   Two lines were deliberately left alone (do not touch them):
   `docs/coordination/2026-06-13-overnight-phase2-5-log.md:119` and
   `docs/architecture/plans/0004-m7-operations-verification-plan.md:124`.
3. Once the `package.json` scripts exist, commit the doc edits + package.json together as T22.
4. In the PR body, note as an operator step: deleting the host file
   `~/.config/jarv1s/uat/anthropic-real-chat.env.gpg` (spec Decision 4) — not a repo file, not a
   commit, just a note for whoever runs the PR's live-path proof.

## After T22 — wrap-up

Once T20-T22 are all committed and green (type-check + the two unit/integration test files —
**not** the full `pnpm verify:foundation`, see Ground rules below), use `coordinated-wrap-up` to
open the PR. Phase 5 is deliberately deferred — do not start it.

## Facts you would otherwise have to rediscover

- All of Phase 1-3 plus T19 is done and green. Only T21 (in progress) and T22 (partly done) are
  left before this phase can go to PR.
- The socket directory question is settled — nothing to escalate there.
- The tool deliberately never takes root and never waits indefinitely on anything.
- `scripts/dev-instance/secrets.ts:49`'s `gpg --batch` question is still open, still sitting with
  the coordinator for Fable. Don't touch it.
- Gate database `jarvis_gate_1258p3` is this phase's throwaway DB — reuse it (DROP + CREATE each
  run), drop it when Phase 4 is fully finished (after the PR's gate run, not before).

## Ground rules that still apply

- Shared checkout: never `git add -A`/`git add .`, never a bare `git commit`. Diff shared files,
  commit by explicit path, confirm with `git show --name-only HEAD`.
- Never run the full gate (`pnpm verify:foundation`) or any database-touching test without the
  `verify-gate` skill's DROP+CREATE-a-fresh-DB, `export` (not inline), never-piped discipline.
  The full gate still fails at its first check for a reason unrelated to this branch — don't fix
  it, don't work around it — run type-check and tests directly for real signal instead.
- Never bypass the database privacy rule — read data back as the real identity that owns it.
- Every PR fills in the Release note section of the template.
- Nothing merges tonight and #1258 is not marked done without both a green gate and a live proof
  through the real interface on a live dev instance. If you reach all-green without that proof,
  say so plainly — *code-complete, unverified* — and leave the PR open.
- Real product/architecture forks go to the coordinator for Fable. Ben is asleep — do not wake him.
- Report real progress to the coordinator as you go — do not go quiet for 40+ minutes. When you
  start something long, give the coordinator the output file path in the same message.
- Plain English to every human and to the coordinator: name things by what they do, not by
  what the repo calls them; keep exact names only where someone must act on one (a command, a
  file, an error string). Pass this instruction on to every agent you spawn.
- Your own relay trigger is the context-meter 70% warning — not a felt percentage, not a
  self-invented higher bar.
