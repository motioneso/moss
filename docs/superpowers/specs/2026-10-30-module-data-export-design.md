# Downloaded-module data export: a module's own tables in the user archive

Status: Draft (2026-10-31), awaiting Ben's approval

Issue: #1694. Blocks #926 (Food), story 36. Consumer spec:
`docs/superpowers/specs/2026-08-18-926-food-nutrition-tracking.md:71-75`, `:219-220`, `:320-322`.

## Problem

A downloaded module's own tables never reach the user's export. Food, Finance and Job Search keep
meals, bank accounts and job applications in tables they own, and none of it is in the file a user
downloads from Settings. The app map tells users this outright. Food's approved spec cannot ship
without its history in the export, with a warning that food history is sensitive.

Verified against the tree at `39646acfe`:

| Claim                                                                                 | Evidence                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The archive has no downloaded-module section                                          | `UserDataExportTables` is a fixed interface, `packages/settings/src/data-export.ts:109-167`; the archive maps it field by field, `packages/settings/src/data-export-jobs.ts:94-173`                                                                                                               |
| A reader exists, but nothing calls it                                                 | `readExternalModuleExportRows`, `data-export.ts:229-250`; no caller, and not exported from `packages/settings/src/index.ts`                                                                                                                                                                       |
| That reader would fail on most module tables                                          | It sorts by `id` (`data-export.ts:245`). Nine owned tables have no `id` column, among them every Food table and `finance_items` (key `(owner_user_id, item_id)`, `external-modules/finance/sql/0001_create_finance_items.sql:4-12`)                                                               |
| Both export paths see built-in manifests only                                         | Worker job, `packages/module-registry/src/index.ts:1943-1948`; API route, `apps/api/src/server.ts:639`                                                                                                                                                                                            |
| The JSON manifest has no export field                                                 | `JsonMossModuleManifest`, `packages/module-sdk/src/external-module.ts:392-454`                                                                                                                                                                                                                    |
| `dataLifecycle` is forbidden, and any other new top-level key vanishes                | `FORBIDDEN_FIELDS`, `packages/module-registry/src/external/validate.ts:69-86` (`:84`), checked at `:555-559`; the re-shape allow-list drops unknown keys, `:923-963`                                                                                                                              |
| The worker cannot read the install journal                                            | `infra/postgres/migrations/0156_module_installs.sql:23-32` grants SELECT to the app runtime and migration owner only                                                                                                                                                                              |
| A module's key-value rows already export, and its credentials export as metadata only | `data-export.ts:170-178` with `packages/settings/sql/0302_module_kv_worker_export_select.sql`; `packages/settings/src/data-export-queries.ts:143-155`                                                                                                                                             |
| The archive already records partial coverage for vault files                          | `VaultFileExclusion` and the `complete`/`partial` status, `packages/settings/src/data-export-vault.ts:29-44`                                                                                                                                                                                      |
| The app map says downloaded-module data is omitted                                    | `packages/shared/src/app-map-core.ts:119`                                                                                                                                                                                                                                                         |
| The issue's "deletion is structural and working" is only half true                    | The deletion script's downloaded-module list is empty, `scripts/delete-user-data-cli.ts:49-53`. Rows still go, because every owned table's owner column cascades from `app.users` (`docs/superpowers/specs/2026-07-09-module-data-plane.md:275-297`). Only the per-table count report misses them |

## Seams this design relies on

