# Plan — #1468: extend target-identity guard to three operator scripts

**Spec:** `docs/superpowers/specs/2026-08-16-post1632-wave2-privacy-tests-and-target-guard.md` (row #1468)
**Issue:** #1468 (part of the post-#1632 wave-2 run)
**Risk tier:** security

## Seams check (file:line)

- Guard: `packages/db/src/target-identity-guard.ts:42` — `assertOperatorConfirmsTargetOwner(db, confirmedOwnerEmail)`, returns `{id, email}` or throws `NoBootstrapOwnerFoundError` / `TargetIdentityMismatchError`. Public export: `packages/db/src/index.ts:15`.
- Precedent CLI wiring (execute-only gate): `scripts/delete-user-data-cli.ts:51-61`, `scripts/admin-reset-password.ts:36-41`.
- Precedent flag-parsing helpers (`readFlag`/`readOptionalFlag`): `scripts/delete-user-data-cli.ts:102-115`, `scripts/restore-database.ts:130-142`.
- Guard's own regression tests (pattern to mirror, not touch): `packages/db/src/__tests__/target-identity-guard.test.ts:33-126`.
- `scripts/rewrap-secrets.ts:27-170` — no `--execute`/dry-run flag today; always mutates. Connects via `getMossDatabaseUrls().bootstrap` (`scripts/rewrap-secrets.ts:28`).
- `scripts/module-reconcile.ts:396-411` — CLI entry calls `reconcileModules({modulesDir})`; wired into container boot as the `module-install` compose service, **not interactive**: `infra/docker-compose.prod.yml:58-71` (`command: ["node_modules/.bin/tsx", "scripts/module-reconcile.ts"]`, no args). No dry-run concept exists in this script.
- `scripts/restore-database.ts:30-97` — `createRestorePlan` (pure, already unit-tested at `tests/integration/release-hardening.test.ts:437-560`) already has `--execute`/`--confirm-restore`/`--confirm-database`. Guard call belongs in `main()` (`scripts/restore-database.ts:99-119`), before `runCommandFromFile` (the first mutating action — `pg_restore --clean --if-exists`).
- Table-existence check idiom for the empty-target case: `to_regclass` — used at `tests/integration/module-distribution.e2e.test.ts` and `tests/integration/foundation-schema-catalog.test.ts` (grep confirms no other production code path does this yet; this plan introduces the first production use, matching an established test idiom rather than inventing one).
- `packages/db/src/types.ts:37` — `UsersTable`/`MossDatabase` shape used by the guard.

## Open question — module-reconcile.ts (escalated to coordinator before build)

The other two scripts are always operator-run from a terminal (a human is present to type `--confirm-owner-email` or answer a prompt). `module-reconcile.ts` is **not**: it runs once per container start, before the API boots, with zero CLI args, wired straight into `infra/docker-compose.prod.yml`'s `module-install` service. There is no dry-run/execute split to gate on (spec's "execute/non-dry-run path only" phrasing doesn't map onto this script), and requiring an interactive flag would break every automated boot/redeploy.

Recommended design (built into Task 2 below, held for coordinator sign-off):

- Read confirmation from an env var, not a CLI flag: `JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL` (via `resolveMossEnv`, same helper already used in this file at `scripts/module-reconcile.ts:157`).
- Guard call sits right after `client.connect()`, before Phase 0's advisory lock (`scripts/module-reconcile.ts:120-127`) — earliest point, before any mutation.
- **Fresh-install exception:** unlike `restore-database.ts`, "no bootstrap owner yet" is the _normal_ state for every brand-new Moss instance's first boot (nobody has signed up yet). Blocking first boot on this would break every fresh install permanently. So: if no bootstrap owner exists, proceed without confirmation (this one caller doesn't need the `restore-database.ts`-style explicit opt-out, because there's nothing yet to mis-target). If a bootstrap owner **does** exist, require the env var and require it to match, exactly like the other two scripts, and exit non-zero (matching this script's existing "only lock/connection failures exit non-zero" failure model, not the per-module warn-and-continue model) — a wrong target here is not a per-module failure, it's the whole boot pointed at the wrong database.
- **Not touching `infra/docker-compose.prod.yml`** in this lane — that's a separate deploy-config change outside this lane's scope (handoff bans touching shared production files without call-out), and setting the env var is an operational decision, not a code change. Documented as a required follow-up in the PR body.

