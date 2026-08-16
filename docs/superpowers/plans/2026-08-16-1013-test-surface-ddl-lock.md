# Plan — #1013 re-scoped: lock the test-suite DDL surface on #1632's lock

**Issue:** Part of #1013 · **Spec:** `docs/superpowers/specs/2026-08-13-1013-cluster-global-ddl-serialization.md` (amended in place per Ben's ruling A, 2026-08-16)
**PR:** #1624, re-scoped in place · **Branch:** `build-1013-ddl-lock`, reset onto `origin/main` @ `24eb46e25`
**Tier:** security

## Why this plan exists

#1632 shipped a dual-session liveness cluster-DDL lock and wired it into the **production** path.
#1013's collisions happen on the **test** path, which #1632 left unlocked. The original #1624
implemented a competing lock (`moss:cluster-ddl` vs `jarv1s:cluster-ddl` — disjoint keys, zero
mutual exclusion), so its core is superseded. What survives is the part that actually closes
#1013's acceptance criterion 3. Pre-rescope work is preserved at
`.claude/patches/1624-pre-rescope-full-branch-diff.patch` and
`.claude/patches/1624-d1-d2-t1-t3-fable-verified-at-8bc7cd112.patch`.

Superseded and deliberately dropped: #1013's own lock implementation, its unit tests, and its D1
fail-closed fix — main reaches D1's requirement by a better route (`abortAcquisition`,
`packages/db/src/cluster-ddl-lock.ts:242`).

## Seams check — every assumed capability, cited

| Capability                                                                                       | Citation                                                   | Status                                                                                   |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `withClusterDdlLock(url, fn(client), options?)`                                                  | `packages/db/src/cluster-ddl-lock.ts:197`                  | exists                                                                                   |
| Callback receives query-only guarded session                                                     | `packages/db/src/cluster-ddl-lock.ts:60-65`                | exists                                                                                   |
| Guarded session connects to the **bootstrap URL's** database, lock session to the maintenance DB | `packages/db/src/cluster-ddl-lock.ts:225`, `:247`          | exists                                                                                   |
| Reentrancy is a hard process-global throw                                                        | `packages/db/src/cluster-ddl-lock.ts:195`, `:213-215`      | exists — constrains design                                                               |
| `runSqlFilesWithClient(client, directory)`                                                       | `packages/db/src/migrations/sql-runner.ts:135`             | exists                                                                                   |
| Canonical "lock a SQL directory" pattern                                                         | `scripts/migrate.ts:29-31`                                 | exists — copy it                                                                         |
| Broker accepts `WithClusterDdlLockOptions` at all 3 sites                                        | `packages/db/src/module-role-broker.ts:54`, `:108`, `:128` | exists                                                                                   |
| `purgeModule` accepts **and forwards** lock options                                              | `scripts/module-reconcile.ts:338`, `:400`                  | exists                                                                                   |
| Vitest runs suites sequentially (`pool: "forks"`, `fileParallelism: false`)                      | `vitest.config.ts:319-320`                                 | exists — makes lock sections sequential siblings, so the reentrancy guard is satisfiable |

**Gaps this plan closes** (each verified absent on `24eb46e25`):

| Gap                                                                                                                                                                                                      | Citation                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bootstrap SQL in tests runs unlocked (spec site 3)                                                                                                                                                       | `tests/integration/test-database.ts:71`                                                                                                                |
| `dropModuleRolesAtTeardown` runs `DROP ROLE` unlocked (spec site 6)                                                                                                                                      | `tests/integration/test-database.ts:201-214`                                                                                                           |
| 4 job-search suites drop roles inline, swallowing errors with `.catch(() => {})`                                                                                                                         | `job-search-store.test.ts:59-60`, `job-search-tables-install.test.ts:74-75`, `job-search.test.ts:387-389`, `job-search-worker-surface.test.ts:203-205` |
| 3 suites revoke **role membership** (`pg_auth_members`) unlocked                                                                                                                                         | `finance-storage-migrate.test.ts:452`, `module-storage-rpc.test.ts:63`, `module-worker-rpc.test.ts:769`                                                |
| Only production caller of `purgeModule` drops the lock options, so the purge lock resolves its maintenance DB from ambient `process.env` while the URLs come from the injected `env` — lock-domain split | `scripts/module-reconcile.ts:106-107` vs `:149`                                                                                                        |
| `installModule` never threads lock options into the three broker calls — same split                                                                                                                      | `scripts/module-install.ts:43`, `:52`, `:109`                                                                                                          |

**Open question (owner: Coordinator, non-blocking):** whether the injected-env split above should
land here or as its own issue. It is the r2-B1 class #1624 already fixed and is re-introduced by
#1632's port, so this plan fixes it. Flagging because it is production-path scope, not test-path.

## Classification that drives the design

Only catalogs that are **cluster-global** need this lock:

