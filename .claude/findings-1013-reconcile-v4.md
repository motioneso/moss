# PR #1624 (#1013) reconcile v4 — finding: not a rebase, a re-scope

**Agent:** `opus-1013-reconcile-v4` · **Date:** 2026-08-15 · **Tier:** security
**Branch:** `build-1013-ddl-lock` @ `8bc7cd112` · **Target:** `origin/main` @ `389e96488`

## Verdict

**STOP — escalating before touching the tree. P1′ was not run.**

The kill-gate authorized "rebase onto new main, reconcile the two lock designs, re-run P1′." The
rebase is not mechanically reconcilable: **#1632 independently re-implemented #1013's core
deliverable**, and what remains of #1624 is a *different, smaller* change that must be rebuilt on
#1632's API. That is a re-scope decision, which per `coordinated-build` step ½ and the standing
kill-gate ("excursion ⇒ STOP, spec reopens") is the Coordinator's call, not mine.

This is **not** a P1′ red. P1′ was deliberately not run — the code it would prove no longer has a
settled shape.

## Evidence

`git merge-tree --write-tree HEAD origin/main` → 8 conflicts, **4 of them `add/add`**:

| File | Conflict | Meaning |
|---|---|---|
| `packages/db/src/cluster-ddl-lock.ts` | add/add | both branches wrote the lock from scratch |
| `packages/db/src/__tests__/cluster-ddl-lock.test.ts` | add/add | both wrote its unit tests |
| `scripts/prove-cluster-ddl-lock.ts` | add/add | both wrote a proof harness |
| `tests/unit/cluster-ddl-lock-wiring.test.ts` | add/add | both wrote a wiring guard |
| `module-role-broker.ts`, `role-bootstrap.ts`, `migrate.ts`, `module-reconcile.ts` | content | both wired the same 4 production call sites |

`add/add` on every core file is the signature of duplicated work, not divergent history.

**The two locks do not exclude each other.** #1013 takes `hashtext('moss:cluster-ddl')`; #1632
takes `hashtext('jarv1s:cluster-ddl')` (`DEFAULT_CLUSTER_LOCK_KEY`). Shipping both yields two
disjoint advisory locks and zero added serialization — so a merge-both outcome is not available.

## What #1632 already delivers (#1624 redundant here)

Main's `withClusterDdlLock` is a strict superset of #1013's on the production path: same
maintenance-DB strategy, same `JARVIS_CLUSTER_LOCK_DATABASE` env var, **plus** dual-session
liveness (connection-error + heartbeat + final-check), a DI seam, and enforced reentrancy
refusal. It already wraps `ensureModuleRoles`, `enableInstallerLogin`, `disableInstallerLogin`,
`applyRolePasswords`, `migrate.ts` bootstrap, and `purgeModule`'s role block.

Notably, **#1624's D1 fix is free on main** — main's unconditional `pg_backend_pid()` probe routes
failure through `abortAcquisition` ⇒ `ClusterDdlLockAcquisitionError` before the callback starts,
which is exactly D1's requirement, reached by a better route.

## What #1624 still uniquely delivers — and #1632 does NOT

**#1013's actual problem is unsolved on main.** #1632 locked the *production* path. The collisions
#1013 exists to fix happen on the *test* path, which main leaves bare:

- `tests/integration/test-database.ts:71` — `runSqlFiles(bootstrap, …/bootstrap)`, **unlocked**.
  This is spec **site 3**, ~100+ resets per gate.
- `tests/integration/test-database.ts:207` — `DROP ROLE IF EXISTS`, **unlocked**. Spec **site 6**.
- 8 integration test files still issue raw role DDL / membership `GRANT`/`REVOKE` unlocked.

Main's own wiring test states category six, membership grant/revoke, is "not a standalone call
site" — true for production, false for the test suite, which is where the tuple races occur.

Spec acceptance #3 — *"a concurrent two-worktree proof no longer produces catalog tuple-update
failures"* — therefore **cannot be met by #1632 alone**. #1624's residual value is real and is the
part that closes #1013.

