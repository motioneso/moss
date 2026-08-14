# Cluster-global DDL serialization across parallel dev gates

**Date:** 2026-08-13

**Status:** Draft — revised 2026-08-14 per independent Fable review, twice:
round 1 ([comment 5290473655](https://github.com/motioneso/moss/pull/1616#issuecomment-5290473655))
closed the B1 collision-map gap (module-reconcile purge + widened TS-source discovery) and folded
in four non-blockers; round 2
([comment 5290627554](https://github.com/motioneso/moss/pull/1616#issuecomment-5290627554)) closed
B2 (role-membership `GRANT`/`REVOKE` writers mapped as site 12, discovery pattern widened to
membership forms). Awaiting re-review.

**Issue:** #1013 (task; no parent roll-up)

**Source:** two full-gate attempts during UX #990 failed in different integration suites inside
`resetFoundationDatabase`/`runSqlFiles` with PostgreSQL `error: tuple concurrently updated`;
read-only process proof found a second lane running `verify:foundation` on the same cluster at the
time. The same error is the documented cause of the 19-hour stall in `scripts/run-gate.sh:23-25`.

**Grounded on:** branch `spec-1013-ddl-lock` at `be7edf725` (origin/main `1e8df0257`), read directly
in this tree: `scripts/run-gate.sh`, `scripts/migrate.ts`, `scripts/test-integration.ts`,
`packages/db/src/migrations/sql-runner.ts`, `packages/db/src/role-bootstrap.ts`,
`packages/db/src/module-role-broker.ts`, `packages/db/src/urls.ts`,
`tests/integration/test-database.ts`, `infra/postgres/bootstrap/0000_roles.sql`,
`infra/postgres/grants/*.sql`, `package.json`, `scripts/module-reconcile.ts`, and the
role-DDL-bearing integration tests named in sites 10–12.

**Pre-build grounding gate:** rebase on then-current `main`, re-read the owned files, replace stale
line references before implementation.

## Problem

Every lane gets its own `JARVIS_PGDATABASE`, which isolates all per-database state (tables, per-DB
catalogs, per-DB ACLs). It cannot isolate the **shared** catalogs — `pg_authid`, `pg_auth_members`,
`pg_database` — which are one physical table per cluster. Concurrent writes to the same shared-catalog
tuple from two lanes produce `tuple concurrently updated`, a nondeterministic hard error.

The repo writes those same shared tuples on every gate run and every integration-suite reset:

| #   | Site                                                                                                                                                                                                                            | Shared-catalog write                                                                                                                                                                                                                                                                      | Frequency under one gate                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | `infra/postgres/bootstrap/0000_roles.sql:35-65`                                                                                                                                                                                 | unconditional `ALTER ROLE` on the same four fixed roles → `pg_authid`                                                                                                                                                                                                                     | once per `db:migrate` **and once per integration suite file** (100+ resets per gate) via site 3                       |
| 2   | `infra/postgres/bootstrap/0000_roles.sql:80`                                                                                                                                                                                    | `GRANT jarvis_auth_runtime TO jarvis_migration_owner` → `pg_auth_members`                                                                                                                                                                                                                 | same as site 1                                                                                                        |
| 3   | `runSqlFiles` on the bootstrap dir — `scripts/migrate.ts:23` and `tests/integration/test-database.ts:71` (`resetEmptyFoundationDatabase`)                                                                                       | executes sites 1–2; `runSqlFiles` (`packages/db/src/migrations/sql-runner.ts:114`) holds **no lock of any kind**                                                                                                                                                                          | as above                                                                                                              |
| 4   | `applyRolePasswords` (`packages/db/src/role-bootstrap.ts:97-110`)                                                                                                                                                               | `ALTER ROLE … LOGIN PASSWORD` on the same four roles → `pg_authid`                                                                                                                                                                                                                        | once per `db:migrate` (`scripts/migrate.ts:28`)                                                                       |
| 5   | `packages/db/src/module-role-broker.ts:49-136` (`ensureModuleRoles` / `enableInstallerLogin` / `disableInstallerLogin`)                                                                                                         | `CREATE ROLE`/`ALTER ROLE` → `pg_authid`; `GRANT role TO role` → `pg_auth_members`                                                                                                                                                                                                        | per module-install flow and per module integration suite                                                              |
| 6   | `dropModuleRolesAtTeardown` (`tests/integration/test-database.ts:201-214`)                                                                                                                                                      | `DROP ROLE` → `pg_authid`                                                                                                                                                                                                                                                                 | per module suite teardown                                                                                             |
| 7   | `scripts/run-gate.sh:162-173`                                                                                                                                                                                                   | `DROP/CREATE DATABASE` → `pg_database`                                                                                                                                                                                                                                                    | once per gate — **already serialized** by `flock` on `$STATE_DIR/db.lock`                                             |
| 8   | `scripts/test-integration.ts:53-76`                                                                                                                                                                                             | `CREATE/DROP DATABASE` → `pg_database`                                                                                                                                                                                                                                                    | only when `JARVIS_PGDATABASE` is unset (ad-hoc runs; passthrough under run-gate, `scripts/test-integration.ts:19-21`) |
| 9   | `purgeModule` role section (`scripts/module-reconcile.ts:363-384`)                                                                                                                                                              | `REVOKE GRANT OPTION … CASCADE`, `DROP OWNED BY`, `DROP ROLE` on `jarvis_mod_<slug>_{install,runtime}` → `pg_authid`, `pg_auth_members` (role names derive only from moduleId, `packages/db/src/module-role-broker.ts:31-37` — cluster-global)                                            | per purge-marked module; live on real paths (container boot after migrate, root `db:reconcile`)                       |
| 10  | Inline job-search test cleanups (`tests/integration/job-search.test.ts:387-389`, `job-search-store.test.ts:59-60`, `job-search-worker-surface.test.ts:203-205`, `job-search-tables-install.test.ts:74-75`)                      | best-effort `DROP ROLE IF EXISTS … .catch(() => {})` → `pg_authid`                                                                                                                                                                                                                        | per suite teardown in those four files                                                                                |
| 11  | Worker-RPC membership revoke (`tests/integration/module-worker-rpc.test.ts:769`)                                                                                                                                                | `REVOKE jarvis_mod_acme_db_runtime FROM jarvis_worker_runtime` → `pg_auth_members` (runs before, not inside, the site-6 helper call at `:780`)                                                                                                                                            | per suite teardown                                                                                                    |
| 12  | Membership `GRANT`/`REVOKE` pairs in storage/worker RPC suites (`tests/integration/module-storage-rpc.test.ts:47,:63`, `finance-storage-migrate.test.ts:426,:452`, `module-worker-rpc.test.ts:753` — the setup pair of site 11) | role-to-role `GRANT … TO jarvis_app_runtime`/`jarvis_worker_runtime` in beforeAll, matching `REVOKE … FROM` in afterAll → `pg_auth_members`. Role names identical in every lane, so two staggered gates hit the **same** tuple (lane A's afterAll `REVOKE` vs lane B's beforeAll `GRANT`) | every gate run — these suites always run, so exposure exceeds site 9's purge path                                     |

Sites 9–12 were added in the 2026-08-14 revisions: the original discovery grep covered only SQL
directories (`infra/postgres/migrations/`, `packages/*/sql/`); re-running it over TS sources
(`scripts/`, `packages/`, `apps/`, `tests/`) surfaced sites 9–10, and widening the pattern itself
surfaced sites 11–12. The recorded pattern is now two-part: the role-DDL family
`CREATE ROLE|ALTER ROLE|DROP ROLE|DROP OWNED`, **plus** the role-to-role membership forms
`GRANT <role> TO …` / `REVOKE <role> FROM …` (non-`ON` forms only — `ON`-form statements are
per-database ACLs, out of scope). The membership half matters because the DDL-family pattern
matches none of the six membership statements, site 11 included. Its full disposition: the six
literal hits are sites 11–12; the one template-string hit
(`packages/db/src/module-role-broker.ts:75`) executes inside `ensureModuleRoles` — already
wrapped as site 5; the only SQL-dir hit is `0000_roles.sql:80` — already site 2. All other TS
hits of either pattern half are non-executors, verified individually: comments and doc strings;
`scripts/audit-release-hardening.ts:429` (reads the `rolcreaterole` attribute, no DDL);
`tests/unit/role-bootstrap.test.ts` (asserts SQL text, opens no cluster connection); schema/table
ACL `REVOKE`s (per-database, same class as the grants dir); and four test files
(`module-install`, `module-role-broker`, `module-worker-rpc`, `finance-tables-install`) whose
`DROP ROLE`s already route through site 6's `dropModuleRolesAtTeardown`.

Site 9's own file lock does not cover it:
`pg_advisory_lock(hashtext('jarv1s:module-reconcile'))` (`scripts/module-reconcile.ts:127`) is
taken on a session opened against the per-lane bootstrap URL — a per-database locktag — and is a
different key from `moss:cluster-ddl`, so it can never exclude the wrapped broker/teardown sites.
An unwrapped purge racing a wrapped broker call on the same module's roles is exactly the class
this spec closes, and the two-worktree gate proof would not reliably catch it (a reconcile must
happen to run in the window).

Sites 1 and 4 are the high-probability collisions: four fixed `pg_authid` tuples rewritten
unconditionally, over a hundred times per gate, by every lane on the cluster.

Because integration suites reset continuously for the whole 15–25 minute gate, the collision window
is effectively the entire gate, which is why overlapping gates fail nondeterministically in random
suites.

## Why the existing locks don't cover this

- `runSqlMigrations` takes `pg_advisory_lock(hashtext('jarv1s:migrations'))`
  (`packages/db/src/migrations/sql-runner.ts:198-204`) — but a Postgres advisory lock's locktag
  includes the **database OID of the session that takes it**. Two lanes on different
  `JARVIS_PGDATABASE`s take two independent locks and proceed concurrently. It correctly serializes
  same-database migrators and nothing else. (Migration files themselves contain no role DDL —
  verified by grep over `infra/postgres/migrations/` and `packages/*/sql/` — so this lock's scope
  gap is not itself a collision site today; the gap matters because it shows per-DB advisory locks
  cannot be the cross-lane mechanism.)
- `run-gate.sh`'s `flock $STATE_DIR/db.lock` (`scripts/run-gate.sh:162-173`) serializes only the
  gate DB DROP/CREATE at start, and only for processes sharing `/tmp` on this box. The
  `--exclusive` flag (`scripts/run-gate.sh:248-252`) holds it for the whole gate — which works, but
  serializes entire 20-minute gates and covers nothing that runs outside `run-gate.sh`
  (`pnpm db:migrate`, ad-hoc `pnpm test:integration`, module installs).

## Decision

Add one primitive to `@moss/db` — a **cluster-scoped advisory lock** — and hold it around exactly
the cluster-global DDL sections (sites 1–6 and 9–12). Nothing else changes: per-lane databases, migration
flow, and gate parallelism are preserved; only the seconds-long shared-catalog sections serialize.

### The primitive

`withClusterDdlLock(bootstrapConnectionString, fn)` in a new `packages/db/src/cluster-ddl-lock.ts`:

1. Derive a maintenance connection: the bootstrap URL with its database segment swapped to
   `postgres` — same intent as the prior art at `scripts/test-integration.ts:45-51`, but via
   `new URL()` pathname swap, **not** that file's trailing-segment regex, which would clobber a
   `?sslmode=…` query string — overridable via `JARVIS_CLUSTER_LOCK_DATABASE` (through
   `resolveMossEnv`) for clusters whose maintenance DB is named differently. Every lane shares
   host:port, so every lane's lock session lands in the same database and the advisory locktags
   finally collide — which is the point.
2. Open a dedicated session there, `SET lock_timeout` (default 120s, see Failure semantics), then
   `SELECT pg_advisory_lock(hashtext('moss:cluster-ddl'))` — session-level, matching the existing
   `hashtext(...)` key idiom in `sql-runner.ts:199`.
3. Run `fn`, then `pg_advisory_unlock` + close the session in `finally`.

**Crash recovery is inherent:** a session-level advisory lock evaporates when its backend exits —
process crash, `kill -9`, network drop, or Postgres restart. There is no lock file to go stale and
no cleanup path to build. This is the decisive advantage over any file-based lock.

### Wrap sites — the lock lives with the DDL, not with callers

Per the `wired-not-just-defined` lesson, acquisition goes inside the seam owners so future callers
cannot forget it:

- New `runClusterBootstrapSql(bootstrapUrl, directory)` in `@moss/db` =
  `withClusterDdlLock(…, () => runSqlFiles(…))`; `scripts/migrate.ts:23` and
  `tests/integration/test-database.ts:71` switch to it. Generic `runSqlFiles` stays lock-free — the
  grants directory (`scripts/migrate.ts:53`, `tests/integration/test-database.ts:88`) is
  per-database ACL work (verified: `infra/postgres/grants/*.sql` is schema/table/function GRANTs
  only) and must not serialize cross-lane.
- `applyRolePasswords` acquires internally.
- `ensureModuleRoles`, `enableInstallerLogin`, `disableInstallerLogin` acquire internally.
- `dropModuleRolesAtTeardown` acquires via the exported helper, and gains an optional
  `preDropSql` hook so the teardown membership `REVOKE`s — site 11 and site 12's afterAll pair
  (`module-storage-rpc.test.ts:63`, `finance-storage-migrate.test.ts:452`; both files already
  call the helper) — execute inside the same locked section instead of just before it.
- Site 12's beforeAll membership `GRANT`s (`module-storage-rpc.test.ts:47`,
  `finance-storage-migrate.test.ts:426`, `module-worker-rpc.test.ts:753`) route through a new
  sibling helper in `tests/integration/test-database.ts` — `grantModuleMembershipAtSetup` —
  which executes the passed statements inside the locked section. Setup and teardown helpers run
  in beforeAll/afterAll respectively, so they are siblings, never nested.
- `purgeModule` (site 9) wraps **only its role-DDL section** (`scripts/module-reconcile.ts:363-384`)
  internally, signature unchanged — steps 1–3 and 5–6 of the purge are per-lane table/row/file work
  and must not serialize cross-lane. The file's own `jarv1s:module-reconcile` advisory lock stays
  as-is (it serializes whole reconcile runs per lane; different job, different key).
- The four inline job-search cleanups (site 10) switch to `dropModuleRolesAtTeardown`, keeping
  their best-effort `.catch(() => {})` at the call site.

**Non-reentrancy constraint (binding):** the helper opens its own session per call, so a nested
call would self-deadlock against a sibling process only after first deadlocking on design review.
No wrapped section may call another wrapped section. Today none does (verified: `migrate.ts`
sequences sites 3→4 as sibling sections; the role broker is never called under site 3/4;
`reconcileModules` reaches the wrapped broker functions and the site-9 section as siblings, never
one inside the other). The implementation must document this constraint in a doc comment on
**every** wrapped function, not only the primitive, and the plan's source assertion covers both
script-level compositions (`migrate.ts`, `module-reconcile.ts`).

### Failure semantics (fail-safe, fail-closed)

- **Cannot acquire within `lock_timeout`:** throw with an error naming the lock, the lock database,
  and the likely holder ("another lane's bootstrap/migration section"). The gate goes red honestly.
  Never proceed without the lock; never fall back to unlocked DDL.
- **Cannot connect to the maintenance DB:** same — throw, red, actionable message naming
  `JARVIS_CLUSTER_LOCK_DATABASE` as the override.
- **Database targeting is untouched.** The helper wraps existing operations and passes their
  connection strings through unchanged; it computes no database names and issues no DROP/CREATE.
  It therefore cannot delete or migrate a sibling or shared database — the acceptance bound in
  #1013 — and the existing guards (`assertIsolatedTestDatabase`,
  `tests/integration/test-database.ts:49-60`; run-gate's prod-container refusal,
  `scripts/run-gate.sh:149-151`) remain the targeting defence, unmodified.

### Production posture

`db:migrate` at deploy and module installs will now take an uncontended cluster lock — a
few-millisecond overhead on a single-writer instance, no user-visible change, and the same
crash-safety. This satisfies "no production behavior changes" in the #1013 sense (dev/CI
reliability fix, no feature-visible delta). The env override exists for managed clusters without a
`postgres` maintenance DB; the dev/CI images (pgvector Postgres in compose) always have it.

## Rejected alternatives (steelmanned)

- **Serialize whole gates (`--exclusive` as default, or coordinator discipline).** Zero new code
  and already proven to work — but it turns two 20-minute lanes into 40 serial minutes, covers only
  `run-gate.sh` entry (ad-hoc `db:migrate`, module installs, and direct integration runs stay
  exposed), and reintroduces the manual fleet-serialization burden #1013 names as the impact.
- **A box-level file lock (`flock`) in Node around the DDL sections.** Same primitive run-gate
  already uses, no Postgres dependency — but Node has no native `flock` (new dependency or spawned
  process), and the scope is wrong: it guards the box, not the cluster. A lane in a container
  (UAT stacks) with its own `/tmp` hitting the same cluster bypasses it silently. The advisory lock
  is stored in the cluster it protects, so its scope is exactly the collision domain, and its
  crash-release is free.
- **Retry on `tuple concurrently updated`.** Masks the race instead of removing it, retries an
  internal-class error with no stable SQLSTATE contract, and leaves interleaved role-DDL storms
  (e.g. a module install-role password flip interleaving with a bootstrap reset) semantically racy
  even when no error surfaces.
- **Make the bootstrap conditional (skip `ALTER ROLE` when attributes already match).** Shrinks the
  write frequency but not the race: first-runs still collide, `applyRolePasswords` always writes,
  and check-then-write against a shared catalog is itself a race. Acceptable later as an
  optimization; not a serialization mechanism.

## Acceptance (from #1013, unchanged)

- Repo-owned cross-process serialization for cluster-global bootstrap/migration/reset DDL —
  the advisory-lock primitive above.
- Per-agent database isolation for data preserved — no change to `JARVIS_PGDATABASE` handling.
- A concurrent two-worktree proof no longer produces catalog tuple-update failures.
- Lock acquisition/release fails safely and cannot delete or migrate sibling/shared databases.

## Verification strategy

Two tiers, defined precisely in the plan:

1. **Smallest-runnable repeatable proof:** a concurrency harness that runs the locked seam
   (bootstrap SQL + role passwords) from two child processes against two distinct scratch databases
   on the dev cluster, N iterations. Without the lock (harness calls raw `runSqlFiles` directly) it
   must observe at least one shared-catalog error across its recorded runs — evidence, not a
   deterministic red, because the collision is a probabilistic catalog race; the observed error is
   recorded on the PR. With the lock: zero errors across all runs, every run.
2. **Acceptance proof (the issue's own):** two concurrent `scripts/run-gate.sh start` runs in two
   worktrees on the dev cluster, both reaching `DONE rc=0` with no `tuple concurrently updated`
   anywhere in either log. Run once by the builder, recorded on the PR.

Determinism boundary: not applicable — no user-facing surface and no model involvement anywhere in
this change. Live-path UAT: not required (internal tooling; `docs/DEVELOPMENT_STANDARDS.md`
Live-Path Gate out-of-scope clause).

## Out of scope

- `run-gate.sh`'s `flock` provisioning lock stays as-is (it guards site 7 adequately; the two locks
  protect disjoint tuple sets, so they cannot interleave into a collision).
- `runSqlMigrations`'s per-database advisory lock stays as-is (correct for its same-database scope).
- `scripts/test-integration.ts` DROP/CREATE stays as-is (distinct per-run database names; inserts of
  distinct `pg_database` rows do not contend on a tuple).
- No change to coordinator fleet policy; retiring manual gate serialization is a follow-up once the
  proof lands.

## Process notes

1. codebase-memory graph MCP tools were not mounted in the authoring session; grounding used
   direct `Grep`/`Read` on the named files, all citations verified in-tree at `be7edf725`.
2. `/grill-me-codex` was not run: this is a task-level infrastructure spec, not a milestone fork,
   and Fable review of this spec is the downstream gate. The two-alternative steelman above stands
   in for the adversarial pass.
