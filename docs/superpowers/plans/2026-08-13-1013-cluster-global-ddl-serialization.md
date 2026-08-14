# Plan — #1013 cluster-global DDL serialization

**Spec:** `docs/superpowers/specs/2026-08-13-1013-cluster-global-ddl-serialization.md` (must be
approved before build). **Task issue:** #1013.

Single phase. Contracts only — no function bodies; the builder writes code against the compiler on
a then-current rebase of `main`.

## Seams check (file:line, verified on this branch at `be7edf725`)

| Assumed capability                                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap superuser URL available everywhere the lock is needed               | `getMossDatabaseUrls().bootstrap` — `packages/db/src/urls.ts:46`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Maintenance-DB derivation prior art (swap URL database segment to `postgres`) | `scripts/test-integration.ts:45-51` (intent only — its trailing-segment regex clobbers query strings; Task 1 binds `new URL()` instead)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Advisory-lock key idiom `hashtext('…')` already in tree                       | `packages/db/src/migrations/sql-runner.ts:199`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `runSqlFiles(connectionString, directory)` is the bootstrap executor to wrap  | `packages/db/src/migrations/sql-runner.ts:114`; callers `scripts/migrate.ts:23`, `tests/integration/test-database.ts:71`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `applyRolePasswords` owns the ALTER ROLE…PASSWORD writes                      | `packages/db/src/role-bootstrap.ts:97-110`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Module role DDL confined to three broker functions                            | `packages/db/src/module-role-broker.ts:49-136`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Teardown DROP ROLE site                                                       | `tests/integration/test-database.ts:201-214`; routed through by `module-install`, `module-role-broker`, `module-worker-rpc`, `finance-tables-install` tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Purge role-DDL site (spec sites 9–12)                                         | `scripts/module-reconcile.ts:363-384` (`purgeModule` step 4); inline cleanups `tests/integration/job-search{,-store,-worker-surface,-tables-install}.test.ts`; membership revoke `tests/integration/module-worker-rpc.test.ts:769`; membership GRANT/REVOKE pairs `module-storage-rpc.test.ts:47,:63`, `finance-storage-migrate.test.ts:426,:452`, `module-worker-rpc.test.ts:753` — both storage files already call `dropModuleRolesAtTeardown` (`:83`, `:467`)                                                                                                                                                                                                             |
| Reconcile's own lock cannot cover site 9                                      | `pg_advisory_lock(hashtext('jarv1s:module-reconcile'))` at `scripts/module-reconcile.ts:127` — per-lane DB session (per-database locktag), different key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Env resolution channel for the override var                                   | `resolveMossEnv` — exported from `@moss/db`, used at `tests/integration/test-database.ts:23-27`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `@moss/db` public surface to extend                                           | `packages/db/src/index.ts` (exports `runSqlFiles`, `runSqlMigrations`, `resolveMossEnv` today)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Role-DDL discovery is complete over SQL **and** TS sources                    | two-part grep over `infra/postgres/migrations/`, `packages/*/sql/` and `scripts/`, `packages/`, `apps/`, `tests/` `*.ts`: the DDL family `CREATE ROLE` / `ALTER ROLE` / `DROP ROLE` / `DROP OWNED` **plus** membership forms `GRANT <role> TO` / `REVOKE <role> FROM` (non-`ON`; the DDL family matches none of the six membership statements, spec site 11 included) — every hit dispositioned in the spec's site table or its exclusion list (comments; `audit-release-hardening.ts:429` attribute read; unit test asserting SQL text; per-database ACL revokes; template-form `module-role-broker.ts:75` inside wrapped site 5; SQL-dir hit `0000_roles.sql:80` = site 2) |
| DROP/CREATE DATABASE already serialized at gate start                         | `scripts/run-gate.sh:162-173` (`flock`) — unchanged by this plan                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Open questions: none.

## Task 1 — the lock primitive

New file `packages/db/src/cluster-ddl-lock.ts`, exported from `packages/db/src/index.ts`:

```ts
export interface ClusterDdlLockOptions {
  /** Milliseconds to wait for the lock before failing closed. Default 120_000. */
  lockTimeoutMs?: number;
}

/**
 * Serializes cluster-global DDL (pg_authid / pg_auth_members writes) across every process on the
 * cluster, regardless of JARVIS_PGDATABASE. Opens its own session to the shared maintenance DB
 * (bootstrap URL with the database segment replaced by JARVIS_CLUSTER_LOCK_DATABASE, default
 * "postgres") and holds a session-level pg_advisory_lock(hashtext('moss:cluster-ddl')) around fn.
 * NOT reentrant: fn must never call another withClusterDdlLock-wrapped section.
 */
export function withClusterDdlLock<T>(
  bootstrapConnectionString: string,
  fn: () => Promise<T>,
  options?: ClusterDdlLockOptions
): Promise<T>;

/** Bootstrap-directory runner: withClusterDdlLock around runSqlFiles. Returns applied file names. */
export function runClusterBootstrapSql(
  bootstrapConnectionString: string,
  directory: string
): Promise<string[]>;
```

