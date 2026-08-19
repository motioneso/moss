# Relay — #1013 cluster-global DDL serialization (PR #1624 re-scope), Phase 3

From `opus-1013-reconcile-v4` to its successor. Phases 1 and 2 are committed and green; Phase 3 is
the heavyweight half and is yours. Read this doc, then the spec/plan **by section for the task you
are on** — never front to back. Reading is not progress; build and commit per task.

## The ruling you are executing

Ben, verbatim:

> Ben's ruling: (A). Re-scope #1624 in place — rebuild the affected files against #1632's new API
> (fn(guardedClient) callback, new diagnostics shape), re-run the two-worktree P1' proof, keep it as
> the existing issue/spec, amended. Proceed.

Issue #1013 and its spec stay; they get amended, not replaced.

- Spec: `docs/superpowers/specs/2026-08-13-1013-cluster-global-ddl-serialization.md`
- Plan: `docs/superpowers/plans/2026-08-16-1013-test-surface-ddl-lock.md`
- Worktree (reuse, do not recreate): this one. Branch `build-1013-ddl-lock`.
- `node_modules` already exists — `[ -d node_modules ] || pnpm install`, nothing more.

## Why this lane exists at all

#1632 shipped a liveness-aware cluster-DDL lock and wired **the production path only**. #1013's
actual collisions are on the **test path** — parallel gates racing `pg_authid` with
`XX000 tuple concurrently updated`. So spec acceptance #3 cannot be met by #1632 alone. The two
locks also use different keys (`moss:cluster-ddl` vs `jarv1s:cluster-ddl`), which is why
"merge both" was never an option. #1624's D1 fix is already free on main via `abortAcquisition`.

## Coordinator ruling: the lanes are SPLIT (2026-08-16)

Phase 2 does **not** ride PR #1624. Mixing production-path and test-path changes in one PR is what
the #1624/#1632 collision already punished once. The split is **done** — do not redo it:

| Branch | Head | Carries | Worktree |
| --- | --- | --- | --- |
| `build-1013-ddl-lock` | `705b1f03f` | Phase 1 only (test surface) | this one |
| `fix-1013-lock-domain-env-consistency` | `755e1aa2a` | Phase 2 only, on `origin/main` `24eb46e25` | `~/Jarv1s/.claude/worktrees/fix-1013-lock-domain` |

