# Plan — #1632 dual-session lease redesign of the cluster DDL lock

**Spec:** `docs/superpowers/specs/2026-08-14-1632-cluster-ddl-lock-liveness.md` (approved).
**Task issue:** #1632. **PR:** #1633 (branch `build-1632-liveness`). **Supersedes** the
single-owner-session design currently on this branch (`760a1d0c6` + fixes `d940eabf9`,
`f2f9dcd3d`).

Single phase. Contracts only — no function bodies; the builder writes code against the compiler
via TDD on this branch.

## Why the redesign (and why no third narrow fix)

The single-owner-session design makes one connection both hold `pg_advisory_lock` and execute
`fn`'s DDL. That forces an impossible choice, and each prior round picked a different horn:

1. `760a1d0c6`: owner on the maintenance DB → lock is cluster-wide, but target-DB-scoped DDL
   (GRANTs on `schema app`, extensions, `REVOKE … ON SCHEMA app`) runs against the wrong
   database → `42501` in CI compose smoke.
2. `d940eabf9`: owner on the caller's target DB → DDL works, but PostgreSQL advisory locks are
   **per-database** (the locktag includes the database OID), so two lanes on different target DBs
   each acquire "the" lock independently — cluster-global role DDL races again, the exact failure
   #1632 exists to prevent. Caught only by a fresh cross-model review: nothing in the fake-client
   suite or the single-DB CI smoke can observe cross-database lock exclusion.

Three facts are jointly unsatisfiable on one session: (a) the lock must live on the shared
maintenance DB (spec line 26), (b) the DDL must run connected to the caller's target DB (schema-
and extension-scoped statements at sites below), (c) one session connects to exactly one
database. The spec's design constraints (lines 60–63) anticipated this and name the fallback this
plan implements: **a dedicated lock session plus a separate DDL session, with the heartbeat/
lease-loss path and its race semantics specified and tested.**

## Design

### Sessions

- **Lock session** — connects to `getClusterLockDatabaseUrl(bootstrapConnectionString)` (the
  maintenance DB, default `postgres`, `MOSS_CLUSTER_LOCK_DATABASE`/`JARVIS_CLUSTER_LOCK_DATABASE`
  override preserved). Acquires and holds the session-level
  `pg_advisory_lock(hashtext(lockKey))`. Because every lane derives the same maintenance DB from
  its own bootstrap URL, the locktag's database OID is identical across lanes → true
  cluster-wide mutual exclusion, restoring invariant (a).
- **DDL session** — connects to `bootstrapConnectionString` unmodified (the caller's real target
  DB). `fn` receives a *guarded* view of this session and runs all protected DDL on it →
  invariant (b). No statement_timeout is set on it (bootstrap SQL may be long); acquisition
  `lockTimeoutMs` applies to the lock session only, as today.

No third probe connection. The old `pg_stat_activity`-polling probe existed because the owner
session was busy running `fn` and could not answer a heartbeat. In the dual-session design the
lock session is idle while `fn` runs, so it answers its **own** heartbeat — which is strictly
stronger than pid-polling (no pid-reuse hazard, no separate probe connection whose own death was
ambiguous) and removes a connection per invocation.

### Liveness: heartbeat + final check

Three detection channels, all raising `ClusterDdlLockLivenessLostError` with a distinct
`signal`:

1. `"connection-error"` — the lock session's `'error'` event fires (socket death pushed by the
   driver).
2. `"heartbeat"` — every `livenessIntervalMs` (default 250 ms, bounds [50, 5000] unchanged) the
   helper issues `SELECT 1` on the lock session. A rejection is liveness loss. So is an
   **overrun**: if the previous heartbeat has not settled when the next tick fires (hung TCP,
   network partition, server stall), that tick records loss instead of issuing another query.
   Worst-case detection latency is therefore ≤ 2 × `livenessIntervalMs` plus scheduler jitter —
   the documented bound the proof harness must measure (p50/p99/max).