Decisions bound by the spec: session-level lock (crash-release), `SET lock_timeout` before
acquire, fail-closed throw naming the lock DB and `JARVIS_CLUSTER_LOCK_DATABASE`, unlock + `end()`
in `finally`, no DROP/CREATE of anything, connection strings passed through unmodified.
Maintenance-URL derivation uses `new URL()` with a pathname swap (query string — e.g.
`?sslmode=…` — preserved), **not** the trailing-segment regex from
`scripts/test-integration.ts:45-51`. Every function that acquires the lock internally (Task 2)
carries a doc comment restating the non-reentrancy rule, not just the primitive.

**Unit/integration tests (behavior + why a broken implementation fails):**

1. Mutual exclusion: two concurrent `withClusterDdlLock` calls from two `pg` sessions interleave
   as strict A-then-B (assert via a shared array of enter/exit timestamps). Fails if the lock lands
   in the per-lane DB (both enter concurrently) — the exact bug this plan exists to fix.
2. Cross-database exclusion: same test but the two callers pass bootstrap URLs whose database
   segments differ (two scratch DBs). Fails for any per-database locking scheme.
3. Release on error: `fn` throws → lock is immediately acquirable by a second caller. Fails if
   unlock is not in `finally`.
4. Crash release: acquire from a spawned child process, `SIGKILL` it, assert the parent acquires
   within the timeout. Fails for any file-based lock (stale file) — proves the crash-recovery
   claim in #1013's acceptance.
5. Timeout fails closed: holder sleeps past a short `lockTimeoutMs` → waiter rejects with the
   documented error, and `fn` was never invoked. Fails if a timeout path falls through to
   unlocked execution.

## Task 2 — wrap the collision sites

Diff-shaped decisions (no bodies):

- `scripts/migrate.ts:23` — `runSqlFiles(urls.bootstrap, bootstrapDirectory)` →
  `runClusterBootstrapSql(urls.bootstrap, bootstrapDirectory)`.
