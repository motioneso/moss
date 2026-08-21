# Relay 3: #1755 Workshop page

Everything up to and including admin-gating is done and committed, green. Pick up at Task 24
(design-system audit) below.

Read only if you need it (don't re-read in full unless stuck):
- `docs/superpowers/handoffs/2026-08-20-1755-workshop-page-relay2.md` — prior relay, has the full
  file-by-file rationale for the module scaffold.
- Coordination doc (exit criteria/bans): `git show d04251c05:docs/coordination/handoff-1755-workshop-page.md`
  (lives on branch `coord-1258-postmerge`, not this branch — normal, not an error).
- Plan Group D: `git show origin/plan/1739-stage1-workshop:docs/superpowers/plans/2026-08-20-1739-stage1-workshop.md`,
  read only "# Group D" to "# Group E" if you need task wording.

## Done and committed (3 commits on this branch since main)

1. `feat(#1755): scaffold the Workshop first-party module and page` — the `@moss/workshop`
   package (manifest, admin-only nav entry, no backend routes), `workshop-page.tsx` +
   `workshop-groups.tsx` (Needs you / Building now / Live, `EmptyState` fallback), registered in
   `packages/module-registry/src/index.ts`'s `BUILT_IN_MODULES`, workspace deps + tsconfig paths
   added. Tests: `tests/unit/workshop-page.test.tsx`, `tests/unit/workshop-groups.test.tsx`.
2. `feat(#1755): render the Workshop's Needs you / Building now / Live groups` — folded into
   commit 1 above (the groups component was built alongside the page, not separately — the plan's
   Task 20/21 split didn't hold up as two clean commits once building; not worth re-splitting).
3. `feat(#1755): admin-gate the Workshop nav entry and page` — `app-shell.tsx` filters
   `props.modules` (dropping Workshop for non-admins) only at the `buildShellNavigation` call
   site; `resolvePageHeading`/`CommandPalette` call sites untouched, as scoped. Page itself also
   checks `/api/me` and shows an access-denied `EmptyState` for a non-admin who navigates to
   `/workshop` directly. Test added for both the admin and non-admin render paths.

All verified: `tsc --noEmit` clean in `packages/workshop`, `packages/module-registry`,
`apps/web`; `tests/unit/workshop-page.test.tsx`, `workshop-groups.test.tsx`,
`module-web-scanner.test.ts`, `module-web-browser-safety.test.ts`, `sports-registry.test.ts`,
`app-map-contract.test.ts`, `app-shell-chat-surface.test.tsx` all green.

## NOT yet done — pick up here, in order

1. **Task 24 — design-system audit.** Run for real:
   ```bash
   grep -rhoE "jds-[a-zA-Z0-9_-]+" packages/workshop/src apps/web/src/shell/app-shell.tsx | sort -u > /tmp/used.txt
   grep -rhoE "\.jds-[a-zA-Z0-9_-]+" apps/web/src/styles/ packages/ui/src/styles/ | sed 's/^\.//' | sort -u > /tmp/defined.txt
   comm -23 /tmp/used.txt /tmp/defined.txt
   ```
   Fix anything printed, commit: `fix(#1755): replace invented classes found by the design-system audit`.
   (I did a pre-check by eye against the confirmed-present list while writing `workshop-groups.tsx`
   and believe it's clean, but the real audit hasn't been run yet — don't skip it.)
2. **Tasks 22/23 are out of scope this pass** (poll build status, wire actions to real routes) —
   blocked on #1752/#1753 landing the backend. Just note this explicitly in the PR body under a
   "Deferred" heading.
3. **`coordinated-wrap-up` skill**: full gate on an isolated gate DB (never bare
   `pnpm verify:foundation` — use the `verify-gate` skill), live-path proof (install/exercise on
   the live dev instance, screenshot or DOM evidence posted as a `gh pr comment`, not just the
   component tests above), open the PR referencing #1755, rebased on origin/main. Fill in the
   PR's Release note section (Category: Added, plain-English description, no file paths/jargon —
   something like "Instance admins can now see a Workshop page listing modules Moss is building or
   has already built") and run `node scripts/append-release-note.mjs --pr <number>` on this branch,
   committing the `docs/WHATS_NEW.md` change.

## Traps already found, don't re-derive

- `@moss/workshop` needed `@moss/ui` as a direct dependency (for `EmptyState`) — already added to
  `packages/workshop/package.json`, don't re-derive the missing-package error.
- `apps/web`'s `iconMap` had no `wrench` icon — added (`lucide-react`'s `Wrench`), used by both
  the manifest's nav icon and `app-shell.tsx`'s `iconMap`.
- Admin gating is scoped to exactly one call site in `app-shell.tsx` (`buildShellNavigation`) —
  do not extend it to `resolvePageHeading` or `CommandPalette`, that was a deliberate scope
  decision from the original grounding, not an oversight.
- `node_modules` already installed (including the new `@moss/workshop` linked package) — do not
  re-run `pnpm install` unless you add a new dependency.

## Bookkeeping

- Same worktree/branch, continue here — this is a build-agent relay (not a coordinator relay).
- Coordinator label: `Coordinator` — resolve fresh by label + session id via `herdr pane list`.
- Relay trigger: context-meter 70% warning, fired after committing the admin-gating work. Nothing
  was left un-committed this time.
