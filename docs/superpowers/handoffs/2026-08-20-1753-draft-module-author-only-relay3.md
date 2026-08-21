# Relay 3 — #1753 draft module (author-only), continue here

**Worktree/branch:** this same worktree, branch `1753-draft-module-author-only` (do NOT
`pnpm install` — `node_modules` already present).
**Coordinator:** Herdr agent name `coord1739relay10` — confirm it still resolves via
`herdr pane list` before messaging (names/labels can change on the next relay).
**Heads-up:** `herdr pane list` showed TWO live panes on this same worktree/branch earlier this
session (this one, and one labeled "relay2" — session `9e4ed92d...`). Before touching git, run
`herdr pane list` again and check whether that other pane is still alive and working here. If it
is, coordinate before committing (shared-checkout skill) — don't assume you're alone in this
worktree just because the previous relay doc said so.
**Previous relay doc (superseded, background only):**
`docs/superpowers/handoffs/2026-08-20-1753-draft-module-author-only-relay2.md`
**Plan section (Tasks 8-10, already read in full this session — re-fetch only if needed):**
```
git show plan/1739-stage1-workshop:docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md | sed -n '780,1052p'
```

## Done and committed this session

- Task 8, commit `8f994f2d1`: `apps/api/src/external-module-tools.ts`'s
  `createActiveExternalModulesResolverForApi` now filters out another user's draft (adds a
  `visibleToActor` check: `module.status !== "draft" || module.ownerUserId === accessContext.actorUserId`).
  New test `tests/unit/external-module-tools.test.ts` (2 cases). `pnpm test:unit
  tests/unit/external-module-tools.test.ts` passed, full `pnpm typecheck` passed.
- Task 9, commit `01a410390`: extracted the worker's inline module-active check into
  `apps/worker/src/worker-module-gate.ts`'s `createIsModuleEnabled({ db, getDiscoveryById })` —
  single `moduleId` param, no `forUserId` (per-user scoping is already handled by Task 7's
  fan-out). A draft is treated as enabled with NO hash check (matching reconcile.ts's own
  drift-exemption for drafts); an enabled module still needs an exact manifest+package hash
  match, unchanged from before. Wired into `apps/worker/src/worker.ts` in place of the old
  inline callback. New test `tests/unit/worker-module-gate.test.ts` (4 cases), full
  `pnpm typecheck` passed.

## Task 10 — in progress, NOT committed, changes on disk right now