Residual set: test-surface locking (`test-database.ts` + ~8 suites, `grantModuleMembershipAtSetup`,
locked `dropModuleRolesAtTeardown`), the 12-site repo-wide discovery-surface guard (main's is a
6-category production guard), `tests/integration/cluster-ddl-lock.test.ts` (kill-recovery),
`scripts/module-install.ts` lock-option threading, and the richer two-worker proof harness
(attribution classification + external-writer demo).

## Why the residual can't be lifted across mechanically

| Aspect | #1013 (#1624) | #1632 (main) |
|---|---|---|
| callback | `fn()` — caller owns its connections | `fn(client)` — helper owns the DDL session; callback must use the **guarded** client |
| bootstrap helper | `runClusterBootstrapSql(url, dir, opts)` | **absent**; callers use `withClusterDdlLock(url, c => runSqlFilesWithClient(c, dir))` |
| options / diagnostics | `ClusterDdlLockOptions.diagnostics`, event `{state, timestamp, database, backendPid, serverAddress, serverPort, applicationName}` | `WithClusterDdlLockOptions.onDiagnostic`, event `{type, ownerPid}` / `{type, released}` |
| errors | `AcquisitionError(msg, {cause})` | `AcquisitionError(cause)` + `LivenessLost` / `Cleanup` / `Reentrancy` |
| reentrancy | doc comment only | **enforced** process-global |

Two consequences that need a decision rather than an edit:

1. Every residual site must move its DDL onto the **guarded** session. Running statements on the
   caller's own client inside the lock still compiles and still holds the lock, but silently
   forfeits #1632's liveness guarantee — the whole point of the merged design. Per-database
   `REVOKE`s in the teardown path need per-site checking that the guarded session lands on the
   right database.
2. The proof harness must be re-authored: #1624's attribution/trace machinery is built on the old
   diagnostic event shape, and main has its own ported-down harness. T3 (external-writer demo) has
   to be rebuilt against main's events before P1′ means anything.

Reentrancy checked and **not** a blocker: `vitest.config.ts:319-320` sets `pool: "forks"` +
`fileParallelism: false`, so test-surface lock sections stay sequential siblings.

## Options

- **A — Re-scope #1624 to the test-surface delta on #1632's lock (recommended).** Take main's side
  wholesale for all 4 `add/add` files and the 4 production wiring files; rebuild only the residual
  set above against the new API; re-run P1′. Honest, closes #1013's acceptance, drops ~60% of the
  PR as superseded. Cost: real authoring (~10 files + harness merge) + a live N≥30 run — beyond
  one bounded mechanical cycle and beyond the bound-file list, hence this escalation.
- **B — Close #1624 as superseded, open a new task issue** for "lock the test-suite DDL surface"
  against #1632's lock. Same end state as A, clean history, new spec scoped to what's actually
  left. Costs the PR's review history.
- **C — Land #1624's lock instead of #1632's.** Not viable: #1632 is merged, liveness-aware, and
  strictly better; reverting it re-opens a closed design.

I recommend **A or B on engineering grounds and defer between them to you** — the difference is
process (amend #1013's spec vs. open a successor issue), which is yours and Ben's call.

## State left behind — nothing destroyed

- **Working tree untouched.** No rebase, no stash, no reset, no commit. `git status` is exactly as
  I found it.
- The Fable-verified D1/D2/T1–T3 uncommitted diff is **preserved** at
  `.claude/patches/1624-d1-d2-t1-t3-fable-verified-at-8bc7cd112.patch`
  (491 lines, sha256 `c042093f902a16e6e98b6a4b5b25d5f781d921b60bfba5c9cdf7258ff7d3e75f`,
  verified an exact capture via `git apply --check --reverse`). It still applies to
  `8bc7cd112`. Under options A/B its D1 is obsolete (free on main) but its D2/T3 attribution
  design is the reference for rebuilding the harness — keep it.