- **Lock:** `CREATE/ALTER/DROP ROLE`, `DROP OWNED`, and role-**membership** `GRANT`/`REVOKE`
  (`pg_authid`, `pg_auth_members`).
- **Do not lock:** per-database privilege `REVOKE ALL PRIVILEGES ON SCHEMA|TABLE …` and
  `REVOKE REFERENCES (col) ON …` — these write `nspacl`/`relacl` in the local database only.

Over-locking is not free: every extra section is a serialization point across all lanes, and a
nested one is a `ClusterDdlLockReentrancyError`.

## Determinism boundary

Not applicable — no user-facing surface, no UI, no model involvement. This change is test
infrastructure plus a CLI env-plumbing fix. No UAT spec or trigger-map row is required; the
live-path gate is satisfied by the concurrent two-worktree gate proof in Phase 1's kill gate.

## Phase 1 — lock the test-surface (ships alone, then the kill gate)

### 1.1 `tests/integration/test-database.ts`

Site 3 — bootstrap directory, adopt `migrate.ts`'s pattern verbatim:

```ts
// replaces the bare runSqlFiles(...) at :71
await withClusterDdlLock(connectionStrings.bootstrap, (client) =>
  runSqlFilesWithClient(client, join(root, "infra/postgres/bootstrap"))
);
```

Site 6 and the new membership helper — exported signatures:

```ts
export interface ClusterGlobalDdlOptions {
  readonly lock?: WithClusterDdlLockOptions;
}

export async function dropModuleRolesAtTeardown(
  roles: readonly string[],
  options?: ClusterGlobalDdlOptions
): Promise<void>;

export async function grantModuleMembershipAtSetup(
  statements: readonly string[],
  options?: ClusterGlobalDdlOptions
): Promise<void>;

export async function revokeModuleMembershipAtTeardown(
  statements: readonly string[],
  options?: ClusterGlobalDdlOptions
): Promise<void>;
```

**Two build-time corrections to this section** (both simplifications, recorded here so the shipped
code and the plan agree):

1. **`preDropSql` dropped.** Three suites already run their per-database privilege revokes inline on
   their own client and then call the helper — the established on-main pattern. Per-database revokes
   don't race cluster-globally, so there is no atomicity argument for pulling them inside the helper,
   and an options field that only reorders statements the caller already controls is dead weight.
2. **The `client` parameter dropped entirely.** Once the drops move to the guarded session and the
   lock resolves its URL from the module-level `connectionStrings.bootstrap`, no statement lands on
   `client`. Keeping it would invite callers to assume the drops join their transaction, or can be
   reordered against the per-database `REVOKE`s — neither is true. Cost: six mechanical call-site
   edits. `options.lock` exists only so unit tests can inject the lock's DI seams.

Decisions, not bodies:

- Per-database privilege revokes stay **on the caller's client, outside the lock** — running them on
  the guarded session would target the bootstrap database, not the suite's, and would silently
  revoke nothing. Suites keep issuing them inline before calling the helper.
- `DROP ROLE IF EXISTS` runs **on the guarded session** inside `withClusterDdlLock`. Roles are
  cluster-global, so the guarded session's database is irrelevant to correctness and this buys the
  liveness guarantee.