Files currently modified (uncommitted — check `git status` first thing, another session may
have touched these):
- `packages/settings/src/repository-external-modules.ts` — two changes:
  1. Fixed a real bug found along the way: `setExternalModuleEnabled`'s `onConflict` update
     branch never cleared `owner_user_id`, so re-enabling an id that already had a draft row
     would leave `owner_user_id` set on an `enabled` row — which the DB CHECK constraint
     rejects (see the "rejects an enabled row that carries an owner" test already in
     `tests/integration/external-modules-repository.test.ts`, added by Task 5). Added
     `owner_user_id: null` to that `doUpdateSet`.
  2. Added `shipExternalModule(scopedDb, input, writeAudit): Promise<boolean>` — an
     update-only function scoped to `WHERE id = :id AND status = 'draft' AND owner_user_id =
     :actorUserId`. Returns `false` (not a throw) if 0 rows matched — same "can't tell
     not-found from not-yours" non-leak shape as the rest of this file. Sets `status =
     'enabled'`, clears `owner_user_id`, re-captures `manifest_hash`/`package_hash` from the
     caller-supplied current discovery, sets `enabled_by`/`enabled_at`, writes a
     `module.external_ship` audit row. Full doc-comment already written in the file — read it
     there rather than here.
  Deliberately did NOT add a `packages/settings/src/ship-module.ts` file (the plan's
  suggested location) — followed the actual codebase precedent instead (repository.ts is at
  its 1000-line file-size gate cap, comment says "no new delegates"; #964 already put
  standalone functions straight in `repository-external-modules.ts` and had routes call them
  directly, e.g. `markExternalModuleRemoved`). This function follows that exact shape.
- `packages/shared/src/platform-api-modules.ts` — added `shipExternalModuleRouteSchema`
  (params: `adminModuleParamsSchema`, response 200 `{ shipped: boolean, restartRequired: boolean
  }`, standard 401/403/404/409). Auto-reexported via `platform-api.ts`'s `export *`.
- `packages/settings/src/routes-modules.ts` — added `POST /api/admin/modules/:id/ship`, same
  shape as the rescan route right above it: `assertAdminUser` first, 409 if external modules
  feature is off, 404 if the id isn't a current on-disk discovery, then calls
  `shipExternalModule` and 404s if it returns false. Always returns `{ shipped: true,
  restartRequired: true }` on success (restart is a human action per spec, not automated).
  Imports `shipExternalModule` from `./repository-external-modules.js` directly (matches the
  "no new repository.ts delegates" note above) and `shipExternalModuleRouteSchema` from
  `@moss/shared`.
- `tests/integration/external-modules-routes.test.ts` — ONLY added a second on-disk module
  fixture (`acme-widgets-draft`, written in `beforeAll` alongside the existing `acme-widgets`
  fixture, no DB row yet — stays `discovered` until a test inserts a draft row for it). **The
  actual ship-route test cases are NOT written yet.**

## Next concrete steps (in order)

1. In `tests/integration/external-modules-routes.test.ts`, add test cases inside the existing
   `describe("external-module admin routes (#917)", ...)` block (after the "denies a non-admin
   GET" test, before the `signUp`/`cookieHeader` helper functions at the bottom). Use the
   `Client` + `connectionStrings.bootstrap` pattern already used twice in this file (see the
   "hides a globally enabled..." test) to insert a draft row directly via SQL — something like:
   ```sql
   INSERT INTO app.external_modules (id, status, manifest_hash, package_hash, owner_user_id, created_at, updated_at)
   VALUES ('acme-widgets-draft', 'draft', 'sha256:stale-m', 'sha256:stale-p', $1, now(), now())
   ```
   Needed cases (mirror the plan's Task 10 Step 6, adapted to this file's real fixtures):
   - Admin ships their own draft (`owner_user_id = adminUserId`) → 200, body
     `{ shipped: true, restartRequired: true }`; then a follow-up read (either
     `GET /api/admin/external-modules` or a direct DB check via the bootstrap client) confirms
     `status = 'enabled'`, `owner_user_id IS NULL`, and `package_hash` changed from the seeded
     `sha256:stale-p` (proves the current on-disk hash was recaptured, not the stale one).
   - Ship rejected for a draft owned by someone else: insert a fresh draft row owned by
     `memberUserId` (after approving member, see the existing approve pattern in this file, or
     just insert directly — RLS is bypassed via the bootstrap client either way), have the
     ADMIN try to ship it → 404 (not 403 — the admin passes `assertAdminUser`, it's the
     ownership WHERE clause inside `shipExternalModule` that returns false).
   - Non-admin (`memberCookie`) hits the ship route at all → 403, same as the existing
     "denies a non-admin GET with 403" test's shape.
   - Unknown id → 404 (mirrors the existing "returns 404 for POST to an unknown external
     module id" test for the enable route).
   Use unique module ids per test (e.g. `acme-widgets-draft`, `acme-widgets-draft-2`, ...) so
   tests don't collide on the same row — this file's `beforeAll` runs once for the whole
   describe block, there's no per-test reset.
2. Run: `pnpm test:integration tests/integration/external-modules-routes.test.ts` — expect all
   passing, including the pre-existing tests (don't break those).
3. Also re-run `tests/integration/external-modules-repository.test.ts` since the
   `setExternalModuleEnabled` onConflict fix (item 1 above) touches shared code:
   `pnpm test:integration tests/integration/external-modules-repository.test.ts` — expect the
   existing 6+ cases still green (the fix should be additive/corrective, not behavior-changing
   for any currently-passing case, since no existing test enables an id that already has an
   owner set).
4. Run full `pnpm typecheck` (background it — it's taken over 120s each time this session;
   use `run_in_background` + wait, don't foreground-block past 120s).
5. If green: `git status` (check no other session touched these files first), then commit by
   explicit path only (never `-A`/`.`, shared-checkout skill applies):
   ```
   git add packages/settings/src/repository-external-modules.ts packages/settings/src/routes-modules.ts packages/shared/src/platform-api-modules.ts tests/integration/external-modules-routes.test.ts
   git commit -m "feat(#1753): add shipping — the human action that turns a draft into a real module"
   ```
6. Then `coordinated-wrap-up`: gate via the `verify-gate` skill's isolated-DB recipe (never a
   bare `pnpm verify:foundation`), open a PR referencing #1753, note in the PR that #1754
   depends on this landing, and note "no UI surface, live-path gate does not apply" if that's
   still true when you get there (Group B itself has no front end — Workshop UI is Group D).
   Fill in the PR template's Release note section per this repo's process gate (probably
   `Category: N/A` since this is groundwork with no user-visible surface yet — confirm by
   checking whether #1754/Group D is what actually exposes shipping in the UI).

## Migration numbering — for reference, no new migration needed in Task 10

Task 10 adds no new SQL file (it's an application-code + route change against the existing
`app.external_modules` table from Tasks 5-7). If that assumption turns out wrong, re-check the
highest migration number on disk first:
```
for d in packages/*/sql infra/postgres/migrations; do ls "$d" 2>/dev/null; done | grep -oE "^[0-9]{4}_[a-zA-Z0-9_]+\.sql" | sort -n | tail -5
```
Highest was 0186 as of this relay (this branch's own file, Task 7).

## Rules that bit before, still apply

- `git commit` by explicit path only, never `-A`/`.`, never bare (shared-checkout skill) —
  check for a live co-session in this worktree first (see the heads-up at the top).
- Never edit an applied migration.
- Relay again on the next 70% context-meter warning or compaction summary. Read the plan/spec
  BY SECTION only, never in full (already true this session — only lines 780-1052 were read).
- Do not merge your own PR. Coordinator merges after independent QA.
- All chat/status/handoff text stays plain English, no jargon, no invented shorthand — user
  instruction, applies to every agent, not just the one talking to Ben.
