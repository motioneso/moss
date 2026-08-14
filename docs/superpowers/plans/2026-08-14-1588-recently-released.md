# Plan — #1588 Recently Released

**Spec:** `docs/superpowers/specs/2026-08-14-1588-recently-released.md`

**Status:** Approved by Ben — 2026-08-14

**Grounded on:** `origin/main` = `eb8e60715d`

**Risk tier:** Routine UI/content. No API, database, job, authorization, or dependency change.

## Outcome

Every signed-in user can open **Settings → Moss → Recently Released** and read the release notes
bundled with their installed Moss build. The page is read-only and newest-first, with version/date
headings and Added, Fixed, and Changed sections where applicable.

## Existing seams to reuse

- `docs/WHATS_NEW.md` is the existing curated, user-facing changelog. It stays canonical.
- `apps/web/src/chat/markdown-message.tsx` is the installed safe Markdown renderer. It already
  escapes raw HTML, allowlists link protocols, and is reused by host diagnostics.
- `apps/web/src/settings/settings-page.tsx` owns personal Settings groups and lazy panes. The
  existing **Moss** group is the requested navigation home.
- `packages/shared/src/app-map-core.ts` is the matching app-map declaration source for core Settings
  destinations.
- Vite already supports raw asset imports and `apps/web/tsconfig.json` includes `vite/client`; no
  loader, copy script, endpoint, or type shim is required.
- `tests/unit/settings-page-priorities.test.tsx` already exercises the personal Settings navigation
  as a non-admin user.
- `tests/uat/seed/admin.ts` provides a loginable non-admin second owner for a real UI proof.

## Locked implementation surface

Expected production/content files:

1. `docs/WHATS_NEW.md`
2. `apps/web/src/settings/settings-released-pane.tsx` (new)
3. `apps/web/src/settings/settings-page.tsx`
4. `packages/shared/src/app-map-core.ts`

Expected tests:

5. `tests/unit/settings-released-pane.test.tsx` (new)
6. `tests/unit/settings-page-priorities.test.tsx`
7. `tests/uat/specs/1588-recently-released.uat.spec.ts` (new)

No CSS file is planned. Reuse `PaneHead`, the Settings pane shell, and `MarkdownMessage`. If the
existing authored classes cannot produce a readable document without new styling, stop and request
a design review rather than inventing a parallel release-notes design system.

## Task 1 — Bundle and render the canonical changelog

### RED

Create `tests/unit/settings-released-pane.test.tsx` first. Import the not-yet-existing
`ReleasedPane`, render it to a string, and assert that the real bundled changelog displays:

- the **Recently Released** pane title;
- at least one semantic version and ISO release date;
- the headings **Added**, **Fixed**, and **Changed**; and
- representative user-facing entry text from `docs/WHATS_NEW.md`.

Also render the existing `MarkdownMessage` with synthetic raw HTML and a `javascript:` link and
assert that no executable `<script>` or unsafe `href` is emitted. This pins the security property
the new pane relies on without adding a second renderer.

Run:

```bash
pnpm vitest run tests/unit/settings-released-pane.test.tsx
```

Expected RED: the `ReleasedPane` module does not exist.

### GREEN

1. Normalize `docs/WHATS_NEW.md` into newest-first release sections:

   ```markdown
   ## vX.Y.Z — YYYY-MM-DD

   ### Added
   ...

   ### Fixed
   ...

   ### Changed
   ...
   ```

   Omit empty categories. Preserve useful existing user-facing history and PR links; do not invent
   releases from commit messages. Use shipped tag/version history for version labels and keep the
   document bounded to content present at the build commit.

2. Add `settings-released-pane.tsx`:

   - import `../../../../docs/WHATS_NEW.md?raw` directly;
   - render `PaneHead` with title **Recently Released** and one short description;
   - render the imported string through `MarkdownMessage`;
   - accept ordinary `PaneProps` only for compatibility with the Settings pane interface; and
   - add no fetching, state, parsing, filtering, version comparison, or custom link handling.

3. Rerun the focused test and record RED→GREEN.

### Commit

```text
feat(settings): render bundled release history (#1588)

Users can read the release notes included with their installed Moss version.
```

