# 1754 build agent runner — relay 4

**Spec:** `docs/superpowers/specs/2026-08-19-moss-builds-modules-on-moss.md`.
**Plan — your scope is Group C only:** `docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`.
Read only the section for the task you're on (`grep -n "^### Task" <plan>` for exact line numbers).
**Coordinator:** label `Coordinator` in Herdr — confirm fresh via `herdr pane list`, never trust a
pane id written in any doc.

## Done — commits on this branch, all green (Tasks 11-15, see relay-3 doc for detail)

No new commits since relay-3. This relay is pure research/design work on Task 16 — nothing to
commit yet, so there is no code state to lose, but there IS design ground you should not redo.

## Task 16 — already resolved with the coordinator, ready to implement

**The plan's own pseudocode for Task 16 is wrong and the coordinator has approved a re-scope.**
I asked, coordinator (pane `Coordinator`, session confirmed) said yes, go ahead. Do not re-ask.

**What was wrong:** the plan's Step 3 snippet calls `installModule()` from
`scripts/module-install.ts:45` expecting it to accept `{ manifest, sourceDir, status, ownerUserId }`
and write an `app.external_modules` row. It doesn't — read the real file, it only runs the
module's database migrations (roles, tables, RLS) and never touches `app.external_modules`.

**Approved re-scope:**
1. `installModuleDraft` does NOT call `scripts/module-install.ts` at all. Database migrations for
   a newly-discovered module already run automatically at the next `module-reconcile.ts` pass
   (phase 6), same as any other module — no special-casing needed for drafts there.
2. The build's finished output currently sits in a separate build directory
   (`module-builds/<id>`, from Task 11's `resolveBuildSourceDir`) that the server's normal disk
   scan never reads (only `modulesDir` is scanned). `installModuleDraft` must move it into
   `modulesDir/<moduleId>` so reconcile's disk scan finds it.
   **Reuse, don't reinvent:** `stageModuleDir(extractedDir, modulesDir, moduleId)` in
   `packages/module-registry/src/distribution/stage.ts` already does exactly this atomic-rename
   move (with `.staging-`/`.prev-` crash safety) — it's what the existing admin-download pipeline
   uses. Also reuse `hashExternalPackage` and `hashCanonicalManifest` from
   `packages/module-registry/src/external/hash.ts` for the row's `manifest_hash`/`package_hash`
   columns, and the read-manifest-then-validate pattern from
   `packages/module-registry/src/distribution/pipeline.ts:61` (`downloadAndStageModule`) — hash the
   build's tree with `hashExternalPackage` BEFORE calling `stageModuleDir` (the source dir won't
   exist at that path afterward), same order that file uses.
3. The row-write itself needs a NEW function, a draft-writing sibling of the existing
   `setExternalModuleEnabled` in `packages/settings/src/repository-external-modules.ts:101`.
   Call it `setExternalModuleDraft(scopedDb, input, writeAudit)` — same upsert shape as
   `setExternalModuleEnabled` but `status: "draft"`, `owner_user_id: input.ownerUserId` (not
   null), `enabled_by`/`enabled_at` null. Wire it into `SettingsRepository` in `repository.ts`
   exactly like `setExternalModuleEnabled`/`setExternalModuleDisabled` are wired (see
   `repository.ts:311-335`), and export the new type from the package barrel the same way the
   existing ones are exported.
4. **No RLS/migration changes needed.** I checked: `app.external_modules` INSERT/UPDATE already
   requires `current_actor_is_admin()` (migration `0152_external_modules.sql`), and the plan's own
   Task 10 section says explicitly: "shipping is an admin action; owner and admin are the same
   person in stage 1 since only admins can build" — so the existing admin-only RLS gate is
   correct as-is for who may install a draft. Don't add a self-service insert policy.
5. Keep `installModuleDraft` in `packages/module-registry` (not `@moss/settings`) and give it an
   injected `deps` bag rather than importing `@moss/settings` directly — this package already
   imports `@moss/settings` elsewhere (`active-modules-resolver.ts` etc.) so a direct import isn't
   a dependency-cycle problem, but the audit-write closure (`writeAudit`) needs a live
   `SettingsRepository` instance + `scopedDb`/`actorUserId`/`requestId` that only the caller (the
   build-step wiring, likely Task 17) has — so pass a bound `writeDraftRow` function in, matching
   the plan's original `deps: {...}` injection style and this plan's established pattern
   (`packages/ai/src/module-build/run-build-step.ts` takes `launchLiveAgent` injected the same way).