3. `"final-check"` — after `fn` fulfills, the heartbeat timer is stopped and one fresh
   `SELECT 1` runs on the lock session **before success is reported and before unlock**. Failure
   here is liveness loss, not cleanup failure.

**Why the final check makes the success path airtight:** `node-postgres` clients never
auto-reconnect, and a session-level advisory lock is held exactly as long as its backend lives.
So if the final check succeeds, the lock session's backend was alive continuously from
acquisition through the last statement `fn` committed — meaning every committed statement
executed under the lock. Heartbeats bound *detection latency* for early abort; the final check
is the *serialization proof* for any run that reports success. A run whose lock died can
therefore never report success (spec contract items 1–3).

### Race semantics across the two-session boundary

Let T be the instant liveness loss is recorded.

- **Statements committed before T** were serialized (lock provably held — see final-check
  argument; if loss is detected mid-run, those commits still happened under the lock, and the
  run reports the typed liveness error, never success).
- **New statements after T**: the client handed to `fn` is a guard around the DDL session. Each
  `query()` checks the liveness state *before* issuing; once loss is recorded it rejects
  synchronously with the same `ClusterDdlLockLivenessLostError` and the statement never reaches
  the wire. Fail closed at the statement boundary (contract item 3).
- **The statement in flight at T**: its promise is raced against the liveness-loss promise; if
  loss wins, the guard rejects with the liveness error and the underlying result is discarded —
  it can never surface as success. The statement may still commit server-side; that residual
  window (one in-flight statement, bounded by detection latency + statement duration) is
  inherent to advisory-lock designs without transactional fence tokens. The spec addresses it
  via the measured detection bound (contract item 2), not by demanding perfect fencing; this
  plan does not wrap `fn` in a transaction because callers manage their own transactions
  (`runSqlFilesWithClient` BEGIN/COMMITs per file) and a wrapper would change call-site
  semantics for no complete fix (a lock-check-then-COMMIT pair has the same gap).
- **Outer settlement**: if `fn` was rejected *by the guard's own liveness error* (same error
  instance, or an error whose `cause` chain contains it), throw the liveness error alone. Only
  when `fn` fails with an **independent** error concurrent with liveness loss does the helper
  throw `AggregateError([livenessError, callbackReason])` — preserving today's contract without
  manufacturing duplicate-member aggregates.
- **DDL-session death is not liveness loss.** If the DDL session's socket dies mid-`fn`, the
  in-flight query rejects with the driver error, `fn` fails, and the (still-alive) lock session
  releases cleanly — an ordinary callback failure with the original error propagated untouched.
  The DDL session still gets an `'error'` listener (the round-1 BLOCKING-2 lesson: an unhandled
  `'error'` event crashes the process); the captured error surfaces on the next guarded query.
- **No false release (item 4)**: unlock is only ever attempted on the lock session that
  acquired, and only when liveness was never lost. `pg_advisory_unlock` from any other session
  is a server-side no-op by construction, and a dead owner's lock was already released by
  PostgreSQL — a stale owner cannot unlock or supersede a newer owner. Cleanup (`end()` both
  clients) is best-effort and idempotent.
- **Crash safety (item 5)**: backend/process/network death releases the session lock server-side;
  a waiter blocked in `pg_advisory_lock` acquires only after the owner backend is gone (never
  steals a live owner — that ordering is asserted in the fake-cluster tests and re-proven live
  by the harness).

### Ordering (normative)

connect lock session → `SET statement_timeout` (iff `lockTimeoutMs`) → `pg_advisory_lock` →
`SELECT pg_backend_pid()` (identity, for diagnostics/errors) → emit `acquired` → connect DDL
session → start heartbeat → run `fn(guardedDdlClient)` → `fn` settles → stop heartbeat →
(fulfilled path) final check → `pg_advisory_unlock` → emit `released` → end lock session → end
DDL session. Any failure before `fn` starts: release what was acquired, throw
`ClusterDdlLockAcquisitionError` (DDL-session connect failure included — protected work never
started; if the release also fails, `AggregateError([acquisition, cleanup])`).

## Seams check (file:line, verified on this branch at `f2f9dcd3d`)

