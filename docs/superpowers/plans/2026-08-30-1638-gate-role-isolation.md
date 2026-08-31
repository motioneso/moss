# Plan — #1638 scope module roles once at the guarded integration runner

**Task issue:** #1638 (task, open)
**Tier:** routine test infrastructure
**Branch:** `plan/1638-gate-role-isolation`

Single session. No product identity, manifest, migration, table, or RLS assertion changes.

## Root cause and selected design

The four real job-search suites correctly install `moduleId = "job-search"`, but
`moduleRuntimeRoleName()` and `moduleInstallRoleName()` map that id to one pair of cluster-global
PostgreSQL roles. The #1632 lock serializes each catalog mutation; it cannot stop lane B from
dropping a fixed role after lane A releases the lock and starts using that role.

Set one test-only `JARVIS_TEST_MODULE_ROLE_SCOPE` in `scripts/test-integration.ts` from the lane's
resolved database name before spawning Vitest. The existing guarded runner already establishes
`JARVIS_PGDATABASE` before `runVitest()`, and the Vitest child inherits its environment. Make the
two role-name helpers incorporate that scope when it is present; keep today's byte-for-byte names
when it is absent.

The external-module child deliberately does **not** inherit arbitrary host variables
(`worker-runtime.ts` constructs an allowlisted environment containing only `LANG`, `LC_ALL`, and
`TZ`). That is not a blocker: the child never derives or assumes a PostgreSQL role. Its `db.query`
request returns to `createExternalModuleRpcHandler` in the Vitest/API host process, which calls
`createModuleStorageRpc` and derives the scoped runtime role there.

This is the smallest root seam:

- one runner assignment scopes the whole integration process consistently;
- install phases A/B/D, generated RLS, direct `SET LOCAL ROLE`, teardown, and worker-host
  `db.query` already converge on the two helpers;
- the four job-search suites remain unchanged, including every `moduleId = "job-search"` and real
  package/table/RLS assertion;
- unit tests and production do not run through `scripts/test-integration.ts`, so their default role
  names remain unchanged.

The #1632 lock remains necessary for atomic cluster-catalog writes, but each concurrent lane now
mutates a different role pair.

## Safety audit of runner-wide scoping

Repository-wide exact-name and catalog-assertion search found three concrete compatibility
obligations:

- `tests/integration/finance-tables-install.test.ts:38-43`
- `tests/integration/finance-storage-migrate.test.ts:429-474`
- `tests/integration/module-distribution.e2e.test.ts:423-502`

The two Finance suites hard-code `jarvis_mod_finance_runtime|install` in membership and teardown SQL.
Runner-wide scoping would make `installModule()` create scoped Finance roles while those statements
still target the unscoped names. Convert only those literals to the existing
`moduleRuntimeRoleName("finance")` / `moduleInstallRoleName("finance")` helpers. This is required
compatibility work, not expansion of #1638.

The module-distribution suite builds role names directly from `FIXTURE_TABLE_SLUG` in its install
and purge catalog assertions. Replace those constructed names (including the `LIKE` query) with
`moduleRuntimeRoleName(FIXTURE_MODULE_ID)` and `moduleInstallRoleName(FIXTURE_MODULE_ID)` parameters.
The remaining module integration suites already obtain names from the helpers or compare against
helper output, so they stay internally consistent. #1625 fixture ids become defense-in-depth
(fixture id plus runner scope), not a semantic change: their module ids were already synthetic and
their role names stay within the helper's new bound.

Do **not** special-case `job-search` inside production role naming to avoid the Finance edits. A
module-name allowlist in `@moss/db` would be a more fragile and less general test leak than fixing
the two stale literal sites.

## Seams check