**Proposed shape (not yet written, free to adjust in the small if TDD surfaces a better shape):**

```typescript
// packages/module-registry/src/external/install-draft.ts
export interface InstallModuleDraftDeps {
  readonly modulesDir: string;
  readonly validateExternalModuleManifest: typeof validateExternalModuleManifest;
  readonly writeDraftRow: (input: {
    id: string;
    manifestHash: string;
    packageHash: string;
    ownerUserId: string;
  }) => Promise<void>;
}

export async function installModuleDraft(
  deps: InstallModuleDraftDeps,
  buildSourceDir: string,
  moduleId: string,
  ownerUserId: string
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  // read jarvis.module.json from buildSourceDir (JSON.parse + readFileSync, same as
  // pipeline.ts:117-119 — no existing shared helper for this, it's inlined at both
  // call sites today)
  // validate via deps.validateExternalModuleManifest(raw, moduleId)
  // on failure: return { ok: false, errors }
  // on success: hash with hashExternalPackage(buildSourceDir) + hashCanonicalManifest(manifest),
  //   THEN stageModuleDir(buildSourceDir, deps.modulesDir, moduleId),
  //   THEN deps.writeDraftRow({ id: moduleId, manifestHash, packageHash, ownerUserId })
  //   return { ok: true }
}
```

**Test file (flat convention, confirmed against this plan's established pattern):**
`tests/unit/module-registry-install-draft.test.ts`. Unit-test convention in this repo does NOT
hit a real Postgres connection for repository functions — see
`tests/unit/settings-module-builds-repository.test.ts` for the fake-scopedDb-with-chained-mocks
pattern to copy for `setExternalModuleDraft`'s own test (create alongside
`repository-external-modules.ts`, or wherever its sibling `setExternalModuleEnabled` is tested —
check `packages/settings/src/*.test.ts` first). For `installModuleDraft` itself, fake
`writeDraftRow` as a plain async mock and use a real tmp directory (`node:fs/promises mkdtemp`)
for `buildSourceDir`/`modulesDir` so `stageModuleDir`'s real fs rename gets exercised — that's
consistent with `module-registry-resolve-build-dir.test.ts`'s use of real paths, and the plan's
own Step 1 test snippet builds a real fake module folder via `writeFakeGeneratedModule(tmpDir,
...)` (you'll need to write that tiny helper — it just needs to write a valid or invalid
`jarvis.module.json` into a fresh dir).

Then Steps 4-5 of the plan (test passes, commit) unchanged: two files, `git add` by explicit path,
commit message `feat(#1754): install a finished build as a draft through the unchanged module
validator`. Plus the two settings-side files (`repository-external-modules.ts` diff +
`repository.ts` diff + wherever its test lives) — either fold into the same commit or a
preceding one, whichever reads cleaner; both are part of Task 16's actual scope even though the
plan's file list only names the module-registry side.

## Then Tasks 17-19

Unchanged from relay-3 — see that doc's "Then Tasks 17-19" section if this doc is later archived,
or just read the plan's Task 17/18/19 sections fresh when you get there.

## Reminders (unchanged from relay-1/2/3)

- Work only in this worktree/branch; `git add` by explicit path, never `-A`.
- Never touch `docs/coordination/`, the project board, milestones, or merge — report to
  coordinator.
- Relay again at the next 70% meter warning or compaction summary. Read the plan by SECTION only,
  never front-to-back — this relay burned its budget on research, not on over-reading the plan, so
  that failure mode wasn't repeated, but don't let the next one bloat on a full-plan read either.
- Pre-push trio (`pnpm format:check && pnpm lint && pnpm typecheck` + rebase on `origin/main`)
  before any push, and `coordinated-wrap-up` at the end (PR + live-path proof).
- This PR (Group C) has no UI surface of its own (that's #1755, a separate PR) — raise with the
  coordinator at wrap-up whether "code-complete, unverified" is the honest status for this PR
  specifically.