| Capability                                                                                         | Citation                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Per-module runtime role, `NOBYPASSRLS`, granted to the app and worker roles without inheritance    | `packages/db/src/module-role-broker.ts:59-110` (`:74-75`, `:86-88`)                                                                  |
| Generated FORCE RLS owner-only policy on every owned table                                         | `packages/db/src/module-rls-emitter.ts:24-76`                                                                                        |
| Storage RPC switches to the module role for each query, with caps that a platform caller may lift  | `packages/db/src/module-storage-rpc.ts:6-13`, `:60-130` (`SET LOCAL ROLE` at `:89`)                                                  |
| A failed statement aborts the surrounding transaction; the RPC relies on that to drop the role     | `module-storage-rpc.ts:101-104`                                                                                                      |
| Qualified table names are checked before use                                                       | `module-rls-emitter.ts:12-18`                                                                                                        |
| Install journal lists each module's owned tables and runtime role, and survives disable and Remove | `0156_module_installs.sql:6-18`; written by `scripts/module-install.ts:146-163`, overwritten on each install                         |
| Only purge drops a module's tables, roles and journal row                                          | `scripts/module-reconcile.ts:442-503`; Remove keeps data, `docs/superpowers/specs/2026-07-12-module-distribution-install.md:291-304` |
| Install receives the validated manifest                                                            | `scripts/module-install.ts:45-62`                                                                                                    |
| Validator pattern for an optional top-level block with unknown keys rejected                       | `briefing`, `validate.ts:864-919`; `database` rejects unknown keys at `:819-821`                                                     |
| Owned tables are capped at 32 and must carry the module prefix                                     | `validate.ts:824-833`                                                                                                                |
| Validator rejects a package whose core range this host does not satisfy                            | `validate.ts:548`; `packages/module-sdk/src/core-version.ts:7`, `:81-115`                                                            |
| Manifest hash is taken over the validated manifest                                                 | `packages/module-registry/src/node.ts:144`, `packages/module-registry/src/external/hash.ts:26-27`                                    |
| Row normalising for export                                                                         | `data-export.ts:390-394`                                                                                                             |

## Decisions

1. Add an optional top-level `dataExport` block to the JSON manifest. It is data only. `dataLifecycle`
   stays forbidden.
2. The export learns each module's tables from the install journal, not from discovered manifests.
   Install also writes a snapshot of the validated `dataExport` block into the journal.
3. Export follows data. Every module with a journal row in `installed` status exports, whether it is
   enabled, disabled or Removed. A purged module has no row and exports nothing.
4. A module with owned tables and no declaration still exports every owned table, under one default
   section.
5. Rows are read through the storage RPC, under the actor's scoped database and the module's own
   role. No caps, as for core tables.
6. Rows are ordered by the table's primary key, read from the catalog.
7. Sensitivity is a closed list. The host owns the wording.
8. One module's failed read is recorded and skipped. The rest of the export completes.
9. Core bumps to `0.2.0`. A package that declares `dataExport` must require a core that excludes
   `0.1.0`.
10. Both export paths (the worker job and the older API route) share one reader inside
    `exportUserData`.

## Contract

### Manifest declaration

```ts
// packages/module-sdk/src/external-module.ts
export type ExternalModuleDataSensitivity = "health" | "financial" | "location" | "employment";

export interface ExternalModuleDataExportSection {
  /** Unique within the module. `^[a-z][a-z0-9_]{0,39}$`. */
  readonly key: string;
  /** Plain text, 1-60 characters. Appears only inside the archive. */
  readonly title: string;
  /** Non-empty. Each must be one of `database.ownedTables`. */
  readonly tables: readonly string[];
  readonly sensitivity?: ExternalModuleDataSensitivity;
  /** Keyed by a table in this section. Column names only, at most 32 per table. */
  readonly excludeColumns?: Readonly<Record<string, readonly string[]>>;
}

export interface ExternalModuleDataExportDeclaration {
  /** 1-16 sections. */
  readonly sections: readonly ExternalModuleDataExportSection[];
  /** Owned tables left out on purpose. The archive lists them with the reason. */
  readonly omitTables?: readonly {
    readonly table: string;
    readonly reason: "derived" | "cache" | "internal_state";
  }[];
}
```

Validator rules, all in `validate.ts` next to `database`:

- `dataExport` requires a non-empty `database.ownedTables`.
- Every owned table appears exactly once, in one section's `tables` or in `omitTables`.
- No table outside `ownedTables` may appear anywhere.
- Unknown keys are rejected at every level: the block, each section, each `omitTables` entry.
- `sensitivity` and `reason` accept only their listed values.
- `excludeColumns` keys must be tables of the same section. Column names match
  `^[a-z_][a-z0-9_]{0,62}$`.
- If `compatibility.jarv1s` is satisfied by `0.1.0`, reject with "dataExport requires
  compatibility.jarv1s to exclude core 0.1.0, for example >=0.2.0".
- The re-shape literal re-emits `dataExport` only when present.

Install checks that every excluded column exists once the module's SQL has run. A missing column
fails the install with the journal at `failed`, so a typo cannot quietly export a column the author
meant to leave out.

### Journal

A new core migration file adds `export_declaration jsonb` to `app.module_installs` and grants the
worker role SELECT, with a matching policy. The column is null for a module without a declaration.
`journalUpsert` writes it on every install, in the same statement that overwrites `owned_tables`.
No applied migration is edited.

`packages/settings/sql/0162_external_module_distribution.sql:5-6` says the app role cannot read the
journal, but `0156` grants it. The build checks the real grant on a fresh database and records what
it found in the PR.

### Archive

```jsonc
{
  "format": "jarvis-archive/v1",
  "manifest": {
    "vaultFiles": { "...": "unchanged" },
    "downloadedModules": {
      "status": "complete", // or "partial"
      "modules": ["finance", "food", "job-search"],
      "excluded": [
        {
          "moduleId": "finance",
          "table": "app.finance_activity",
          "reason": "read_failed",
          "sqlstate": "42P01"
        },
        {
          "moduleId": "job-search",
          "table": "app.job_search_rescore_state",
          "reason": "internal_state"
        }
      ]
    }
  },
  "sections": {
    "...": "existing sections unchanged",
    "downloadedModules": {
      "food": {
        "meals": {
          "title": "Meals",
          "sensitivity": "health",
          "sensitivityNote": "<fixed host wording for health data>",
          "tables": {
            "app.food_meals": [],
            "app.food_estimates": [],
            "app.food_estimate_items": []
          }
        }
      }
    }
  }
}
```

A module without a declaration gets one section with key `data` and its module id as the title.
The format string stays `jarvis-archive/v1`, because the change only adds keys.

## Collection

The reader runs inside `exportUserData` on the actor's scoped database.

1. Read journal rows in `installed` status, ordered by module id. Skip any id that matches a
   built-in manifest, so nothing exports twice.
2. Build each module's sections from `export_declaration`, or the default section when it is null.
3. For each table, check it is in that row's `owned_tables` and passes `assertQualifiedTableName`.
   A table that fails either check is excluded with no query run.
4. Read the table's columns and primary key from the catalog. Drop the excluded columns. Build
   `SELECT <columns> FROM <table> ORDER BY <key columns>` with quoted identifiers. A table with no
   primary key is sorted in memory on its canonical JSON form.
5. Run it through `createModuleStorageRpc` with all three caps set to null. The RPC switches to
   the module's role, and the generated policy narrows rows to the actor.
6. Each table's read runs inside its own savepoint. On failure, roll back to it, record the table
   as `read_failed` with its SQLSTATE, and move on. The error message is never stored.
7. Normalise rows with `normalizeRow` and place them as above. `data-export-jobs.ts` copies the
   new section and the new manifest entry into the archive.

`readExternalModuleExportRows` is replaced by this reader.

## Manifest hash and rollout

Existing manifests hash exactly as before, because the re-shape emits `dataExport` only when it is
present. A test pins the hash of every manifest under `external-modules/`.

A module that adds a declaration ships a new version. Through an admin download, the staged accept
rewrites both hashes (`scripts/module-reconcile.ts:340-359`), so the module stays enabled. That is
the same path as any upgrade. A changed directory with no staging is caught as drift and disabled
(`:405-425`), as it is today for any change.