- `tests/integration/test-database.ts:71` — same substitution inside
  `resetEmptyFoundationDatabase`. The grants call at `:88` stays on plain `runSqlFiles`
  (per-database ACLs, spec's out-of-scope list).
- `packages/db/src/role-bootstrap.ts` — `applyRolePasswords` wraps its ALTER ROLE loop in
  `withClusterDdlLock(bootstrapConnectionString, …)` internally; signature unchanged.
- `packages/db/src/module-role-broker.ts` — `ensureModuleRoles`, `enableInstallerLogin`,
  `disableInstallerLogin` each wrap their role-DDL section internally; signatures unchanged.
- `tests/integration/test-database.ts:201` — `dropModuleRolesAtTeardown` wraps its DROP ROLE loop
  in `withClusterDdlLock`; the 2BP01 tolerance stays inside `fn` unchanged. It gains an optional
  third parameter `options?: { preDropSql?: string[] }` — statements executed inside the locked
  section before the drops. Three teardown membership `REVOKE`s move into that hook instead of
  running just before the call: `tests/integration/module-worker-rpc.test.ts:769` (spec site 11)
  and the site-12 afterAll pair `module-storage-rpc.test.ts:63`,
  `finance-storage-migrate.test.ts:452` (both files already call the helper at `:83`/`:467`).
- `tests/integration/test-database.ts` — new sibling helper for spec site 12's beforeAll GRANTs:
  `export async function grantModuleMembershipAtSetup(client: Client, statements: string[]): Promise<void>`
  — executes the passed statements on `client` inside `withClusterDdlLock` (same acquisition as
  the teardown helper). Callers: `module-storage-rpc.test.ts:47`,
  `finance-storage-migrate.test.ts:426`, `module-worker-rpc.test.ts:753`. Setup and teardown
  helpers run in beforeAll/afterAll respectively — siblings, never nested.
- `scripts/module-reconcile.ts` — `purgeModule` wraps **only** its role-DDL section (step 4,
  `:363-384`: REVOKE GRANT OPTION…CASCADE, DROP OWNED BY, DROP ROLE) in `withClusterDdlLock`
  internally; signature unchanged. Steps 1–3 and 5–6 (per-lane tables, rows, files, the purge
  mark) stay outside the lock. The file's Phase-0 `jarv1s:module-reconcile` advisory lock at
  `:127` is untouched — different job (serializes reconcile runs per lane), different key.
- The four inline job-search cleanups (spec site 10 — `tests/integration/job-search.test.ts:387-389`,
  `job-search-store.test.ts:59-60`, `job-search-worker-surface.test.ts:203-205`,
  `job-search-tables-install.test.ts:74-75`) switch to `dropModuleRolesAtTeardown`, keeping their
  best-effort `.catch(() => {})` at the call site.

**Non-nesting guard test:** a source-assertion test (reads its OWN worktree — see
`source-assertion-tests-read-their-own-worktree`) asserting that in **both** script-level
compositions — `scripts/migrate.ts` (`runClusterBootstrapSql` + `applyRolePasswords`) and
`scripts/module-reconcile.ts` (the wrapped purge section vs. the broker calls it triggers) — the
wrapped sections are sequential siblings, not one inside the other's callback. Fails if a refactor
nests two wrapped sections → self-deadlock. Belt-and-braces for call paths the assertion can't
see: the non-reentrancy doc comment on every internally-wrapped function (Task 1 decision).

**Wiring test (wired-not-just-defined):** integration test that calls
`resetEmptyFoundationDatabase` while an independent session holds the cluster lock, and asserts
the reset blocks until release. Fails if the reset path silently kept lock-free `runSqlFiles`.

## Task 3 — concurrency proof harness

New `scripts/prove-cluster-ddl-lock.ts` (dev tooling, wired as `pnpm prove:ddl-lock`):

- Spawns 2 child processes × N iterations (default 30). Each child loops: bootstrap SQL + role
  passwords against its own scratch database (`moss_ddlproof_<pid>_a` / `_b` — per-run unique so
  two overlapping harness invocations on the shared dev cluster never fight over the same scratch
  DBs; created and dropped by the harness only, names never derived from `JARVIS_PGDATABASE`, so
  it cannot touch a lane DB).
- `--no-lock` mode calls raw `runSqlFiles`/unwrapped password loop: expected to surface
  shared-catalog errors (`tuple concurrently updated`, SQLSTATE XX000-class) across recorded runs —
  probabilistic, so the harness records error counts per run; evidence goes on the PR.
  **`--no-lock` always exits 0** — it is an evidence run, never a gate; a 0-error `--no-lock` run
  weakens the PR evidence (rerun with higher N) but fails nothing.
- Locked mode (default): **0 errors, every run** — exits non-zero on any error.

## Verification (builder runs; all unpiped, expected exit codes stated)

```bash
pnpm typecheck > /tmp/1013-typecheck.log 2>&1; echo "EXIT=$?"          # expect EXIT=0
pnpm lint > /tmp/1013-lint.log 2>&1; echo "EXIT=$?"                    # expect EXIT=0
pnpm prove:ddl-lock > /tmp/1013-proof.log 2>&1; echo "EXIT=$?"         # expect EXIT=0
pnpm prove:ddl-lock --no-lock > /tmp/1013-noproof.log 2>&1; echo "EXIT=$?"  # expect EXIT=0 always (evidence run, never a gate); record error count on PR
```

DB-touching commands (`prove:ddl-lock`, `test:integration`, the gate) require the `verify-gate`
skill and an isolated `JARVIS_PGDATABASE` per `gate-db-isolation-mandatory`.

**e2e for the phase (the issue's acceptance proof):** two concurrent `scripts/run-gate.sh start`
runs from two worktrees on the dev cluster, staggered ~60s; both must reach `DONE rc=0` and
`grep -c "tuple concurrently updated"` over both logs must print 0. Executed and observed by the
builder, output recorded on the PR. Coordinate the run window via the Coordinator (other lanes
share the cluster).

## Kill gate

**Observation that ends the line:** the two-worktree proof still reproduces `tuple concurrently
updated` (or any shared-catalog race) with the lock in place — meaning a collision site exists
outside the mapped surface, and the diagnosis, not the mechanism, is wrong. Builder stops, posts
the failing log excerpt to #1013, and the spec is re-opened. **Call owner:** Fable (coordinator
escalates to Ben only if the re-diagnosis forks the design).

## Exit criteria

- [ ] Task 1 tests 1–5 green in the isolated gate DB
- [ ] Non-nesting guard + wiring test green
- [ ] `prove:ddl-lock` locked mode: 0 errors; `--no-lock` evidence recorded on PR
- [ ] Two-worktree concurrent gate proof: both `DONE rc=0`, zero catalog errors, logs on PR
- [ ] `pnpm typecheck` / `pnpm lint` EXIT=0
- [ ] PR carries user-facing summary: "Not user-visible — dev/CI reliability: parallel agent test
      gates no longer randomly fail on shared Postgres role bootstrap."
