# Relay handoff #3 — #1468 target-identity-guard-extend

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md` (row #1468)
**Plan:** `docs/superpowers/plans/2026-08-16-1468-target-identity-guard-extend.md` (`8e9f4e71b`) — read Task 2 section only, not in full.
**Worktree/branch:** this worktree, branch `1468-target-identity-guard-extend`. `node_modules` present — do NOT `pnpm install`.
**Coordinator:** label `Coordinator` (agent `coordinator-take25`), session id `11cf8264-55a8-4fa4-b32b-c8d086469f74` — **resolve pane fresh via `herdr pane list` by label + session id, never a baked `…-N`**.
**Risk tier:** security.

## What's done

- **Task 1 committed green: `858d694cb`** — `scripts/rewrap-secrets.ts` (see relay2 doc for detail).
- **Task 3 committed green: `b303b2786`** — `scripts/restore-database.ts` now has `assertRestoreTargetIdentity`, `--confirm-owner-email`/`--allow-empty-target` flags, wired into `main()` after `access(plan.backupFile)`. Tests added to `tests/integration/release-hardening.test.ts` (4 new cases: mismatch rejects, match resolves, no-owner rejects unless `allowEmptyTarget`, same state with flag resolves null). Verified against scratch gate DB `jarvis_gate_1468t3_*` — 21/22 pass; the 1 failure (`DELETE /api/admin/users/:id ...`, missing `dist/app-map.json`) is pre-existing/unrelated — confirmed via `git diff --stat` showing only the 2 files this task touched. Gate DB dropped after.

## What's NOT done — resume here (Task 2 only, last task)

**Task 2 — `scripts/module-reconcile.ts`.** Read plan's "## Task 2" section for the original draft context, **but build it with the coordinator's 4 required changes below, not the plan's original draft** (the plan draft's fresh-install exception was too loose — this is the adjudicated fix):

- (a) Only take the "fresh install" exception if the connected role is superuser, has `rolbypassrls`, or owns `app.users` — refuse otherwise.
- (b) Require `app.users` to be genuinely empty (`COUNT(*) = 0`), not just "no bootstrap-owner row found".
- (c) Rename the concept in code/comments from "fresh install" to **"un-provisioned target"** — state both conditions (role check + empty table) explicitly in the name/comments.
- (d) Add a regression test: table populated but the owner query returns nothing (e.g. a row exists but `is_bootstrap_owner` is false/missing) → guard must still refuse, not take the exception.

New exported `assertReconcileTargetIdentity(client)` — raw `pg.Client` (imported as `Client` in this file), **not** Kysely — do NOT add a `@moss/db` Kysely connection to this script; import only `TargetIdentityMismatchError` type/class from `@moss/db` (already exported per `packages/db/src/index.ts:16` re-exporting `target-identity-guard.js`). Call `await assertReconcileTargetIdentity(client)` immediately after `await client.connect()` (`scripts/module-reconcile.ts:129`), before the Phase 0 advisory lock (line 135). Errors propagate uncaught out of `reconcileModules` so the CLI's existing `.catch` (~line 407-410) exits non-zero.

**Confirming the role-check details before you build:** you'll need to determine how to query "is the connected role superuser / has rolbypassrls / owns app.users" from a raw `pg.Client` — likely `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user` plus a check against `app.users`' owner (e.g. `SELECT tableowner FROM pg_tables WHERE schemaname='app' AND tablename='users'`, compare to `current_user`). Read `scripts/module-reconcile.ts` lines 1-140 (already read this relay — connect/lock pattern is there) plus check `packages/db/src/target-identity-guard.ts` for the `TargetIdentityMismatchError`/`NoBootstrapOwnerFoundError` shape (do NOT reuse `NoBootstrapOwnerFoundError` here per the plan — Task 2's original draft says throw `TargetIdentityMismatchError` on mismatch/unset, reused as-is, no new error type — reconcile with the coordinator's 4 changes: the "un-provisioned" pass-through is a *new* code path, not the existing owner-lookup — so on failing the un-provisioned check, refusing likely still throws `TargetIdentityMismatchError`, but confirm this reads sensibly when you write it; if genuinely ambiguous, escalate to the coordinator rather than guess).

Confirm via `JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL` (via `resolveMossEnv(env, "JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL")`, `ReconcileModulesOptions.env` already threads a test-injectable env, no new option needed) against the bootstrap owner's email when the target is NOT un-provisioned.

New test file `tests/integration/module-reconcile-target-guard.test.ts` (live-DB, mirrors `packages/db/src/__tests__/target-identity-guard.test.ts` fixture pattern — seed via raw `pg.Client` against `connectionStrings.bootstrap`, see `tests/integration/test-database.ts` for `connectionStrings`/`ids`). Cases needed:
1. Un-provisioned target (role check + empty `app.users`) → resolves without requiring the env var.
2. `JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL` unset, owner exists → rejects.
3. Env var set to mismatched value, owner exists → rejects.
4. Env var matching owner's actual email → resolves.
5. **(d) New regression case:** table populated (rows exist) but no row has `is_bootstrap_owner = true` → guard must still REFUSE (not take the un-provisioned exception) — this is the coordinator's required addition, distinguishing "empty table" from "populated table, no owner flagged".

TDD via `superpowers:test-driven-development`. `git add`/`git commit` by explicit path only (re-check `herdr pane list` for other sessions in this worktree before committing — was clean when Task 3 committed).

Verification: `pnpm vitest run tests/integration/module-reconcile-target-guard.test.ts 2>&1 | cat; echo "EXIT=${PIPESTATUS[0]}"` inside a scratch gate DB (see `verify-gate` skill — `docker exec jarv1s-postgres psql -U postgres -c "CREATE DATABASE jarvis_gate_<slug>;"`, `export JARVIS_PGDATABASE=...`, migrate, run, `DROP DATABASE` after). Note: this test needs `app.users` to exist with real ownership/role metadata (`pg_tables`/`pg_roles` queries) — the standard `resetEmptyFoundationDatabase()` + migrations flow from `test-database.ts` should already produce a normal owned table; don't assume, verify what role owns `app.users` in your scratch DB before writing the "un-provisioned via role check" test case (may need to test the role-check branch by connecting as a non-privileged role, or by checking the code path is reachable given how migrations create `app.users` — read the actual behavior, don't guess).

**Operational note (do this before opening the PR, not as a PR-body footnote):** `JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL` isn't set in any deployment today — merging Task 2 alone breaks module-install on Ben's next prod redeploy (non-zero exit, guard fails closed with no confirmation and a populated `app.users`). **Message the coordinator with this explicitly and wait for it to loop in Ben on the companion compose/env change** before opening the PR. Hard requirement from the coordinator's adjudicated verdict, not optional.

## After Task 2 is green

- Pre-push trio: `pnpm format:check && pnpm lint && pnpm typecheck` (unpiped, check exit codes) then `git fetch origin main && git rebase origin/main`.
- Escalate the Task 2 deployment-env gap to the coordinator (above) if not already done.
- Invoke `coordinated-wrap-up`: full gate DB run via `verify-gate` skill (fresh scratch DB, drop when done), push, open PR.
- Internal-only ops-tooling — no live-path/UAT proof needed; say so explicitly in the PR body, plus a one-sentence release-note line.
- Report the PR + evidence + the Task 2 env-var deployment gap to the coordinator. **Stop there** — merge, board update, issue close, Ben loop-in are the coordinator's.

## Traps already avoided — don't re-trip these

- Read spec/plan **by section**, never in full.
- `module-reconcile.ts` uses a raw `pg.Client`, not Kysely — import only `TargetIdentityMismatchError` type/class from `@moss/db`.
- Root tests (`tests/integration/*`, `tests/unit/*`) run via root `pnpm vitest run <path>`, **never** `pnpm --filter <pkg> test`.
- Never pipe a verification command losing exit code — `2>&1 | cat; echo "EXIT=${PIPESTATUS[0]}"` form.
- Do not touch `packages/db/src/target-identity-guard.ts`, `admin-reset-password.ts`, `delete-user-data-cli.ts`, or `infra/docker-compose.prod.yml`.
- **Gate-DB isolation:** any live-DB test run needs its own scratch DB. Never run against the default/live dev DB.
- Relay on the context-meter 70% warning or immediately on a compaction summary — don't invent a higher personal threshold.