The trap is a package with `dataExport` installed on today's host. Today's validator drops the key
without a word and hashes the manifest without it, and the admin approves that hash. After the host
upgrade, the same package hashes with the key. Its package hash is unchanged, so it stays enabled,
but its approval clears (`packages/module-registry/src/external/reconcile.ts:88-100`) and the worker
gate fails on the manifest hash (`apps/worker/src/worker-module-gate.ts:28-32`). Its queues and jobs
stop until an admin approves it again.

Decision 9 closes the trap. Today's host refuses a package requiring `>=0.2.0` at `validate.ts:548`,
so no host ever approves a hash taken without the key. Built-ins use `>=0.0.0`, and Food, Finance
and Job Search use `>=0.1.0`, so all of them still install on `0.2.0`. No package declares
`dataExport` before the host ships, so the new rule catches nothing already installed.

No module changes in this work. Food, Finance and Job Search export under the default section the
day the host ships. Each may add a declaration in its own PR, which also raises its core range.

## Security and RLS

- Rows are owner-only. Each read runs as the module's role, which has `NOBYPASSRLS`, against a FORCE
  RLS policy that admits only the actor's rows. No admin path exists, and no new role gets a bypass.
- The new grant gives the worker SELECT on the journal. The journal holds instance metadata (module
  ids, table names, role names, declarations) and no user content. Its policy is already
  `USING (true)` for the roles that read it.
- Module isolation holds. Core never names a module's table. Tables come from the journal, which
  install writes from the validated manifest. A declaration naming another module's table fails
  the validator, fails the journal check at step 3, and would still be denied by that table's grant.
- Credentials stay out. A module keeps credentials in `app.module_credentials` through `ctx.auth`,
  and that table exports metadata only (`data-export-queries.ts:143-155`), unchanged. The export
  cannot prove an owned table holds no secret. The developer guide says credentials belong in
  `ctx.auth`, and that `excludeColumns` trims noise and does not protect secrets.
- Error text stays out. An exclusion records a reason code and SQLSTATE only. The storage RPC keeps
  the primary error message, which can echo query text (`module-storage-rpc.ts:45-48`). That
  message reaches neither the archive nor the job's stored error (`data-export-jobs.ts:182-184`).
- Module-authored text is bounded. Section titles appear only inside the archive file, never on a
  screen in this work. Sensitivity wording comes from the host, picked by a closed value, which is
  the same rule preferences follow (`packages/module-sdk/src/external-module.ts:333-336`).
- Job payloads are unchanged. The export job still carries only the actor and job ids.

## Forks

### Fork A: where the declaration lives