Escalating this whole section to the coordinator for explicit approval before Task 2 starts (Task 1 and Task 3 have no such fork and can start immediately once the plan is approved).

## Determinism boundary

No UI/model surface touched — pure backend ops-tooling. N/A.

## Task 1 — `scripts/rewrap-secrets.ts`

- Add `parseArgs`/`readFlag` (mirror `scripts/delete-user-data-cli.ts:86-115` shape) recognizing `--confirm-owner-email <email>`.
- In `main()`, after `createDatabase(...)` (`scripts/rewrap-secrets.ts:28`) and before the first `UPDATE` (the `connectorRows` loop, `scripts/rewrap-secrets.ts:76`), call:
  ```ts
  await assertOperatorConfirmsTargetOwner(db, args.confirmOwnerEmail);
  ```
  using the same `db` handle already created (no second connection). This script has no dry-run mode, so the guard always runs — matches "execute path only" trivially since the whole script is the execute path.
- Update the file's usage/runbook comment block (`scripts/rewrap-secrets.ts:13-19`) to include the new required flag.
- Import: `import { ..., assertOperatorConfirmsTargetOwner } from "@moss/db";`

**Test** (new file `packages/db/src/__tests__/rewrap-secrets-guard.test.ts` or co-located under `scripts/__tests__/` — match whichever directory `scripts/*.test.ts` precedent uses; grep at build time, default to `scripts/__tests__/rewrap-secrets.guard.test.ts` since `module-reconcile-plan.test.ts` lives under `tests/unit/`, not `scripts/__tests__/`, so mirror that: `tests/unit/rewrap-secrets-guard.test.ts`):

- Export a small testable seam: `export async function runRewrap(db, confirmOwnerEmail)` is too invasive a refactor for a script with no existing exports. Instead export just enough to test the wiring without a full run: refactor the guard call into an exported function `assertRewrapTargetIdentity(db, confirmOwnerEmail)` that is a 1-line pass-through to `assertOperatorConfirmsTargetOwner` (exists purely so the test imports the same code path `main()` calls, proving wiring, not re-deriving the guard's own logic already covered by `target-identity-guard.test.ts`).
- Test case: seed a bootstrap owner row (same fixture shape as `target-identity-guard.test.ts:99-116`), call `assertRewrapTargetIdentity(db, "wrong@example.com")`, assert it rejects with `TargetIdentityMismatchError` — proves the caller is wired to the real guard, not a no-op.
- Verification: `pnpm --filter @moss/db test -- rewrap-secrets-guard --run 2>&1 | cat; echo "EXIT=${PIPESTATUS[0]}"` expected `EXIT=0`. (Per gate rules, real gate run happens under `verify-gate` skill at wrap-up; this is the task-local check only.)

## Task 2 — `scripts/module-reconcile.ts` (pending coordinator approval of the Open Question above)

- Add `assertReconcileTargetIdentity(client: pg.Client): Promise<void>` exported from `scripts/module-reconcile.ts`:
  - `SELECT to_regclass('app.users') AS reg` — if `reg` is null, no schema yet (fresh install): return (no-op).
  - Else `SELECT id, email FROM app.users WHERE is_bootstrap_owner = true LIMIT 1` — if no row: return (no-op, fresh install pre-first-signup).
  - Else compare row's email to `resolveMossEnv(env, "JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL")`; mismatch or unset → throw `TargetIdentityMismatchError` (imported from `@moss/db`, reused as-is — no new error type).
  - Uses the raw `pg.Client` already open in `reconcileModules` (`scripts/module-reconcile.ts:120-121`), not a second Kysely connection — avoids adding a `@moss/db` Kysely dependency into a script that currently only uses `pg.Client` directly for the bootstrap role.
- Call `await assertReconcileTargetIdentity(client)` immediately after `await client.connect()` (`scripts/module-reconcile.ts:121`), before the Phase 0 advisory lock.
- Thrown errors propagate out of `reconcileModules` uncaught (not wrapped in the per-module `warn()` path) so the CLI entrypoint's existing `.catch` (`scripts/module-reconcile.ts:407-410`) exits non-zero — matches "only lock/connection failures exit non-zero."
- `ReconcileModulesOptions.env` (`scripts/module-reconcile.ts:98`) already threads a test-injectable env — no new option needed.

**Test** (`tests/unit/module-reconcile-plan.test.ts` — extend existing file, no new file, matching its "pure-logic units" scope note at line 1-2... but this check needs a live `pg.Client`, so it does NOT belong there):

- New file `tests/integration/module-reconcile-target-guard.test.ts` (live-DB, mirrors `target-identity-guard.test.ts` fixture): seed a bootstrap owner, call `assertReconcileTargetIdentity(client)` with `JARVIS_RECONCILE_CONFIRM_OWNER_EMAIL` unset → expect rejection; with it set to a mismatched value → expect rejection; with it matching → resolves; delete the owner row (simulating fresh install, table still exists) → resolves without requiring the env var.
- Verification: `pnpm vitest run tests/integration/module-reconcile-target-guard.test.ts 2>&1 | cat; echo "EXIT=${PIPESTATUS[0]}"`, expected `EXIT=0`. (Root-tests-never-run-via-package-filter — confirmed against memory, using root vitest invocation, not `--filter`.)

## Task 3 — `scripts/restore-database.ts`

- Add `confirmOwnerEmail?: string` and `allowEmptyTarget?: boolean` to `RestorePlanInput` (`scripts/restore-database.ts:12-18`); no change to `RestorePlan`'s return shape (guard runs in `main()`, not inside the pure `createRestorePlan`, so `createRestorePlan`'s existing unit tests at `tests/integration/release-hardening.test.ts:437-560` are untouched).
- New exported function in `scripts/restore-database.ts`:

  ```ts
  export async function assertRestoreTargetIdentity(
    db: Kysely<MossDatabase>,
    input: { readonly confirmOwnerEmail?: string; readonly allowEmptyTarget?: boolean }
  ): Promise<{ readonly id: string; readonly email: string } | null>;
  ```

  - `SELECT to_regclass('app.users')` — null (no schema) → if `!input.allowEmptyTarget` throw `NoBootstrapOwnerFoundError`; else return `null`.
  - Else delegate to `assertOperatorConfirmsTargetOwner(db, input.confirmOwnerEmail)` for the has-schema case — if that throws `NoBootstrapOwnerFoundError` (schema exists, `app.users` empty) and `input.allowEmptyTarget` is true, return `null`; otherwise rethrow (including `TargetIdentityMismatchError` always rethrown, opt-out never bypasses a mismatch, only bypasses the "no owner to confirm against" case).

