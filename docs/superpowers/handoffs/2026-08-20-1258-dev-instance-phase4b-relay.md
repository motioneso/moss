# Relay: #1258 dev-instance provisioning, Phase 4 (continued)

Written 2026-08-20 by the Phase 4 build session, on hitting the context-meter 70% warning after
one task. Read this instead of the earlier Phase 4 relay doc, which is now partly stale.

## Where the work lives

- Issue: **#1258**. Branch: **build-1258-dev-instance-provisioning**, in the main checkout
  `~/Jarv1s` (shared with other live sessions — use the `shared-checkout` skill before every
  commit).
- Spec: `docs/superpowers/specs/2026-08-19-1258-dev-instance-provisioning.md`
- Plan: `docs/superpowers/plans/2026-08-19-1258-dev-instance-provisioning.md`. Read it **by
  section**, never front to back. Phase 4 is "### Phase 4" (around line 671); the exact type
  signatures are under "## 5. Contracts" (around line 213) — the `doctor.ts`, `provision.ts`,
  `cli-runner.ts`, `cli-token.ts`, `secrets.ts`, `config.ts` sub-sections are all already built and
  you can read the real files under `scripts/dev-instance/` instead of the plan's copy of their
  shape.
- Coordinator: the Herdr pane labelled **Overnight Coordinator**. Resolve its pane number fresh
  every time with `herdr pane list` — pane numbers reflow. I told it, before relaying, that T19 was
  done and I was handing off; no reply needed, no blocker open.
- No fresh plan-approval message is needed — the coordinator already knows this phase is running
  against the existing approved plan, not a new plan doc.

`node_modules` already exists — do **not** run `pnpm install`.

## What is done in this phase so far