| Assumed capability                                       | Evidence                                                                                                                                              |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current primitive to modify in place                     | `packages/db/src/cluster-ddl-lock.ts` (all of it), exported via `packages/db/src/index.ts:2` (`export *`)                                              |
| Maintenance-URL derivation to keep                       | `getClusterLockDatabaseUrl` — `cluster-ddl-lock.ts:104-113`, env override incl. MOSS/JARVIS precedence                                                 |
| Six call sites use only `client.query(text[, params])`   | `role-bootstrap.ts:102-110`; `module-role-broker.ts:58-80,112-120,131-137`; `scripts/migrate.ts:28-30` (via `runSqlFilesWithClient`); `scripts/module-reconcile.ts:375-401` |
| `runSqlFilesWithClient` accepts a minimal `{query}`      | `packages/db/src/migrations/sql-runner.ts:126-140` (`SqlFileClient`)                                                                                   |
| Target-DB-scoped DDL forces the DDL session onto target  | broker GRANTs on `schema app` (`module-role-broker.ts:81-83`), reconcile `REVOKE … ON SCHEMA app` (`module-reconcile.ts:379-386`), bootstrap extensions |
| Source-coverage guard to preserve                        | `tests/unit/cluster-ddl-lock-wiring.test.ts` — six-category guard, `new Client(` ban, migrate substring pins (all remain true under this design)        |
| Caller fake harness to replace                           | `packages/db/src/__tests__/fake-lock-client.ts` (single owner+probe pair; cannot model per-database locktags — the coverage gap behind both bugs)       |
| Proof harness to rework (not run)                        | `scripts/prove-cluster-ddl-lock.ts` — solo + single owner-loss trial; latency measured from run start, not kill instant                                 |

Open questions: none.

## Task 1 — rework the primitive (modified in place)

Per the spec's constraint (lines 68–70): **`withClusterDdlLock` is modified in place** — same
export name, same file. No superseded old export remains; the DI-seam renames below make any
code or test still wired to single-session semantics fail to compile rather than pass silently.

```ts
/** What `fn` receives: query-only view of the DDL session. Every call is liveness-guarded. */
export interface ClusterDdlSessionClient {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

/** Unchanged shape (connect/query/end/on/removeListener) — now used for BOTH real sessions. */
export interface ClusterDdlLockClient { /* as today, cluster-ddl-lock.ts:19-28 */ }

export type ClusterDdlLockLivenessSignal = "connection-error" | "heartbeat" | "final-check";

export type ClusterDdlLockDiagnosticEvent =
  | { readonly type: "acquired"; readonly ownerPid: number } // lock-session backend pid
  | { readonly type: "heartbeat"; readonly ownerPid: number } // one per successful beat
  | { readonly type: "released"; readonly released: boolean };

export interface WithClusterDdlLockOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly lockKey?: string;
  readonly lockTimeoutMs?: number;
  readonly livenessIntervalMs?: number;
  readonly createLockClient?: (connectionString: string) => ClusterDdlLockClient; // ← renamed
  readonly createDdlClient?: (connectionString: string) => ClusterDdlLockClient; // ← renamed
  readonly onDiagnostic?: (event: ClusterDdlLockDiagnosticEvent) => void;
}

export async function withClusterDdlLock<T>(
  bootstrapConnectionString: string,
  fn: (client: ClusterDdlSessionClient) => Promise<T>,
  options?: WithClusterDdlLockOptions
): Promise<T>;
```

Decisions bound by this plan:

- `createOwnerClient`/`createProbeClient` are **removed**, not aliased — the rename is the
  compile-time tripwire for stale wiring.
- All four typed errors keep their names and shapes; `ClusterDdlLockLivenessLostError` gains the
  `"final-check"` signal value. `ownerPid` on it remains the lock-session pid.