| Capability                                                                | Evidence on current branch                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Guarded runner resolves an isolated or passthrough database before Vitest | `scripts/test-integration.ts:13-25`, `:90-112`                                                                      |
| Vitest inherits runner environment                                        | `scripts/test-integration.ts:73-88` (`spawn(..., { env: process.env })`)                                            |
| Module worker strips ambient env but role derivation stays host-side      | `packages/module-registry/src/external/worker-runtime.ts:261-270`; `worker-rpc-host.ts:296-326`                     |
| Integration files are sequential                                          | `vitest.config.ts:319-320` (`pool: "forks"`, `fileParallelism: false`)                                              |
| Both role names have one shared derivation seam                           | `packages/db/src/module-role-broker.ts:28-39`                                                                       |
| Install phases A/B/D use that seam                                        | `packages/db/src/module-role-broker.ts:51-138`; `scripts/module-install.ts:53-123`                                  |
| Generated table RLS uses the runtime helper                               | `packages/db/src/module-rls-emitter.ts:24-76`                                                                       |
| Worker-host `db.query` uses the runtime helper                            | `packages/module-registry/src/external/worker-rpc-host.ts:296-326` → `packages/db/src/module-storage-rpc.ts:60-130` |
| #1632 covers role create/login/disable/drop                               | `packages/db/src/cluster-ddl-lock.ts:197-266`; `tests/integration/test-database.ts:316-341`                         |
| Existing collision-resistant 8-hex convention                             | `tests/integration/test-database.ts:108-135`; `tests/unit/lane-scoped-module-fixture-id.test.ts:12-42`              |

Open questions: none.

## Task 1 — make the runner carry the actual lane identity

**Files:**

- `scripts/test-integration.ts`
- `tests/unit/test-integration-plan.test.ts`

Change `DatabaseIsolationPlan` so both modes carry the resolved database name:

```ts
export type DatabaseIsolationPlan =
  | { readonly mode: "passthrough"; readonly databaseName: string }
  | { readonly mode: "isolated"; readonly databaseName: string };
```

`createDatabaseIsolationPlan()` returns the existing `JARVIS_PGDATABASE` in passthrough mode and
the generated name in isolated mode. Update its existing unit assertion accordingly.

In `main()`, after creating the isolated database when needed and before `runVitest()`:

1. set `process.env.JARVIS_PGDATABASE = plan.databaseName` (same value in passthrough mode);
2. unconditionally set `process.env.JARVIS_TEST_MODULE_ROLE_SCOPE = plan.databaseName`.

Overwrite any caller-supplied test scope rather than trusting stale ambient state: the guarded
runner's resolved database is the source of truth. Do not add the variable to production compose,
`.env` templates, or `@moss/db`'s normal deployment configuration; it is owned solely by the test
runner.

Focused runner tests:

1. passthrough plan contains the supplied database identity;
2. isolated plan contains the generated identity;
3. empty `JARVIS_PGDATABASE` still selects isolated mode.

The two environment assignments are trivial wiring and need no exported setter or spawn mock.

## Task 2 — add opt-in scoping at the shared role-name root

**Files:**

- `packages/db/src/module-role-broker.ts`
- `tests/unit/module-role-broker.test.ts`

Preserve the public one-argument calls while allowing an explicit scope for deterministic unit
proofs:

```ts
moduleRuntimeRoleName(moduleId: string, scope?: string): string;
moduleInstallRoleName(moduleId: string, scope?: string): string;
```

When the explicit argument is absent, read `process.env.JARVIS_TEST_MODULE_ROLE_SCOPE`. Empty or
unset means the exact current unscoped name. Never infer a scope from `JARVIS_PGDATABASE`: that
variable exists in real deployments and would rename production roles during upgrade.

Scoped slug algorithm:

1. Validate and underscore-normalize the real module id exactly as today.
2. Hash `moduleId + "\0" + scope` with Node's built-in `createHash("sha256")`; keep 8 hex chars,
   matching #1625's accepted lane-hash convention.
3. Reserve 9 characters for `_<hash>` inside the existing 44-character role-slug budget. Keep at
   most the first 35 normalized module-id characters, then append `_<hash>`.
4. Build the existing `jarvis_mod_<slug>_runtime|install` form.

Hashing the tuple, rather than scope alone, keeps two long module ids with the same 35-character
prefix distinct within one lane. No new dependency, registry, or naming abstraction.

Focused unit cases:

1. Existing unscoped exact-name assertions remain unchanged.
2. Lane A and lane B scopes for the same real `job-search` id produce different runtime and install
   roles; the same tuple is deterministic.
3. A temporarily stubbed `JARVIS_TEST_MODULE_ROLE_SCOPE` produces the same names as the explicit
   argument, and the test restores it.
