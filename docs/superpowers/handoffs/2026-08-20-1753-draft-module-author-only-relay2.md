# Relay 2 — #1753 draft module (author-only), continue here

**Worktree/branch:** this same worktree, branch `1753-draft-module-author-only` (do NOT
`pnpm install` — `node_modules` already present).
**Coordinator:** Herdr agent name `coord1739relay10` (session id `7a4759d1-8ede-4252-b513-372e1d27694b`)
— confirm both still resolve to one pane via `herdr pane list` before messaging (names/labels
can change on the next relay).
**Previous relay doc (superseded, background only):**
`docs/superpowers/handoffs/2026-08-20-1753-draft-module-author-only-relay.md`
**Plan section to build (read ONLY the remaining tasks, from git object store, never checkout
the branch):**
```
git show plan/1739-stage1-workshop:docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md | sed -n '780,1052p'
```
That's Tasks 8-10 of "Group B — #1753" (Tasks 5-7 are done, see below).

## What's actually done (commits on this branch, newest first)

- `46e1eea68` — Task 7: `packages/settings/sql/0186_list_active_external_module_users_draft.sql`
  (renumbered from the plan's 0160 — see numbering note below). Widens
  `app.list_active_external_module_users` so a draft module fans out to its owner alone,
  ignoring the `module_enablement` deny list. Also widens `jarvis_migration_owner`'s RLS SELECT
  policy on `app.external_modules` to see draft rows (0158 only covered `status='enabled'`). Test
  added to `tests/integration/foundation.test.ts` (new `it` block right after the existing
  `list_active_external_module_users` test). Verified: `pnpm test:integration
  tests/integration/foundation.test.ts` — 22/22 passed.
- `eeb9e0fc1` — Task 6: `packages/module-registry/src/external/reconcile.ts` gained an explicit
  `status === "draft"` branch (always active, never drift-disabled) before the hash-compare
  branch. `packages/module-registry/src/external/types.ts`: `ExternalModuleStateInput.status`
  and `ExternalModuleStatus` now include `"draft"`; both `ExternalModuleStateInput` and
  `ReconciledExternalModule` gained `ownerUserId: string | null`. Also widened
  `packages/shared/src/platform-api-modules.ts`'s `ExternalModuleDto.status` to include
  `"draft"` (apps/api/src/server.ts:576 assigns reconcile output straight into this DTO type —
  compile breaks without it). Fixed two pre-existing test-fixture compile errors in
  `tests/unit/module-registry-rows.test.ts` (missing `ownerUserId` on the shared `adminState`
  fixture — a loose end from Task 5's WIP commit, not something this task introduced but had to
  fix to get a green typecheck). Verified: `pnpm typecheck` (full repo) green; `pnpm test:unit
  tests/unit/external-reconcile.test.ts tests/unit/module-registry-rows.test.ts` — 24/24 passed.
- `6cd0967fa` — Task 5: `packages/settings/sql/0185_external_modules_draft_owner.sql`
  (renumbered from the plan's 0159 — see numbering note below). Test added to
  `tests/integration/external-modules-repository.test.ts` (3 new `it` blocks at the end of the
  existing describe block, inserting rows directly via `scopedDb.db.insertInto(...)` under an
  admin actor context — there is no production "create draft" repository method and Task 5 was
  migration + type only). Verified: `pnpm test:integration
  tests/integration/external-modules-repository.test.ts` — 6/6 passed.
- `49117087d` (from before this relay) — Task 5's migration content, `packages/db/src/types.ts`,
  and `packages/settings/src/repository-external-modules.ts` changes (`ExternalModuleState` /
  `ExternalModuleAdminState` both carry `ownerUserId`, the three `insertInto` call sites pass
  `owner_user_id: null`).

## Migration numbering — IMPORTANT, already corrected once

The plan's suggested numbers 0159/0160 were **already claimed** by the news package
(`packages/news/sql/0159_news_personalization.sql`, `0160_news_discovery.sql`,
`0161_news_revalidation.sql`, merged to main before this worktree branched). Migration numbers
are a **single global sequence across every `packages/*/sql/` directory**, not per-package — the
first relay doc's claim that "0159/0160 are confirmed free" was wrong (it only checked
`packages/settings/sql/`). This relay renumbered:
- Task 5's migration: 0159 → **0185**
- Task 7's migration: 0160 → **0186**

Highest number now on disk is **0186** (this branch's own file). Before creating any new
migration file, re-run this check for the true current highest, since other lanes may have
landed migrations since:
```
for d in packages/*/sql infra/postgres/migrations; do ls "$d" 2>/dev/null; done | grep -oE "^[0-9]{4}_[a-zA-Z0-9_]+\.sql" | sort -n | tail -5
```
The coordinator (`coord1739relay10`) was already told about this renumbering — FYI only, not
blocking, no need to re-ask.

## Real grounding facts still relevant for Tasks 8-10

- **`apps/api/src/external-module-tools.ts`** — `createActiveExternalModulesResolverForApi`
  takes `{ appDataContext, settingsRepository, discoveries }` at construction and returns
  `async (accessContext) => ...`; the actor arrives per-call via `accessContext.actorUserId`, NOT
  at construction time (the plan's Interfaces section for Task 8 is wrong about this — do not add
  an actor parameter to the constructor). Today's filter is
  `modules.filter((module) => module.active && !disabled.has(module.id))`. Add the ownership
  check inside the per-call closure: a module is visible if `module.status !== "draft" ||
  module.ownerUserId === accessContext.actorUserId`. `ReconciledExternalModule` (imported from
  `@moss/module-registry`) already carries `ownerUserId` as of Task 6 — no further type work
  needed there.
- **Task 9 worker gate** — already resolved with the coordinator (see Task 9 note in the
  first relay doc, still valid, no need to re-ask): the fix is NOT a new `forUserId` parameter.
  `isModuleEnabled` lives inline in `apps/worker/src/worker.ts` around line 315 (search
  `new ExternalModuleJobReconciler({... isModuleEnabled: async (moduleId) => {...} })`), and
  today checks `state?.status === "enabled" && state.manifest_hash === module.manifestHash &&
  state.package_hash === module.packageHash`. Extract this to a named `createIsModuleEnabled`
  (single `moduleId` param, no new parameters) and widen the status check to
  `(state.status === "enabled" || state.status === "draft")`. Per-user scoping is already free
  once Task 7 landed (it has — `listActiveUserIds` calls
  `app.list_active_external_module_users`, which now fans a draft out to its owner alone). Verify
  this file's exact current shape before editing — line numbers drift.
- **`repository.ts` is at its 1000-line file-size gate cap** (comment right above
  `externalModuleAuditWriter` says "no new delegates"). For Task 10's `shipModule`, call
  `repository-external-modules.ts` functions directly from routes instead of adding a new
  `SettingsRepository` class method — same precedent #964 already used. Follow the Task 3
  rescan-route shape in `packages/settings/src/routes-modules.ts` for how a route without a new
  repository class method looks in this codebase.
- **Test file locations differ from the plan's illustrative paths** — this repo puts integration
  tests under a top-level `tests/integration/` and `tests/unit/` tree, not next to the source
  file. Confirmed patterns so far: `tests/integration/external-modules-repository.test.ts`,
  `tests/unit/external-reconcile.test.ts`, `tests/integration/foundation.test.ts`. For Task 8,
  check for an existing `apps/api/src/external-module-tools.test.ts` or equivalent under
  `tests/` before assuming the plan's path is right.

## Next concrete steps (in order)

1. Task 8: `apps/api/src/external-module-tools.ts` resolver ownership filter, per the corrected
   shape above (no constructor-time actor parameter). Find or create its test file — check both
   `apps/api/src/external-module-tools.test.ts` and a `tests/` equivalent before picking a
   location; follow whichever one already has coverage for
   `createActiveExternalModulesResolverForApi`.
2. Task 9: extract `createIsModuleEnabled` in `apps/worker/src/worker.ts`, widen its status check
   to accept `draft`, per the corrected shape above.
3. Task 10: `ship-module.ts` (or equivalent name — check the plan section for Task 10's exact
   file) + route, following `repository.ts`'s "no new class delegates" rule and the Task 3
   rescan-route shape.
4. Run `pnpm typecheck` (full repo) after each task — Task 6 showed that widening these shared
   types has ripple effects into `apps/api` that only surface on a full typecheck, not a
   package-scoped one.
5. Then `coordinated-wrap-up`: gate (use the `verify-gate` skill's isolated-DB recipe, never a
   bare `pnpm verify:foundation`), PR referencing #1753, note in the PR that #1754 depends on
   this landing. No UI surface in Group B itself — if still true when you get there, say so
   explicitly in the PR ("no UI surface, live-path gate does not apply") rather than skipping
   silently.

## Rules that bit before, still apply

- `git commit` by explicit path only, never `-A`/`.`, never bare (shared-checkout skill) — this
  worktree currently has no other live session in it (the pane that wrote the first relay doc
  has already exited).
- Never edit an applied migration; 0185/0186 (and whatever Task 10 needs) are new files only —
  re-check the highest number on disk first, per the numbering section above.
- Relay again on the next 70% context-meter warning or compaction summary — don't wait for a felt
  sense of fullness. Read the plan/spec BY SECTION only, never in full.
- Do not merge your own PR. Coordinator merges after independent QA.
- All chat/status/handoff text stays plain English, no jargon, no invented shorthand — user
  instruction, applies to every agent, not just the one talking to Ben.
