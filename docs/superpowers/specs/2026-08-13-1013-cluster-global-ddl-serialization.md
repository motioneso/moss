# Cluster-global DDL serialization across parallel dev gates

**Date:** 2026-08-13

**Status:** Draft — awaiting Fable review

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
`infra/postgres/grants/*.sql`, `package.json`.

**Pre-build grounding gate:** rebase on then-current `main`, re-read the owned files, replace stale
line references before implementation.

## Problem

Every lane gets its own `JARVIS_PGDATABASE`, which isolates all per-database state (tables, per-DB
catalogs, per-DB ACLs). It cannot isolate the **shared** catalogs — `pg_authid`, `pg_auth_members`,
`pg_database` — which are one physical table per cluster. Concurrent writes to the same shared-catalog
tuple from two lanes produce `tuple concurrently updated`, a nondeterministic hard error.

The repo writes those same shared tuples on every gate run and every integration-suite reset:

| # | Site | Shared-catalog write | Frequency under one gate |
|---|------|----------------------|--------------------------|
| 1 | `infra/postgres/bootstrap/0000_roles.sql:35-65` | unconditional `ALTER ROLE` on the same four fixed roles → `pg_authid` | once per `db:migrate` **and once per integration suite file** (100+ resets per gate) via site 3 |
| 2 | `infra/postgres/bootstrap/0000_roles.sql:80` | `GRANT jarvis_auth_runtime TO jarvis_migration_owner` → `pg_auth_members` | same as site 1 |
| 3 | `runSqlFiles` on the bootstrap dir — `scripts/migrate.ts:23` and `tests/integration/test-database.ts:71` (`resetEmptyFoundationDatabase`) | executes sites 1–2; `runSqlFiles` (`packages/db/src/migrations/sql-runner.ts:114`) holds **no lock of any kind** | as above |
| 4 | `applyRolePasswords` (`packages/db/src/role-bootstrap.ts:97-110`) | `ALTER ROLE … LOGIN PASSWORD` on the same four roles → `pg_authid` | once per `db:migrate` (`scripts/migrate.ts:28`) |
| 5 | `packages/db/src/module-role-broker.ts:49-136` (`ensureModuleRoles` / `enableInstallerLogin` / `disableInstallerLogin`) | `CREATE ROLE`/`ALTER ROLE` → `pg_authid`; `GRANT role TO role` → `pg_auth_members` | per module-install flow and per module integration suite |
| 6 | `dropModuleRolesAtTeardown` (`tests/integration/test-database.ts:201-214`) | `DROP ROLE` → `pg_authid` | per module suite teardown |
| 7 | `scripts/run-gate.sh:162-173` | `DROP/CREATE DATABASE` → `pg_database` | once per gate — **already serialized** by `flock` on `$STATE_DIR/db.lock` |
| 8 | `scripts/test-integration.ts:53-76` | `CREATE/DROP DATABASE` → `pg_database` | only when `JARVIS_PGDATABASE` is unset (ad-hoc runs; passthrough under run-gate, `scripts/test-integration.ts:19-21`) |

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
the cluster-global DDL sections (sites 1–6). Nothing else changes: per-lane databases, migration
flow, and gate parallelism are preserved; only the seconds-long shared-catalog sections serialize.

### The primitive

`withClusterDdlLock(bootstrapConnectionString, fn)` in a new `packages/db/src/cluster-ddl-lock.ts`:

1. Derive a maintenance connection: the bootstrap URL with its database segment swapped to
   `postgres` — the exact prior art at `scripts/test-integration.ts:45-51` — overridable via
   `JARVIS_CLUSTER_LOCK_DATABASE` (through `resolveMossEnv`) for clusters whose maintenance DB is
   named differently. Every lane shares host:port, so every lane's lock session lands in the same
   database and the advisory locktags finally collide — which is the point.
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
- `dropModuleRolesAtTeardown` acquires via the exported helper.

**Non-reentrancy constraint (binding):** the helper opens its own session per call, so a nested
call would self-deadlock against a sibling process only after first deadlocking on design review.
No wrapped section may call another wrapped section. Today none does (verified: `migrate.ts`
sequences sites 3→4 as sibling sections; the role broker is never called under site 3/4). The
implementation must document this at the helper and the plan adds a test asserting the sections are
siblings, not nested.

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
