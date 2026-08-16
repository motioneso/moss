# Relay handoff #2 — #1468 target-identity-guard-extend

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md` (row #1468)
**Plan:** `docs/superpowers/plans/2026-08-16-1468-target-identity-guard-extend.md` (`8e9f4e71b`) — read Task 3 / Task 2 sections only, not in full.
**Worktree/branch:** this worktree, branch `1468-target-identity-guard-extend`. `node_modules` present — do NOT `pnpm install`.
**Coordinator:** label `Coordinator` (currently named agent `coordinator-take25`), session id `11cf8264-55a8-4fa4-b32b-c8d086469f74` — **resolve pane fresh via `herdr pane list` by label + session id, never a baked `…-N`**.
**Risk tier:** security.

## What's done

- Plan approved by coordinator. Design-fork verdict for Task 2 (module-reconcile.ts) received — **APPROVE WITH CHANGES**, 4 required changes (see below). Task 1/3 cleared to build regardless.
- **Task 1 committed green: `858d694cb`** — `scripts/rewrap-secrets.ts` now has `--confirm-owner-email`, exported `assertRewrapTargetIdentity`, entrypoint guard added (script had none — needed one so importing the export for tests doesn't trigger a live run), test `tests/unit/rewrap-secrets-guard.test.ts` passing (verified against a scratch gate DB `jarvis_gate_1468t1_*`, migrated, then dropped — rc=0).

## What's NOT done — resume here

1. **Task 3 next** — `scripts/restore-database.ts`. Full spec is in the plan under "## Task 3" (read that section only): new `assertRestoreTargetIdentity` function, new `--confirm-owner-email`/`--allow-empty-target` flags, tests extend `tests/integration/release-hardening.test.ts`. Note: `restore-database.ts` **already has** an entrypoint guard (`if (process.argv[1] && fileURLToPath(...) === resolve(process.argv[1])) { await main(); }`) — unlike `rewrap-secrets.ts`, so no extra fix needed there. TDD via `superpowers:test-driven-development`, commit green, `git add` by explicit path only (this worktree currently has no other session in it — confirmed via `herdr pane list` — but re-check before committing per `shared-checkout` skill anyway).

2. **Task 2 last** — `scripts/module-reconcile.ts`. Full spec under "## Task 2" in the plan, **but build it with the coordinator's 4 required changes, not the plan's original draft**:
   - (a) Only take the "fresh install" exception if the connected role is superuser, has `rolbypassrls`, or owns `app.users` — refuse otherwise.
   - (b) Require `app.users` to be genuinely empty (`COUNT(*) = 0`), not just "no bootstrap-owner row found".
   - (c) Rename the concept in code/comments from "fresh install" to **"un-provisioned target"** — state both conditions (role check + empty table) explicitly in the name/comments.
   - (d) Add a regression test: table populated but the owner query returns nothing (e.g. a row exists but `is_bootstrap_owner` is false/missing) → guard must still refuse, not take the exception.
   - New exported `assertReconcileTargetIdentity(client)` (raw `pg.Client`, not Kysely — do NOT add a `@moss/db` Kysely connection to this script; import only the `TargetIdentityMismatchError` type/class from `@moss/db`), called right after `client.connect()`. New test file `tests/integration/module-reconcile-target-guard.test.ts`. TDD, commit.
   - **Operational note (do this before opening the PR, not as a PR-body footnote):** `JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL` isn't set in any deployment today — merging Task 2 alone breaks module-install on Ben's next prod redeploy (non-zero exit, since the guard fails closed with no confirmation and a populated `app.users`). **Message the coordinator with this explicitly and wait for it to loop in Ben on the companion compose/env change** before opening the PR. This is a hard requirement from the coordinator's adjudicated verdict, not optional.

3. **After all three tasks are green:**
   - Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck` (unpiped, check exit codes) then `git fetch origin main && git rebase origin/main`.
   - Escalate the Task 2 deployment-env gap to the coordinator (see above) — do this before wrap-up if not already done.
   - Invoke `coordinated-wrap-up`: gate DB run via `verify-gate` skill (fresh scratch DB, drop when done — same pattern used for Task 1's task-local check, scale up to the full `pnpm verify:foundation` this time), push, open PR.
   - Internal-only ops-tooling — no live-path/UAT proof needed; say so explicitly in the PR body, plus a one-sentence release-note line.
   - Report the PR + evidence + the Task 2 env-var deployment gap to the coordinator. **Stop there** — merge, board update, issue close, Ben loop-in are the coordinator's.

## Traps already avoided — don't re-trip these

- Read spec/plan **by section**, never in full.
- `module-reconcile.ts` uses a raw `pg.Client`, not Kysely — import only `TargetIdentityMismatchError` type/class from `@moss/db`.
- Root tests (`tests/integration/*`, `tests/unit/*`) run via root `pnpm vitest run <path>`, **never** `pnpm --filter <pkg> test` — the plan's Task 1 verification line says `--filter @moss/db`, that's stale/wrong, ignore it.
- Never pipe a verification command losing exit code — `2>&1 | cat; echo "EXIT=${PIPESTATUS[0]}"` or the `(...; echo rc=$?) > log` form.
- Do not touch `packages/db/src/target-identity-guard.ts` or `admin-reset-password.ts`/`delete-user-data-cli.ts` — wiring three new callers only.
- Do not touch `infra/docker-compose.prod.yml` — env-var requirement is a coordinator/Ben follow-up, not a code change in this lane.
- **Gate-DB isolation:** any live-DB test run needs its own scratch DB (`docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE jarvis_gate_<slug>;"`, `export JARVIS_PGDATABASE=...`, `pnpm db:migrate`, run test, then `DROP DATABASE`). Never run against the default/live dev DB.

## Relay trigger for you too

Same rule: relay on the context-meter 70% warning or immediately on seeing a compaction summary — don't invent a higher personal threshold. If you relay before finishing, update this doc (or write a new dated one) with fresh state before spawning your own successor.