`755e1aa2a` is `4382823da` cherry-picked clean onto main and retargeted at **issue #1637**
(security tier, https://github.com/motioneso/moss/issues/1637). Its worktree has **no
`node_modules`** yet — it is the one place you do need `pnpm install`.

**Open the #1637 PR** from that branch (gate + PR + report) as a task alongside Phase 3. It is
self-contained: nothing in it depends on Phase 1.

**Do not add commits to `build-1013-ddl-lock` until the Coordinator reports the kill-gate verdict**
— it is gating Phase 1 at exactly `705b1f03f`. Resume Phase 3 on that branch afterwards.

**`origin/build-1013-ddl-lock` is stale at `8bc7cd112`** (pre-rebase), so PR #1624 on GitHub does
not show either commit. Local is `[ahead 50, behind 2]` of it — the eventual push needs
`--force-with-lease`, and nobody should read #1624's GitHub diff as current.

## Done — do not redo

| Commit | What |
| --- | --- |
| `705b1f03f` | Phase 1 — test-surface DDL under the lock. 13 files. |
| `755e1aa2a` | Phase 2 — injected-env lock domain on the install path. 3 files. Now on its own branch. |

**Phase 1** put the integration suite's cluster-global DDL on #1632's guarded DDL session:
`tests/integration/test-database.ts` gained `dropModuleRolesAtTeardown`,
`grantModuleMembershipAtSetup`, `revokeModuleMembershipAtTeardown` (all
`(statements, options?: ClusterGlobalDdlOptions)`), plus the bootstrap reset now runs inside
`withClusterDdlLock`. Nine call sites updated. New unit file
`tests/unit/test-database-role-ddl-lock.test.ts` (9 tests, DB-free via the DI seams).

Two build-time corrections were made and are already written back into the plan: `preDropSql` was
dropped, and the `client` parameter was dropped from all three helpers. Don't re-litigate them.

**Phase 2** threaded `WithClusterDdlLockOptions` through `scripts/module-install.ts` (all three
broker calls) and `scripts/module-reconcile.ts` (`const lock = { env }` → `purgeModule` +
`installModule`). New unit file `tests/unit/module-install-lock-domain.test.ts` (4 tests).

Verification of that content, all unpiped: `format` 0, `typecheck` 0, `lint` 0, `vitest run` on the
four lock tests **EXIT=0, 4 files / 30 tests**. Note those ran on the combined tree at
`4382823da`; re-run them in the `fix-1013-lock-domain` worktree before opening the #1637 PR, since
that branch stands on main without Phase 1.

## Phase 3 — yours

**(a) Extend `tests/unit/cluster-ddl-lock-wiring.test.ts`.** Keep main's six-category production
guard and its `LOCKED_SOURCES` list intact. Add the test-surface routing guard, and **amend the
claim that membership grant/revoke "is not a standalone call site"** — true for production, false
for the test suite, which is exactly why these races went uncovered. Match the file's existing
idiom: `readSource()` + whitespace-collapsed (`.replace(/\s+/g, " ")`) substring assertions.

**(b) `scripts/prove-cluster-ddl-lock.ts` (422 lines).** The plan says "re-author onto main's
`{type, ownerPid}` diagnostic shape" — **verify before you rewrite anything.** It already reads
`event.type === "acquired"` and `event.ownerPid` (`:106`, `:147-150`, `:202`) and `pnpm typecheck`
is green, so the shape work looks already done. Run it and check D2 attribution and
`--external-writer-demo` T3 behave, rather than assuming a rewrite is needed.

**(c) P1′ — the two-worktree proof.** Locked, N≥30, plus T3. Unpiped, exit code recorded:
`cmd > /tmp/x.log 2>&1; echo "EXIT=$?"`. This is the evidence Ben's ruling names explicitly.

**(d) Amend the #1013 spec** to match what shipped (issue and spec are kept, per the ruling).

**(e) `coordinated-wrap-up`** — clean tree, your own gate via the `verify-gate` skill, pre-push trio
+ fresh rebase, push, PR, report to the Coordinator. Then stop.

## Not yours — hard boundaries

- **The Phase 1 kill gate is the Coordinator's.** Two concurrent full gates from separate worktrees
  on separate gate DBs. Pass = zero `XX000 tuple concurrently updated` and zero unattributable
  errors. Known-accepted residual, **not** a trip: cross-lane `2BP01` `DROP ROLE` dependency errors
  from fixed module fixture ids. Escalate; do not self-adjudicate.
- **Never merge.** Security-tier merge needs the Coordinator plus Ben's explicit sign-off.
- **Never** move the board, close the issue, or close the milestone.
- **`docs/coordination/post1632-queue-2026-08-16.md` is coordinator-only** — read it for run
  context (queue table, merge order, CI waivers), never edit it.

## Traps that already cost time here

- **Never `pnpm verify:foundation` or any DB-touching test command without the `verify-gate`
  skill.** An unscoped run hits the live dev database.
- **Never pipe a verification command** — a pipeline reports the last stage's status, so a red gate
  exits 0.
- **Shared checkout.** Never `git add -A` / `git add .`, never bare `git commit`, never
  `checkout`/`stash`/`reset`. Commit explicit paths, `git diff` each file first, confirm with
  `git show --name-only HEAD`. Use the `shared-checkout` skill.
- **Ordering constraint, load-bearing:** membership `REVOKE` must precede the per-database revokes,
  which must precede `DROP ROLE` — Postgres refuses to revoke a grant-option privilege while a
  dependent downstream grant exists. That is why membership and role-drop are two separate
  sequential lock sections.
- **Reentrancy.** `withClusterDdlLock` holds a process-global `locking` flag and throws
  `ClusterDdlLockReentrancyError` on a nested call. Lock sections must be sequential siblings.
  Safe in tests only because `vitest.config.ts:319-320` sets `pool: "forks"` +
  `fileParallelism: false`.
- **Lock-domain split.** Advisory-lock tags are scoped by database OID. A lock taken in the wrong
  database still succeeds and excludes nobody — silent, no error, green suite. That is the entire
  Phase 2 defect class.
- `grep` on `packages/db/src/__tests__/fake-pg-cluster.ts` returned nothing through Bash in this
  session while the `Read` tool worked fine. If a grep comes back empty on a file you know has
  content, read it rather than concluding the content is absent.

## Coordination

Coordinator label is **`Coordinator`**; it was `coordinator-relay7` at the time of writing, but it
relays too — **resolve it fresh by label** (`herdr pane list`, confirm exactly one pane holds it)
and prefer the durable agent name from `herdr agent list`. Never address it by a `w1:pNN` number
copied from this doc; those reflow.

The Coordinator has already been told Phase 2 landed, that the kill gate is its call, and that
Phase 3 passes to you.