- Reentrancy guard (module-level flag, refuse before any connect), interval-bounds validation
  before connect, `safeDiagnosticEmitter`, `safeEnd`, and the doc-comment contract at the
  exported seam are all preserved; the doc comment is rewritten for the dual-session model and
  must state non-reentrancy, the ownership/liveness contract, and the in-flight-statement
  residual window (acceptance: "documents its non-reentrancy and ownership/liveness contract at
  the exported seam").
- The `heartbeat` diagnostic event is the "persisted owner-liveness trace" the proof gate needs;
  sinks remain observational only (a throwing sink never alters semantics — test 21).
- Stale comments describing the single-session design are updated in the same pass (spec-Nachlass
  discipline, `feedback-no-stale-concepts`): header of `cluster-ddl-lock.ts`,
  `scripts/migrate.ts:25-27`, `scripts/module-reconcile.ts` step-4 comment,
  `sql-runner.ts:126-135` (`SqlFileClient`/`runSqlFilesWithClient` doc), caller-test headers.

**Zero production call-site changes.** All six sites pass `options` through untouched and use
only `client.query(...)`, which `ClusterDdlSessionClient` still provides. Signatures of
`applyRolePasswords`, `ensureModuleRoles`, `enableInstallerLogin`, `disableInstallerLogin`,
`purgeModule`, and the `migrate.ts` composition are unchanged — satisfying contract item 6
without rewriting any site's SQL.

## Task 2 — the fake cluster harness (the coverage-gap fix)

Replace `packages/db/src/__tests__/fake-lock-client.ts` with
`packages/db/src/__tests__/fake-pg-cluster.ts`. The old harness handed out one owner + one probe
double and could not represent the property both bugs violated. The new one models the minimum
PostgreSQL semantics that make cross-database exclusion **unit-testable**:

```ts
export class FakePgCluster {
  /** Database identity = URL pathname. Each call is one session with a fresh pid. */
  createClient(connectionString: string): FakePgClusterClient;
  /** Backend death: in-flight and future queries on that session reject with a driver-style
   *  error, its 'error' listeners fire, and its advisory locks release (waiters wake). */
  killBackend(pid: number): void;
  /** Global ordered event log: connect / acquire / statement / unlock / end / kill,
   *  each entry carrying { pid, db, text? , maintenanceLockHolderPid }. */
  readonly log: readonly FakeClusterEvent[];
  /** Current holder of (db, key), if any. */
  advisoryLockHolder(db: string, key: string): number | undefined;
}
```

Semantics the fakes must honor (each is load-bearing for a test below):

- Advisory locks are keyed **per (database, key)** — exactly the real locktag rule. A helper
  that locks on the target DB passes single-lane tests but fails the cross-DB exclusion test;
  this is the regression the old fakes could not express.
- `pg_advisory_lock` blocks (unresolved promise) while held by another session on the same
  (db, key); grants FIFO on release or holder death.
- `pg_advisory_unlock` releases only if the calling session holds it; otherwise returns a
  falsy row, never throws — mirroring the no-false-release primitive.
- `pg_backend_pid()` returns the session pid; `SELECT 1` and arbitrary DDL text are logged as
  statements with a snapshot of who currently holds the maintenance-DB lock (this is how tests
  assert "every DDL statement executed while OUR lock session held the lock").
- A killed backend rejects the *currently in-flight* query too, not only future ones.

Caller tests get a thin convenience (`createFakeClusterHarness()`) returning
`{ cluster, options }` where `options` wires `createLockClient`/`createDdlClient` into one
cluster and records requested connection strings in creation order — replacing today's
`createFakeLockHarness` uses in `module-role-broker.test.ts` and
`tests/unit/role-bootstrap.test.ts`.

No live DB anywhere in Tasks 1–3; DB-touching concurrency/kill trials remain exclusively in
`scripts/prove-cluster-ddl-lock.ts` (Task 4, frozen).

## Task 3 — TDD test list

Rewrite `packages/db/src/__tests__/cluster-ddl-lock.test.ts` on the fake cluster. Each test
states behavior **and** why a broken implementation fails it.

1. **Session targeting**: lock client is created with `getClusterLockDatabaseUrl(bootstrapUrl)`;
   DDL client with `bootstrapUrl` unmodified. Fails against *either* prior bug — round 1 flipped
   the DDL side, round 2 flipped the lock side; this pins both axes at once.
2. **Cross-database exclusion (the centerpiece)**: two concurrent `withClusterDdlLock` calls on
   one `FakePgCluster` with bootstrap URLs naming *different* target databases; assert strict
   A-then-B serialization from the global log (B's first DDL statement after A's unlock), and
   that both lock sessions contended on the *same* (maintenance-db, key). Fails for any
   per-target-DB locking scheme — the exact `d940eabf9` regression. (Concurrent calls come from
   two harness "lanes"; the process-local reentrancy flag is a DI-visible seam — the builder
   exposes it for tests via the existing options object or module reset, builder's choice, so
   long as production behavior is unchanged.)
3. **Same-DB mutual exclusion**: as 2 with identical target DBs — the baseline property must
   also still hold.
4. **Lock-session connect failure** → `ClusterDdlLockAcquisitionError`; `fn` never runs; no DDL
   client is ever created. Fails if DDL setup precedes acquisition.
5. **DDL-session connect failure after acquisition** → `ClusterDdlLockAcquisitionError`
   (cause = connect error); the advisory lock was released (a second invocation acquires
   immediately in the fake cluster — no residue); `fn` never runs.
6. **Identity-query failure** → acquisition error; every opened session ended exactly once.
7. **Success path**: `fn` invoked exactly once with the guarded client; every `fn` statement
   logged on the DDL session/target DB; `pg_advisory_lock`/`unlock` appear only on the lock
   session; global order acquire ≺ first statement and last statement ≺ unlock; every `fn`
   statement's `maintenanceLockHolderPid` equals our lock-session pid.
8. **Lock-session `'error'` mid-`fn`** → `ClusterDdlLockLivenessLostError` with
   `signal: "connection-error"`; no unlock attempted on the dead session; both sessions ended.
9. **Heartbeat detects a killed lock backend during an idle callback** within one interval
   (`killBackend(lockPid)` while `fn` idles; assert rejection latency < documented bound, small
   real-timer interval as today).
10. **Heartbeat query rejection** (e.g. restart-style error) → liveness loss, `signal:
    "heartbeat"`.
11. **Heartbeat overrun**: previous beat unsettled when the next tick fires → liveness loss —
    the hang/partition case no prior design detected. Fails if the implementation only treats
    rejections as loss.
12. **Guard fails closed**: after recorded loss, the next `fn` query rejects with the liveness
    error and the statement never appears in the cluster log. Fails if the guard checks only at
    call-completion instead of pre-issue.
13. **In-flight statement at loss instant**: its promise rejects with the liveness error even if
    the fake backend later completes it; the result never surfaces. Fails if the guard doesn't
    race in-flight queries against the loss promise.
14. **Final check**: kill the lock backend after `fn`'s last statement settles but before the
    helper reports success → `ClusterDdlLockLivenessLostError` with `signal: "final-check"`,
    never a successful return. Fails for any design that treats "fn fulfilled" as terminal —
    this is contract item 2's "before allowing another protected DDL phase to be reported
    successful", pinned.
15. **DDL-session death is a callback failure, not liveness loss**: kill the DDL backend
    mid-`fn`; the original driver error propagates (no liveness wrapper), the lock releases
    cleanly on the live lock session, and a follow-up invocation acquires. Fails if the two
    sessions' failure classes are conflated.
16. **AggregateError discipline**: (a) `fn` rejecting with an *independent* error concurrent
    with liveness loss → `AggregateError([liveness, callback])`; (b) `fn` rejecting with the
    guard's own liveness error → that liveness error alone, no self-aggregate.
17. **Cleanup failures**: unlock failure after success + final check →
    `ClusterDdlLockCleanupError`; callback failure + unlock failure →
    `AggregateError([callback, cleanup])` (both members preserved).
18. **Exactly-once release**: success path unlocks once, ends each session exactly once, and
    leaves no lock residue (`advisoryLockHolder` undefined; a later invocation acquires).
19. **Waiter never steals a live owner**: lane B blocks while A's lock backend lives; after
    `killBackend(A)`, B acquires — and the log proves B's grant strictly follows A's kill.
20. **Reentrancy** refused synchronously before any connect (as today).
21. **Diagnostics**: throwing sink never alters outcome; success path emits `acquired` →
    ≥0 `heartbeat` → `released`; liveness-loss path never emits `released: true`.
22. **Interval bounds** rejected before any connection attempt (as today).
23. **`getClusterLockDatabaseUrl`** trio preserved verbatim (default + `JARVIS_` override +
    `MOSS_` precedence, query params intact).

Caller tests (updated in place, same files):

24. `module-role-broker.test.ts`: all role DDL statements run on the **DDL session** against the
    caller's connection string; lock/unlock only on the lock session against the maintenance
    URL; still no `new Client(` of the broker's own; acquire ≺ first DDL ≺ unlock ordering via
    the cluster log. (Replaces the `f2f9dcd3d` assertions that pinned the broken behavior.)
25. `tests/unit/role-bootstrap.test.ts`: same shape for the ALTER ROLE loop; password-plan
    behavior tests untouched.
26. `tests/unit/cluster-ddl-lock-wiring.test.ts`: survives as-is (its substrings —
    `withClusterDdlLock(urls.bootstrap,`, `runSqlFilesWithClient(client, bootstrapDirectory)`,
    the `new Client(` ban, the six-category guard incl. the explicit membership report — all
    remain true). Builder updates only comments that say "owner session"; the six-category
    source-guard requirement is **kept, not cut**.

## Task 4 — proof harness rework (reviewed, NOT run)

`scripts/prove-cluster-ddl-lock.ts` stays under the spec's Status-line freeze: **no execution
until the implementation review clears** — this task ships reviewable code only.

- `--mode=solo` — unchanged concept against the dual-session helper (≥30 iterations, suppressed
  diagnostics printed on failure only). The `heartbeat` diagnostic events are the persisted
  owner-liveness traces.
- `--mode=owner-loss --iterations=N` (default ≥30, was a single trial) — per iteration: acquire,
  kill the **lock-session** backend (pid from the `acquired` diagnostic; the admin connection
  targets the maintenance DB) mid-callback, assert `ClusterDdlLockLivenessLostError`, then a
  follower acquisition. Detection latency is measured **from the kill instant**
  (`killedAt → rejectionAt`), fixing the current start-anchored measurement, and the run prints
  **p50/p99/max** across all iterations plus the documented bound — the checklist's "records the
  measured owner-loss detection latency (p50/p99/max)" line.
- `--mode=cross-db` (new) — two child lanes against two per-run-unique scratch databases
  (`moss_ddlproof_<pid>_a/_b`, created/dropped by the harness only, never derived from
  `JARVIS_PGDATABASE`), each looping locked role DDL; assert zero overlap of locked sections and
  zero shared-catalog errors — the live twin of unit test 2.
- Also update its header comment: the "collapses lock-holder and DDL onto one owner session"
  rationale is now false.

## Preserved / changed / removed (vs. current `cluster-ddl-lock.ts`)

**Preserved**: export name + file (modified in place); `getClusterLockDatabaseUrl` + env
override + `DEFAULT_CLUSTER_LOCK_DATABASE`/`DEFAULT_CLUSTER_LOCK_KEY`; interval default/bounds
constants; all four typed error classes; reentrancy guard; `AggregateError` combination rules;
safe diagnostic emitter + observational-only sink rule; `safeEnd`; `acquired`/`released`
events; `lockTimeoutMs`-via-`statement_timeout` acquisition bound; all six production call
sites' signatures and SQL; the wiring/source-guard test; `runSqlFilesWithClient`/`SqlFileClient`.

**Changed**: one owner session → lock session (maintenance DB) + guarded DDL session (target
DB); `fn` parameter type narrows to `ClusterDdlSessionClient` (structurally compatible with
every caller); options seams `createOwnerClient`/`createProbeClient` →
`createLockClient`/`createDdlClient`; probe-based pid polling → self-heartbeat + overrun
detection + pre-success final check; `ClusterDdlLockLivenessSignal` gains `"final-check"`;
diagnostic events gain `heartbeat`; DDL-session connect failure classified as acquisition
failure with lock released; `fake-lock-client.ts` → `fake-pg-cluster.ts`; primitive and caller
tests rewritten per Task 3; proof harness per Task 4; stale single-session comments updated.

**Removed**: the probe client and `pg_stat_activity` pid polling (and its pid-reuse hazard);
`createProbeClient`/`createOwnerClient` option names; the "owner runs fn's DDL directly" doc
contract and the `f2f9dcd3d` assertions pinning it.

## Explicit scope cuts (named, not silent)

- **No live-DB execution in this build**: harness runs, the two-worktree full-gate proof, the
  measured p50/p99/max evidence, and the owner-loss trials are the spec's proof gate, executed
  only after the implementation review clears (spec Status line). This plan ships the harness
  code that will produce them; running it here would violate the gate. Any eventual DB-touching
  run requires the `verify-gate` skill + isolated `JARVIS_PGDATABASE`.
- **PR #1624 / #1013 stays frozen** — no code pulled from it; this branch remains
  self-contained per Ben's direction.
- **Non-blocking r1/r2 review findings** (5–6 items on PR #1633): dispositioned on the PR after
  this redesign lands — the builder re-reads the r2 review, marks each finding "moot under
  dual-session" or "still open", and lists the still-open ones on the PR. Not silently dropped;
  not expanded into this plan's bound.
- **Six-category source guard and membership explicit-report**: kept (Task 3 item 26) — no cut.

## Verification (builder runs; all unpiped, expected exit codes stated)

```bash
npx vitest run packages/db/src/__tests__/cluster-ddl-lock.test.ts \
  packages/db/src/__tests__/module-role-broker.test.ts; echo "EXIT=$?"   # expect EXIT=0
npx vitest run tests/unit/role-bootstrap.test.ts \
  tests/unit/cluster-ddl-lock-wiring.test.ts; echo "EXIT=$?"             # expect EXIT=0
npx vitest run tests/unit; echo "EXIT=$?"                                # expect EXIT=0 (full dir — the round-2 miss)
pnpm typecheck; echo "EXIT=$?"                                           # expect EXIT=0 — ROOT typecheck, never --filter (TS6059 false-reds)
pnpm lint; echo "EXIT=$?"                                                # expect EXIT=0
```

No DB-touching command of any kind. No `pnpm verify:foundation` (verify-gate skill territory,
and out of this build's bound regardless).

## Kill gate

**Observation that ends the line:** the guarded-client + final-check semantics cannot be
implemented without changing any of the six call sites' SQL or signatures, or a Task-3 test
cannot be expressed against the production seams without contorting them (a DI seam added only
for tests that alters production flow). Either means the two-session model as specified doesn't
fit the call-site contract — builder stops, posts the specific mismatch to #1632/PR #1633, and
the design comes back to Fable. No third narrow patch under any circumstances. **Call owner:**
Fable (coordinator escalates to Ben only if the re-diagnosis forks the design).

## Exit criteria

- [ ] Tests 1–23 green (fake cluster only, no live DB)
- [ ] Caller tests 24–25 green; wiring test 26 green unchanged in substance
- [ ] Full `tests/unit` + full `packages/db` suites green (not just touched files)
- [ ] Root `pnpm typecheck` / `pnpm lint` EXIT=0
- [ ] `scripts/prove-cluster-ddl-lock.ts` reworked per Task 4 and **not executed**
- [ ] No occurrence of `createOwnerClient`/`createProbeClient` anywhere in the tree
- [ ] Stale single-session comments updated at every site listed in Task 1
- [ ] PR #1633 updated with: design summary, the preserved/changed/removed inventory, the
      non-blocking-findings disposition, and the user-facing summary: "Not user-visible — dev/CI
      reliability: the cluster-wide DDL lock now survives lock-session death safely; parallel
      lanes on different databases can no longer run role DDL concurrently."
