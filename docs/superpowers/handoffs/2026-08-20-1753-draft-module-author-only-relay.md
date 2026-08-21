# Relay — #1753 draft module (author-only), continue here

**Worktree/branch:** this same worktree, branch `1753-draft-module-author-only` (do NOT `pnpm install` — `node_modules` already present).
**Coordinator:** Herdr label `Coordinator`, agent name `coord1739relay10` — confirm both still resolve to one pane via `herdr pane list` before messaging (names/labels can change on the next relay).
**Original task brief:** `docs/coordination/boot-1753-draft-module-author-only.txt`
**Handoff doc (read first, short):** `docs/coordination/handoff-1753-draft-module-author-only.md`
**Plan section to build (read ONLY this, from git object store, never checkout the branch):**
```
git show plan/1739-stage1-workshop:docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md | sed -n '550,1052p'
```
That's "Group B — #1753", Tasks 5-10.

## Already sent to the coordinator (FYI, not blocking)

Task 9 in the written plan proposed adding a `forUserId` parameter to the worker's
`isModuleEnabled` check. Grounding found this is unnecessary: `apps/worker/src/worker.ts`
already keeps the whole-module gate (`isModuleEnabled`, module-level) separate from the
per-user fan-out list (`listActiveUserIds`, calls `app.list_active_external_module_users`).
Task 7 already makes that database function owner-only for drafts, so per-user scoping is
free once Task 7 lands. Task 9's real fix is just: widen `isModuleEnabled`'s status check to
accept a draft (in addition to enabled), with matching hashes. No new parameter, no other
caller changes. The coordinator was told this; proceed accordingly, no need to re-ask.

## What's actually done (commit `49117087d` on this branch)

- `packages/settings/sql/0159_external_modules_draft_owner.sql` — the migration exactly as
  the plan specifies: adds `owner_user_id uuid NULL REFERENCES app.users(id) ON DELETE CASCADE`,
  widens the status CHECK to `('enabled','disabled','draft')`, adds the paired
  `external_modules_draft_has_owner` CHECK. **Not yet run against any database** — nothing has
  verified the existing constraint name (`external_modules_status_check`) or run the migration.
- `packages/db/src/types.ts` — `ExternalModulesTable.status` widened, `owner_user_id: string | null`
  column added.
- `packages/settings/src/repository-external-modules.ts` — `ExternalModuleState` and
  `ExternalModuleAdminState` both gained `ownerUserId: string | null`; `listExternalModuleStates`
  and `listExternalModuleAdminStates` now select/map `owner_user_id`. The three existing
  `insertInto("app.external_modules")` call sites (`setExternalModuleEnabled`,
  `writeExternalModuleDisabledRow`, `updateExternalModuleStaging`) now pass `owner_user_id: null`
  explicitly (required since the column is a plain nullable, not a `ColumnType` with an
  optional-on-insert default — same pattern as `disabled_reason`).

## Real grounding facts for the rest of Group B (save yourself re-deriving these)

- **No test file existed anywhere for these repository functions until now** — actual test
  location is `tests/integration/external-modules-repository.test.ts` (NOT
  `packages/settings/src/external-modules-repository.test.ts` as the plan's illustrative path
  says — this repo puts integration tests in a top-level `tests/` tree). It uses
  `SettingsRepository` class methods (`setExternalModuleEnabled` etc.) under
  `DataContextRunner.withDataContext({ actorUserId, requestId }, ...)`, with `ids.userA`,
  `ids.userB`, `ids.adminUser` from `tests/integration/test-database.ts`. There is no generic
  `insertExternalModule(db, {...})` helper anywhere — the plan's test pseudocode assumes one that
  doesn't exist. For Task 5's CHECK-constraint tests, insert directly via
  `scopedDb.db.insertInto("app.external_modules").values({...}).execute()` inside
  `runner.withDataContext({ actorUserId: ids.adminUser, ... }, ...)` (RLS INSERT requires an
  admin actor) — don't invent a new production "create draft" repository method for this test;
  Task 5's plan scope is the migration + type change only.
- **`repository.ts` is explicitly at its 1000-line file-size gate cap** (see comment right above
  `externalModuleAuditWriter`) — it says "no new delegates" and #964 already worked around this
  by calling `repository-external-modules.ts` functions directly from routes instead of adding
  new `SettingsRepository` methods. Follow that precedent for anything Task 10 (`shipModule`)
  needs — do not add a new class method to `repository.ts`.