- The existing 2BP01 (`dependent_objects_still_exist`) tolerance and its comment survive unchanged —
  it documents a real, still-correct decision (#1345).
- Membership helpers run their statements on the guarded session (membership is cluster-global) and
  are **fail-closed**: no `.catch()`, any error propagates.
- All three helpers take exactly one lock section each and call no other locked helper — required by
  the reentrancy guard.

### 1.2 Wire the seven suites

| File                                                                                                                       | Change                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job-search.test.ts`, `job-search-store.test.ts`, `job-search-worker-surface.test.ts`, `job-search-tables-install.test.ts` | inline `DROP ROLE … .catch(() => {})` → `await dropModuleRolesAtTeardown([...])`; the per-database revokes stay where they are, inline on the suite client        |
| `finance-storage-migrate.test.ts`, `module-storage-rpc.test.ts`, `module-worker-rpc.test.ts`                               | membership `REVOKE <role> FROM <role>` → `revokeModuleMembershipAtTeardown(...)`; leave the adjacent per-database privilege revokes on the suite client, unlocked |

### 1.3 Test cases

| Test                                                       | Behaviour                                                                                              | Fails against a broken impl because                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dropModuleRolesAtTeardown` takes exactly one lock section | injected `createLockClient`/`createDdlClient` spies record one acquire/release pair for an N-role call | a per-role lock would emit N pairs — and N nested calls would throw `ClusterDdlLockReentrancyError`                                                   |
| the lock session lands on the maintenance database         | the URL handed to `createLockClient` has pathname `/postgres`                                          | advisory-lock tags are scoped by database OID, so a lock session on the caller's own per-lane gate DB excludes nobody — the lock-domain split, silent |
| an empty statement list takes no lock at all               | no statement of any kind is recorded                                                                   | suites build these lists conditionally; an unconditional acquire costs a cluster-wide serialization point for nothing                                 |
| `DROP ROLE` runs on the guarded session                    | statements recorded by the DDL-client spy, not the suite client                                        | issuing them on the caller's connection holds the lock but forfeits the liveness guarantee — compiles, passes a naive test, defeats #1632             |
| 2BP01 tolerated, every other SQLSTATE rethrown             | a `2BP01` resolves; a `42501` rejects                                                                  | swallowing all errors reintroduces the silent-teardown class the `.catch(() => {})` removal exists to kill                                            |
| membership helpers are fail-closed                         | a failing statement rejects                                                                            | a `.catch` here hides a real cluster-catalog failure                                                                                                  |
| no suite retains inline role DDL                           | source-level guard, see Phase 3                                                                        | a suite added later silently re-opens the race                                                                                                        |

### 1.4 Verification

```bash
pnpm vitest run tests/unit/test-database-role-ddl-lock.test.ts \
  tests/unit/cluster-ddl-lock-wiring.test.ts > /tmp/1013-p1-unit.log 2>&1; echo "EXIT=$?"
```

Expected `EXIT=0`. Integration and gate runs go through the **`verify-gate`** skill — never bare,
never piped (`.claude/hooks/check-gate-pipe.sh` blocks the piped form, and a piped gate reports the
last command's status, so red reads green).

### 1.5 KILL GATE — owner: Coordinator (escalate; do not self-adjudicate)

Run two concurrent full gates from separate worktrees on separate gate DBs.

- **Pass:** zero `XX000 tuple concurrently updated` failures, and zero unattributable errors.
- **Trip:** any participant-vs-participant collision, or any unattributable error → the premise that
  test-surface locking closes #1013 is wrong. **Stop, escalate, spec reopens.** Do not retry-loop.
- Known-accepted residual, not a trip: cross-lane `DROP ROLE` **dependency** errors (2BP01 class)
  from fixed module fixture ids — ruled a distinct pre-existing class on 2026-08-14, tracked
  separately.

Phase 2 is not planned in detail until this gate is evaluated.

## Phase 2 — restore the injected-env lock domain

- `scripts/module-reconcile.ts:149` — pass the reconcile-scoped lock options into `purgeModule`.
- `scripts/module-install.ts` — accept lock options on `ModuleInstallOptions` and thread them into
  `ensureModuleRoles` (`:43`), `enableInstallerLogin` (`:52`), `disableInstallerLogin` (`:109`);
  `module-reconcile.ts:265` supplies them.
- Signature: reuse `WithClusterDdlLockOptions` from `packages/db/src/cluster-ddl-lock.ts` — no new type.

Test: a unit test injects `env` with a non-default `JARVIS_CLUSTER_LOCK_DATABASE` and asserts the
lock client's connection string lands on **that** database at every one of the four call sites. It
fails against the current tree, which is the point — this is a live defect on `main`, not a
refactor.

## Phase 3 — guard the surface and re-author the proof

- `tests/unit/cluster-ddl-lock-wiring.test.ts` — keep main's six-category production guard; add the
  repo-wide role-DDL discovery-surface assertion (23 files on `24eb46e25`) and per-suite routing
  assertions. Amend main's "membership grant/revoke is not a standalone call site" case: true for
  production, **false** for the test suite, which is where the races occur.
- `scripts/prove-cluster-ddl-lock.ts` — re-author the D2/T3 capabilities onto main's diagnostic shape
  (`{type:"acquired"|"heartbeat"|"released", ownerPid}`): unfiltered all-backend sampling classified
  participant-vs-external, `captured_at`, and the `--external-writer-demo` negative path that exits
  non-zero unless an external unlocked writer is actually captured. Design reference (not a port —
  the event shape changed): the preserved patch.
- **P1′**: locked N≥30 run + T3, unpiped, exit code recorded.

## Rulings ledger

| Ruling                                                                | Evidence                                                             | Status                                                                                                |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Two locks with different keys exclude nothing; merge-both unavailable | `cluster-ddl-lock.ts:132` vs preserved patch                         | settled — drove ruling A                                                                              |
| #1624's D1 fix is redundant on main                                   | `cluster-ddl-lock.ts:242`                                            | settled — dropped                                                                                     |
| Reentrancy is not a blocker for the test surface                      | `vitest.config.ts:319-320`                                           | settled                                                                                               |
| Per-database privilege revokes must stay outside the lock             | `cluster-ddl-lock.ts:247` (guarded session targets the bootstrap DB) | settled — suites keep them inline; `preDropSql` was proposed for this and then dropped as dead weight |
| Cross-lane 2BP01 fixture collisions are a separate class              | adjudication 2026-08-14, comment 5295332960                          | settled — not absorbed here                                                                           |