Commit only Task 1's three files.

## Task 2 — Make the page navigable from Settings

### RED

Extend `tests/unit/settings-page-priorities.test.tsx` with a non-admin case that renders
`/settings?section=released` and asserts:

- the **Moss** navigation group includes **Recently Released**;
- **Recently Released** is the active destination; and
- release-note content renders for a non-admin user.

Add an assertion over `CORE_APP_SETTINGS` that the exact declaration is:

```ts
{
  id: "released",
  label: "Recently Released",
  description: "See what was added, fixed, and changed in recent Moss releases.",
  path: "/settings?section=released",
  scope: "user"
}
```

Run:

```bash
pnpm vitest run tests/unit/settings-page-priorities.test.tsx
```

Expected RED: `released` is absent from both Settings navigation and the app map.

### GREEN

1. In `packages/shared/src/app-map-core.ts`, add the exact user-scoped declaration above.
2. In `settings-page.tsx`:
   - add `released` to `PersonalSectionId`;
   - lazy-load `ReleasedPane`;
   - add **Recently Released** to the existing **Moss** group with an existing Lucide icon;
   - source its description through `coreSettingDescription("released")`; and
   - change no routing/state machinery—the existing query-section handling already does the job.
3. Rerun the focused navigation test.

### Commit

```text
feat(settings): link Recently Released for every user (#1588)

Users can navigate to the bundled release history from the Moss Settings group.
```

Commit only Task 2's three files.

## Task 3 — Prove the real non-admin path

### RED

Add `tests/uat/specs/1588-recently-released.uat.spec.ts` with `uatLevel: "multi-user"`.

The test signs in with `UAT_SECOND_OWNER_EMAIL` / `UAT_SECOND_OWNER_PASSWORD`, handles first-run
onboarding using the established conditional pattern from `app-map-grounding.uat.spec.ts`, and then
uses only visible UI navigation:

```text
user menu → Settings & permissions → Moss → Recently Released
```

Assert:

- the URL query is `section=released`;
- the pane title is visible;
- a version/date heading is visible;
- Added, Fixed, and Changed headings are visible; and
- admin-only Settings destinations are not exposed in the personal navigation.

The test must not capture screenshots or query GitHub.

Expected RED before Tasks 1–2: no **Recently Released** button exists.

### GREEN

Run the focused UAT through the repository's isolated UAT provisioner after obtaining the solo
DB/live window. Record the exact command, exit code, assertions, and zero-resource teardown on the
PR.

### Commit

```text
test(uat): prove Recently Released navigation (#1588)

No additional user-visible change; this verifies the release-history page through the real UI.
```

Commit only the UAT file.

## Final verification

Run focused checks first:

```bash
pnpm vitest run \
  tests/unit/settings-released-pane.test.tsx \
  tests/unit/settings-page-priorities.test.tsx
pnpm format:check
pnpm lint
pnpm check:file-size
pnpm typecheck
```

Then, in an approved solo DB window, run exactly one isolated full gate with
`scripts/run-gate.sh`, followed by the focused real-UI UAT at the same exact head. CI must be green,
including the web/image build that proves Vite bundled the Markdown asset.

Required PR evidence:

- exact head and base;
- focused RED→GREEN commands;
- static-check and full-gate exit codes;
- non-admin UI navigation assertions;
- confirmation that no screenshots were produced; and
- zero scoped containers, networks, volumes, databases, and processes after teardown.

## Kill gates

Stop and return for a spec decision if any of these becomes necessary:

- a runtime API, GitHub fetch, database table, background job, editor, notification, or dependency;
- a second canonical release-note source;
- a version-filtering service instead of build-bundled history;
- custom Markdown/HTML rendering or raw HTML execution;
- a new primary navigation destination rather than the approved Settings link; or
- CSS outside existing authored Settings/Markdown primitives.

## Build recommendation

Use one inline build agent after the current #1275 lane finishes. The work is three small,
sequential TDD tasks on shared Settings files; a parallel workflow would add coordination without
shortening the critical path. Do not move #1588 into In Progress or start its worktree until the
plan is approved and the current lane is closed.