| Option                                                | For                                                                                  | Against                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A1. New `dataExport` key (chosen)**                 | A shape built for JSON. A manifest that copies the built-in shape still fails loudly | One more top-level name                                                                                                                                                                                      |
| A2. Allow `dataLifecycle`, accept a JSON subset of it | One name for built-in and downloaded modules                                         | The built-in shape carries `collect` functions and deletion lists. A subset under the same name invites authors to paste fields that are then rejected. The forbidden list guards executable surfaces (#917) |

A1 wins because the two shapes do different jobs, and sharing a name would hide that.

### Fork B: where the export learns a module's tables and labels

| Option                                                           | For                                                                                                          | Against                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **B1. Journal, plus a declaration snapshot at install (chosen)** | Covers enabled, disabled and Removed modules. The worker needs no manifests. Tables are already listed there | One column and one grant in a new migration. Install writes one more field                                                     |
| B2. Discovered manifests                                         | No schema change                                                                                             | A Removed module has no folder, so its data drops out of the export without a word. The worker job would need discovery wiring |
| B3. Journal for tables, discovered manifests for labels          | No new column                                                                                                | After Remove, the module's excluded columns come back into the export                                                          |

B3 is the strongest rival. It loses because Remove would change what the export contains, and the
user did nothing to their data.

### Fork C: a module with owned tables and no declaration

| Option                                                            | For                                                                           | Against                                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **C1. Export every owned table under a default section (chosen)** | Fixes every installed module the day the host ships, with no module release   | The archive may carry internal state, such as lease tokens, until the module declares |
| C2. Export nothing until declared                                 | The archive holds only curated data                                           | Keeps today's gap, and leaves the user's data out without saying so                   |
| C3. Require a declaration whenever owned tables exist             | Matches the built-in rule (`packages/module-registry/src/index.ts:3524-3529`) | Every installed module fails validation, so the host upgrade disables all of them     |

C1 wins because leaving out the user's own data is the worse failure. Once each first-party module
declares, a later change can require a declaration for packages that target core `0.2.0`, as
built-ins already must.

### Fork D: sensitivity wording

| Option                                     | For                                                                | Against                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| **D1. Closed list, host wording (chosen)** | No module text becomes a privacy warning. Same rule as preferences | A module whose data fits no kind gets no warning until the platform adds one         |
| D2. Free-text note, length-capped          | Any module can say what it needs                                   | Module text on a privacy warning needs the determinism guards, and nobody reviews it |

D1 wins because a warning the host cannot vouch for is worse than a missing one.

### Fork E: one module's read fails

| Option                                  | For                                                                                  | Against                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **E1. Record it and carry on (chosen)** | The user still gets everything else. Matches how vault files report partial coverage | The archive is partial. Needs a savepoint per table                                                                                                                         |
| E2. Fail the whole export               | The archive is all or nothing                                                        | One broken module table, such as one an upgrade left missing, blocks the whole export until someone repairs the module. The job never retries (`data-export-jobs.ts:34-42`) |

E1 wins because the archive already says what it left out, so a partial export stays honest.

### Fork F: guarding the hash trap

| Option                                                                      | For                                                                                            | Against                                                                                         |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **F1. Core `0.2.0`, and a declaring package must exclude `0.1.0` (chosen)** | No host ever approves a hash taken without the key. Today's host already refuses such packages | One more validator rule. Module authors raise their range                                       |
| F2. Document "approve again after the upgrade"                              | No code                                                                                        | Queues and jobs stop until an admin notices, and it repeats for each module that declares early |

F1 wins because the failure in F2 is silent.

Row order is a decision, not a fork. Sorting by `id` breaks nine tables, and an unsorted read makes
archives differ run to run, so the primary key is the only order that works for every table.

## What does not change

- Built-in modules keep `dataLifecycle.exportSections` and `listModuleManifests`.
- The worker export job still passes built-in manifests only.
- Module key-value and credential export, vault files, and every existing archive section.
- Deletion. Owned rows still go by cascade, and the deletion script's empty list stays empty.
- The export job's payload, queue and retry setting.
- No new environment variable or settings file.
- No module package changes in this work.

## Out of scope

- Restore or import of an archive.
- Purge semantics (#951), third-party registries (#860 follow-ons), catalog signing (#1319).
- Any change to the export screen. See open question 1.
- Filling the deletion script's downloaded-module list. See open question 3.
- Moving built-in modules onto the JSON declaration.

## Tests

Integration tests run on a real database through the `verify-gate` skill, modelled on
`tests/integration/data-export.test.ts` and `tests/integration/finance-tables-install.test.ts`.
Modules are installed through `installModule`, not by hand.

| #   | Behaviour                                                                                                                                                                                                                                                                                                                   | A broken build fails because                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | Users A and B both own Finance rows. A's archive holds A's rows and none of B's. **Must be observed failing with the generated owner policy replaced by one that admits every row; record the run in the PR**                                                                                                               | The read skips the module role or the actor binding                                  |
| 2   | Finance tables with composite keys export in key order, and two runs give identical sections                                                                                                                                                                                                                                | Sorting by `id` throws; an unsorted read differs between runs                        |
| 3   | A disabled module's rows export. After Remove (folder gone, journal and tables kept), its rows export under its snapshotted titles                                                                                                                                                                                          | The reader keys on enablement or discovery                                           |
| 4   | A purged module contributes no section and no exclusion                                                                                                                                                                                                                                                                     | The reader trusts a stale list                                                       |
| 5   | A module with no declaration exports every owned table under section `data`                                                                                                                                                                                                                                                 | Undeclared modules are skipped                                                       |
| 6   | An excluded column's value appears nowhere in the archive bytes. **Must be observed failing with the column filter removed; record the run in the PR**                                                                                                                                                                      | The filter runs after serialising, or not at all                                     |
| 7   | One module's table is dropped. The export completes, other modules are present, the manifest says `partial` with `read_failed` and the SQLSTATE. The error's message text appears in neither the archive nor the job row. **Must be observed failing with the message copied into the exclusion; record the run in the PR** | No savepoint, so the whole export fails; or the message leaks                        |
| 8   | The worker role reads the journal, and an export job run through pg-boss produces an archive with module rows                                                                                                                                                                                                               | The grant is missing; today's worker cannot read the journal                         |
| 9   | Validator: a table outside `ownedTables` is rejected. **Must be observed failing with that check removed; record the run in the PR**                                                                                                                                                                                        | A module can point the export at a table it does not own                             |
| 10  | Validator: an owned table neither covered nor omitted, a table in two sections, an unknown key at any level, a free-text `sensitivity`, and a bad column name are each rejected; a valid block survives `validateExternalModuleManifest` unchanged                                                                          | Spread-through validation, or the re-shape forgets the field (`validate.ts:957-960`) |
| 11  | Validator: `dataExport` with `>=0.1.0` is rejected and with `>=0.2.0` accepted; `CORE_VERSION` is `0.2.0`. **Must be observed failing with the range rule removed; record the run in the PR**                                                                                                                               | The hash trap is open                                                                |
| 12  | Every manifest under `external-modules/` hashes the same as on `39646acfe`                                                                                                                                                                                                                                                  | The re-shape emits an empty `dataExport`, or changes key order                       |
| 13  | Install writes the snapshot, a reinstall with a changed declaration replaces it, and an excluded column that does not exist fails the install with the journal at `failed`                                                                                                                                                  | The snapshot goes stale, or a typo exports the column                                |
| 14  | The API route's response carries the same non-empty downloaded-module section as the worker archive                                                                                                                                                                                                                         | The two paths diverge                                                                |

Every test except 4 and 12 fails on today's tree. Tests 4 and 12 pass today and guard against
regressions. Test 2 also fails if the existing reader is wired in as it stands, on the `id` sort.

Live-path proof is recorded on the PR. On a dev instance, install Food and log a meal, run Prepare
export from Settings, download, and find the meal. Disable Food and repeat.

## App map

- `packages/shared/src/app-map-core.ts:119`, the profile settings entry, drops "downloaded-module
  private data" from what is omitted. It says that downloaded modules' own records are included,
  and that an export which could not read a module says so in its manifest.
- No module app-map change. Food states its export behaviour in its own manifest `features` in its
  own PR.
- `docs/module-developer-guide.md` gains a `dataExport` section covering the shape, the default
  section, the core range rule, and the warning that `excludeColumns` is not a secret store.

## Open questions

| #   | Question                                                                                                                                                                                                                                                                                                                                                                                     | Owner |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | Food's spec says export copy warns that food history is sensitive. This design puts that warning in the archive file only and changes no screen. Is that enough, or should the export screen's "Included" chips (`apps/web/src/settings/settings-profile-subviews.tsx:51-60`) gain a downloaded-modules entry and show the warning or a partial export? A screen change needs a mockup first | Ben   |
| 2   | Approve the sensitivity list (health, financial, location, employment). The host's wording for each goes in the build PR                                                                                                                                                                                                                                                                     | Ben   |
| 3   | Fill the deletion script's empty downloaded-module list from the same journal in this work, or as its own issue? Rows already delete by cascade; the list only feeds the per-table count. Recommendation: its own issue                                                                                                                                                                      | Ben   |