- In `main()` (`scripts/restore-database.ts:99-119`), after `await access(plan.backupFile)` and before `runCommandFromFile`, when `plan.execute`: build a `Kysely<MossDatabase>` via `createDatabase({connectionString: args.connectionString ?? getMossDatabaseUrls().bootstrap})` (same URL `createRestorePlan` already resolves from) and call `assertRestoreTargetIdentity`, destroying the db handle in a `finally`.
- New flags in `parseArgs`: `--confirm-owner-email <email>`, `--allow-empty-target` (boolean, `args.includes(...)`).
- Update the `!plan.execute` help text (`scripts/restore-database.ts:104-110`) to mention the new required flag.

**Test** (extend `tests/integration/release-hardening.test.ts`, near the existing restore-plan tests at line 437-560 — same file already does live-DB + pure-plan tests together):

- Seed bootstrap owner, call `assertRestoreTargetIdentity(db, {confirmOwnerEmail: "wrong@example.com"})` → rejects `TargetIdentityMismatchError`.
- Seed bootstrap owner, call with matching email → resolves to the owner row.
- Delete owner row (schema present, no owner), call with no `allowEmptyTarget` → rejects `NoBootstrapOwnerFoundError` (proves no silent bypass).
- Same empty-owner state, call with `allowEmptyTarget: true` → resolves `null` (proves the explicit opt-out works and only the opt-out unlocks it).
- Verification: `pnpm vitest run tests/integration/release-hardening.test.ts 2>&1 | cat; echo "EXIT=${PIPESTATUS[0]}"`, expected `EXIT=0`.

## Kill gate

After Task 1 lands and its regression test passes green, pause and confirm with the coordinator that the Task 2 design (module-reconcile fork above) is approved before starting Task 2. Owner: coordinator (label from handoff). If Task 2's approach is rejected, Task 1 and Task 3 still ship independently — no shared code between tasks.

## Verification (full lane, at wrap-up)

Per `coordinated-wrap-up` / `verify-gate` skill — isolated gate DB, not run ad hoc here.