4. Two overlong ids sharing the same 35-character prefix remain distinct and both role variants are
   at most 63 characters.

These cases fail on the current tree because lane identity is ignored.

## Task 3 — remove the three integration exact-name hazards

**Files:**

- `tests/integration/finance-tables-install.test.ts`
- `tests/integration/finance-storage-migrate.test.ts`
- `tests/integration/module-distribution.e2e.test.ts`

Define `runtimeRole` and `installRole` once with the existing helpers and replace only the hard-coded
Finance role literals in membership, per-database privilege revoke, and
`dropModuleRolesAtTeardown` statements. Keep `moduleId = "finance"`, real Finance SQL/tables, revoke
ordering, and #1632 helpers unchanged.

In module-distribution, derive both role constants from `FIXTURE_MODULE_ID`; query `pg_roles` with
parameters for those exact names, assert installer `rolcanlogin = false`, and use the runtime
constant for the post-purge absence check. Do not retain a prefix `LIKE` assertion: scoped role
slugs deliberately truncate/hash and are no longer a direct expansion of `FIXTURE_TABLE_SLUG`.

Do not edit the four job-search suites. Their existing helper calls and indirect worker path are the
acceptance proof that runner inheritance reaches the whole real-module lifecycle without local
environment mutation.

## Task 4 — verification and concurrency proof

### 4.1 Non-DB checks

```bash
pnpm vitest run \
  tests/unit/module-role-broker.test.ts \
  tests/unit/test-integration-plan.test.ts \
  tests/unit/lane-scoped-module-fixture-id.test.ts
```

Expected: exit 0. This proves legacy names stay stable outside the runner, both runner plan modes
carry identity, scoped names differ, long names fit, and #1625 remains compatible.

### 4.2 Exact affected integration surface

Use the guarded runner:

```bash
pnpm test:integration \
  tests/integration/finance-tables-install.test.ts \
  tests/integration/finance-storage-migrate.test.ts \
  tests/integration/module-distribution.e2e.test.ts \
  tests/integration/job-search-store.test.ts \
  tests/integration/job-search-tables-install.test.ts \
  tests/integration/job-search.test.ts \
  tests/integration/job-search-worker-surface.test.ts
```

Expected: exit 0. The unchanged job-search suites prove real install/RLS/direct-role/worker-RPC
behavior; the Finance and module-distribution suites prove runner-wide scoping has no exact-name or
catalog-assertion regression.

### 4.3 Concurrency kill gate — required acceptance proof

From two clean worktrees at the same implementation commit, start the repository's guarded full
gate concurrently so each gets a distinct `jarvis_gate_<worktree>` database. Do not run bare or
piped `pnpm verify:foundation`; use the repo's gate workflow/skill.

Pass only when both full gates exit 0 and both logs show:

- distinct scoped job-search runtime and install role names (query a role sample if green output
  does not print them);
- zero `role ... does not exist` involving job-search roles;
- zero `password authentication failed` involving job-search install roles;
- zero `2BP01` involving the four real job-search suites;
- zero `XX000` / `tuple concurrently updated` (guards #1632).

Trip: either lane generates the same scoped pair, any root signature appears, or either gate is
red. Stop after one failed proof and diagnose; do not retry until green by chance.

## Concurrency argument

Let lanes A and B resolve distinct database names. The runner exports those names as distinct role
scopes before Vitest starts. Their job-search hash inputs are `("job-search", A)` and
`("job-search", B)`, so the focused unit assertion proves both generated role names differ. Every
integration host process inherits one immutable lane scope; the sandboxed module child delegates
all database access back to that host. Lane B's teardown can no longer drop or disable lane A's
roles, while both databases still install the real `job-search` identity, tables, and policies.

The 8-hex hash has the same deliberate ceiling already accepted for #1625. Revisit only if test
lane scale grows materially or an actual collision is recorded.

## Determinism, live path, and scope guard

No model, UI, or user-visible behavior. The focused unit test is the deterministic naming proof;
the two concurrent full gates are the live-path proof. Release note: `Category: N/A`.

Do not fix the unrelated GreenMail mailbox collision, replace #1632, or generalize this into
production multi-database role namespaces. File a separate issue if the concurrent proof exposes
one of those classes.