- **reconcile.ts** (`packages/module-registry/src/external/reconcile.ts`) currently has exactly
  two explicit branches (`no row` → discovered, `status === 'disabled'`) and falls through
  everything else (including any future `'draft'` status) into the hash-compare/drift branch —
  confirmed this is the real trap Task 6 describes. Its test lives at
  `tests/unit/external-reconcile.test.ts`, not `packages/module-registry/src/external/reconcile.test.ts`.
- **`ReconciledExternalModule` / `ExternalModuleStateInput`** types are in
  `packages/module-registry/src/external/types.ts` — both need `status`/`ownerUserId` additions
  mirroring what Task 5 already did for the settings-package types (status literal type needs
  `"draft"`; `ExternalModuleStateInput` needs an `ownerUserId: string | null` field; add the same
  to `ReconciledExternalModule`).
- **`apps/api/src/external-module-tools.ts`** — `createActiveExternalModulesResolverForApi` (the
  actual function, confirmed present) takes `{ appDataContext, settingsRepository, discoveries }`
  at construction and returns `async (accessContext) => ...` — it does NOT take an actor at
  construction time as the plan's Interfaces section assumes; the actor arrives per-call via
  `accessContext.actorUserId`. Filter today is
  `modules.filter((module) => module.active && !disabled.has(module.id))`. Add the ownership
  check inside that per-call closure, not at construction.
- **Task 9 worker gate** — see "already sent to the coordinator" above. `isModuleEnabled` lives
  inline in `apps/worker/src/worker.ts` around line 315 (`new ExternalModuleJobReconciler({...
  isModuleEnabled: async (moduleId) => {...} })`), checks
  `state?.status === "enabled" && state.manifest_hash === module.manifestHash && state.package_hash === module.packageHash`.
  Extract to a named `createIsModuleEnabled` (single `moduleId` param, no `forUserId`) and widen
  the status check to `(state.status === "enabled" || state.status === "draft")`.
- **Migration numbering:** 0159 and 0160 (the plan's assumed numbers) are confirmed free — highest
  existing is 0184, with gaps at 0155/0156/0159/0160/0161/etc. already used by other lanes. Safe
  to use both as the plan specifies, but re-check `ls packages/settings/sql/` before creating 0160
  in case another lane claimed it since this doc was written.

## Next concrete steps (in order)

1. Finish Task 5's test in `tests/integration/external-modules-repository.test.ts` per above,
   run `pnpm --filter @jarvis/settings test -- external-modules-repository` (or the correct
   package filter — check `package.json` name), confirm it fails first (no migration applied
   yet), then figure out this repo's migration-apply-to-test-db command (check
   `docs/DEVELOPMENT_STANDARDS.md` / root `package.json` scripts — do NOT improvise; this is
   DB-touching, use the `verify-gate` skill's recipe, not an ad hoc `pnpm verify:foundation`),
   confirm it passes, commit (amend the WIP commit or add a new one — either is fine, this
   worktree is not shared).
2. Task 6: reconcile.ts draft branch + types.ts additions + `tests/unit/external-reconcile.test.ts`.
3. Task 7: migration 0160 (`list_active_external_module_users` draft-aware) — read
   `0158_external_module_active_users.sql` in full first, the exact deny-list join must be
   preserved.
4. Task 8: `external-module-tools.ts` resolver ownership filter, per the corrected shape above.
5. Task 9: `worker-module-gate.ts` extraction, per the corrected shape above (no forUserId).
6. Task 10: `ship-module.ts` + route, following `repository.ts`'s "no new class delegates" rule
   and the Task 3 rescan-route shape in `packages/settings/src/routes-modules.ts`.
7. Then `coordinated-wrap-up`: gate, PR referencing #1753, note in the PR that #1754 depends on
   this landing. No UI surface in Group B itself — if still true when you get there, say so
   explicitly in the PR ("no UI surface, live-path gate does not apply") rather than skipping
   silently.

## Rules that bit before, still apply

- `git commit` by explicit path only, never `-A`/`.`, never bare (shared-checkout skill, though
  this worktree isn't currently shared with another live session).
- Never edit an applied migration; 0159/0160 are new files only.
- Relay again on the next 70% context-meter warning or compaction summary — don't wait for a
  felt sense of fullness. Read the plan/spec BY SECTION only, never in full.
- Do not merge your own PR. Coordinator merges after independent QA.