**T19 — committed, commit `746e265d5`.** `scripts/dev-instance.ts` now exports
`runDevInstanceCli(argv, env)`: parses the command, then `assertDevEnvParity(env)`, then resolves
the database URLs, then `assertTargetIsDevInstance(urls.app)`, then opens the two database handles,
then dispatches. `process.exit` only happens in the self-invoke guard at the bottom of the file.
The `"fix"`, `"providers"`, and `"reset"` commands currently just print "not implemented yet" and
return 1 — `"fix"` is deliberately left unwired because `scripts/dev-instance/fix.ts` doesn't exist
yet (that's your first job, T21). `"doctor"` and `"provision"` are wired for real.

Test added: a new `describe("runDevInstanceCli guard ordering", …)` block appended to the existing
`tests/unit/dev-instance-guard.test.ts` (T19's test lives in the same file as the guard unit tests,
per the plan — don't create a second file with that name). It points `JARVIS_PGHOST` at
`192.0.2.1` (a reserved, guaranteed-unreachable test address) with `NODE_ENV` set, and asserts the
CLI returns non-zero with a message naming `NODE_ENV`, proving the parity check fired before any
connection attempt. Green: `npx vitest run tests/unit/dev-instance-guard.test.ts` (10 passed),
`npx tsc --noEmit -p tsconfig.json` (exit 0).

## What is left — T20, T21, T22

Full detail is in the plan's Phase 4 section and Contracts section (see above) — this is the
condensed version so you don't have to re-read either in full.

**T20 — prove the dev CLI never ships in the real app.**
New file `tests/unit/dev-instance-not-bundled.test.ts`. Statically check that neither
`apps/api/src/server.ts` nor `apps/worker/src/worker.ts` reaches `scripts/dev-instance` anywhere in
their import graph — walk imports from those two entry files (a small recursive import-graph
walker over the TypeScript source, not a build step) and assert no visited file path contains
`scripts/dev-instance`. This is a static assertion over source, so it runs without building
anything.

**T21 — `scripts/dev-instance/fix.ts`.**
New file, contract already fixed in the plan:
```ts
export type FixActionId = "flag-instance-default" | "purge-uat-fixture-rows";
export interface FixOutcome { readonly id: FixActionId; readonly changed: boolean; readonly detail: string; }
export async function runFix(deps: DoctorDeps, report: DoctorReport): Promise<readonly FixOutcome[]>;
```
It acts only on defects the report actually names — never repairs speculatively. Two actions:
flag exactly one provider as the instance default when the `single-instance-default-provider`
check failed (use `AiRepository` the same way `doctor-checks.ts` does — read it for the pattern),
and purge the UAT fixture rows named in `tests/uat/seed/admin.ts` when `no-uat-fixture-rows`
failed. On a healthy report (all checks passing), every action reports `changed:false` and writes
nothing.

Tests go in the existing `tests/integration/dev-instance-doctor.test.ts` (read it first — it
already has the `insertUser`, `deps()`, `fakeConfig()` helpers you need, and the `AiRepository`
patterns for creating providers). Add cases: two active providers/none flagged default → `runFix`
flags exactly one and a following `runDoctor` passes that check; UAT fixture rows present →
`runFix` purges them and the check passes afterward; healthy database → every outcome
`changed:false`, nothing written.

Once `fix.ts` exists, go back to `scripts/dev-instance.ts` and wire the `"fix"` case for real
(mirror the `"doctor"` case: run `runDoctor`, then `runFix(doctorDeps, report)`, log each outcome).

**T22 — package.json + nine doc hits + PR note.** Not test-driven (config and prose).
- Add to `package.json` scripts:
  `"dev:instance": "tsx scripts/dev-instance.ts"` and
  `"db:reset": "pnpm db:down && pnpm db:up && pnpm db:migrate && pnpm dev:instance provision"`.
- Update these nine doc lines to recommend `pnpm db:reset` instead of `pnpm db:down`:
  `docs/archive/HANDOFF-memory-foundation.md:96`,
  `docs/coordination/2026-06-13-phase2-5-test-plan.md:49`,
  `docs/superpowers/handoffs/2026-06-18-onboarding-service-testing-webwright.md:146`,
  `docs/superpowers/plans/2026-06-06-slice-1b-tasks-owner-or-share.md:53,420`,
  `docs/superpowers/plans/2026-06-07-slice-3-memory-index.md:11,197,1556`,
  `docs/superpowers/plans/2026-06-06-slice-1c-core-calendar-email-connectors-ai.md:62,532`,
  `docs/superpowers/plans/2026-06-07-slice-4-structured-state.md:1483`,
  `docs/superpowers/plans/2026-06-13-p5-wellness-module.md:5424`.
  I already spot-checked all fourteen candidate lines (the nine plus the two to leave alone plus
  the "leave alone" ones below) on 2026-08-20 and they still match — go ahead and edit without
  re-verifying.
- Leave alone: `docs/coordination/2026-06-13-overnight-phase2-5-log.md:119` (it's a prohibition,
  not a recommendation) and `docs/architecture/plans/0004-m7-operations-verification-plan.md:124`
  (different script, `spike:db:down`).
- In the PR body, record as an operator step: the deletion of the host file
  `~/.config/jarv1s/uat/anthropic-real-chat.env.gpg` (spec Decision 4) — this is not a repo file
  and not a commit, just a note for whoever runs the PR's live-path proof.

## Facts you would otherwise have to rediscover

- **All of Phase 1-3 plus T19 is done and green.** `doctor`, the database half of `provision`, the
  file half of `provision` (cli-runner probe/start, cli-token persistence), and now the CLI entry
  point that wires guard ordering. `scripts/dev-instance/{guard,config,secrets,doctor,
  doctor-checks,provision,signup,cli-runner,cli-token}.ts` all exist and are wired into
  `scripts/dev-instance.ts`. Only `fix.ts` is still missing.
- **The socket directory question is settled** — `/run/jarv1s` exists on this host and survives
  reboot. Nothing to escalate there.
- **The tool deliberately never takes root**, and never waits indefinitely on anything (see
  `cli-runner.ts`'s bounded probe). If Phase 4 work tempts you toward either, stop — those were
  already ruled on for Phase 3 and the ruling carries forward.
- **`scripts/dev-instance/secrets.ts:49`'s `gpg --batch` question is still open, still not yours to
  decide**, still sitting with the coordinator for Fable. Don't touch it.
- Throwaway gate database `jarvis_gate_1258p3` still exists from earlier phases — reuse it (DROP +
  CREATE each run) and drop it when Phase 4 is fully finished.

## Ground rules that still apply

- **Shared checkout.** Never `git add -A`/`git add .`, never a bare `git commit`. Diff any file you
  didn't create before committing it, commit by explicit path, then `git show --name-only HEAD` to
  confirm the file list is exactly yours. Leave the stray root-level `make-admin.ts` and anything
  else you didn't create alone.
- **Never run the full gate or any database-touching test without the `verify-gate` skill.** Write
  gate output to a file with a `### FINAL rc=$?` sentinel; never pipe it.
- The full gate still fails at its first check for a reason unrelated to this branch (with Fable).
  Don't fix it, don't work around it — run type-check and tests directly for real signal.
- **Never bypass the database privacy rule** — read data back as the real identity that owns it.
- Every PR fills in the Release note section of the template.
- **Nothing merges tonight and #1258 is not marked done** without both a green gate and a live
  proof through the real interface on a live dev instance. If you reach all-green without that
  proof, say so plainly — *code-complete, unverified* — and leave the PR open.
- Real product or architecture forks go to the coordinator for Fable. Ben is asleep — do not wake
  him.
- Report real progress to the coordinator as you go — do not go quiet for 40+ minutes. When you
  start something long, give the coordinator the output file path in the same message.
- **Plain English to every human and to the coordinator.** Name things by what they do, not by
  what the repo calls them. Keep exact names only where someone must act on them — a command to
  run, a file to open, an error to search for. Pass this instruction on to every agent you spawn.
- Your own relay trigger is the context-meter 70% warning — not a felt percentage, and not a higher
  bar you set for yourself.
