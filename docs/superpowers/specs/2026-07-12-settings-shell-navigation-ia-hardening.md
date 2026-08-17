# Settings shell, navigation, and IA hardening (#986)

**Status:** Draft — awaiting Fable approval under Ben's delegated authority
**Date:** 2026-07-12
**Tier:** routine (frontend IA and presentation; permission-regression coverage required)
**Grounded on:** `origin/main` `3ca138eb`
**Builds on:** #487, #733, #732, #799, #918, `2026-06-14-settings-design-page.md`,
`2026-06-25-module-settings-connector.md`
**Must land before:** #1000 finalizes Playwright selectors for the Instance modules install UAT

## Problem

The settings shell has working panes but makes them hard to find and hard to leave:

- Personal has eleven flat destinations, including the overlapping **Profile & account** and
  **General** panes.
- Admin / Setup splits one admin workflow between **People & access** and **Identity &
  registration**.
- The sticky desktop rail can be taller than its scroll viewport, leaving destinations clipped.
- The Modules pane filters through a hard-coded toggleable-module allowlist. Required modules with
  real settings, including Briefings, Chat, and Notifications, therefore disappear.
- Module detail is local React state. The `module` query parameter is consumed and deleted, the
  browser history cannot represent list/detail state, and selecting Modules again does not reliably
  return to the list.
- Contributed module settings receive an `onBack` callback, but the shared router does not render a
  back control. Sports and News currently ignore the callback, so every module author has to
  rediscover the same shell requirement.

This issue fixes those shared shell and information-architecture causes. It does not redesign the
settings inside Assistant, Priorities, Memory, Sports, News, Skills, Connected accounts, host
operations, or module installation.

## Locked decisions

1. **Apply the approved two merges.** Personal **Profile & account + General** becomes **Account &
   preferences**. Admin **People & access + Identity & registration** becomes one **People & access**
   destination.
2. **Preserve stable section IDs.** The merged personal destination keeps `profile`; the merged admin
   destination keeps `people`. Remove `general` and `identity` from the registries. Existing stored
   values for removed IDs already fall back through `coerceSettingsSectionId`, so no storage
   migration or alias layer is needed.
3. **Do not merge permission-distinct workflows.** Account & preferences remains current-user only.
   People & access remains inside the existing `isInstanceAdmin` gate and uses the existing admin
   endpoints. A non-admin cannot render or deep-link into registration or member administration.
   No API, RLS, role, or authorization change belongs in this issue.
4. **Use one grouped registry per mode.** Render the approved groups directly from grouped section
   data; do not maintain a second label/order map. Lookup and stored-section coercion use the same
   flattened registry.
5. **URL state is the navigation truth.** Keep `?section=<id>` in the URL instead of consuming it.
   Section selection pushes a history entry; browser Back/Forward restores the section and mode.
   Local storage remains only the fallback when the URL has no valid section.
6. **Module detail is URL-addressable.** The list is `?section=modules`; detail is
   `?section=modules&module=<id>`. Opening a detail pushes history. Browser Back returns to the list.
   The visible **Back to modules** action removes `module` with `replace`, so browser Back does not
   immediately reopen the detail. A direct detail URL remains shareable; its visible back action
   lands on the Modules list.
7. **The settings shell owns contributed-detail recovery.** `ModuleSettingsRouter` renders one
   authored **Back to modules** control for every contributed surface and fallback. Do not require
   Sports, News, Wellness, or future modules to implement shell navigation individually. The three
   legacy inline subviews may retain their current `ModuleSub` back control until they migrate to the
   contributed router.
8. **Show configurable installed modules, not every package and not only toggleable extras.** Keep
   every current user-toggleable module row. Also show a required/installed module when it has an
   implemented settings destination: a legacy inline settings view, a contributed settings entry,
   or an existing settings-category destination. Required modules render no enable switch. An
   instance-disabled optional module remains visibly unavailable under the current control model.
9. **Fix the rail at the scroll boundary.** At desktop width, the rail stays sticky but gains its own
   bounded vertical overflow so every destination is reachable at supported viewport heights. At
   narrow width, all groups and destinations remain reachable without horizontal page overflow or a
   pointer-only interaction. Use the existing responsive shell; do not add a drawer dependency.
10. **Repair shared layout constraints, not downstream pane designs.** Shared pane descriptions,
    field rows, controls, and help text use the available detail width and align consistently. This
    issue may update the merged pane headings and remove Identity's negative operator-config note.
    Pane-specific model-routing or feature copy stays with its owning #983 sub-issue.
11. **Preserve honest promises.** Do not remove Export or Backup / restore promises in this slice.
    #1002 owns the full Coming-soon inventory and tracker reconciliation. Do not add a new promise or
    capability placeholder.
12. **Preserve the authored design system.** Reuse `PaneHead`, `Group`, `Row`, `Field`, `Select`,
    existing `jds-*` controls, serif headings, mono group labels, sans body copy, and token colors.
    No new component library, raw color, or parallel settings skin.

## Final information architecture

### Personal

| Group            | Destinations                                           |
| ---------------- | ------------------------------------------------------ |
| **Your account** | Account & preferences; Appearance                      |
| **Jarvis**       | Assistant & AI; Priorities; Memory & context; Activity |
| **Connections**  | Connected accounts; Data sources                       |
| **Extensions**   | Modules; Skills                                        |

### Admin / Setup

| Group               | Destinations                                                 |
| ------------------- | ------------------------------------------------------------ |
| **Access**          | People & access                                              |
| **AI & extensions** | Assistant & AI; Instance modules                             |
| **Operations**      | Connector oversight; Audit & operations; Advanced host setup |

Connected accounts stays separate from Data sources; Modules stays separate from Skills; Audit &
operations stays separate from Advanced host setup. Their permissions, state, and recovery models
are materially different.

## Merged pane contents

### Account & preferences (`profile`)

Keep the current-user controls already shipped in Profile and General, in this order:

1. Identity: avatar, display name, and how Jarvis addresses the user.
2. Account: one authoritative email presentation and current role/status.
3. Locale: timezone, language/region, and date/time format.
4. Quiet hours.
5. Sessions, personal export, and account deletion.

This merge moves presentation only. It does not add email change, security/2FA, export, or deletion
capabilities beyond what current `main` already exposes.

### People & access (`people`)

Keep the admin controls already shipped in People and Identity, in this order:

1. Registration: allow registrations and require approval.
2. Pending approval.
3. Members: roles, status, session revocation, and removal actions.

Remove the note that says auth-provider configuration is not on this screen. Operator auth-provider
setup is not an actionable workflow here, and #986 must not invent one.

## Navigation state contract

| Event                                   | URL/result                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Open `/settings` with no valid query    | Restore the last permitted mode/section from local storage; otherwise Account & preferences    |
| Select a personal/admin destination     | Push `?section=<id>` and render the matching mode                                              |
| Non-admin opens an admin section URL    | Ignore the admin destination and render a permitted personal fallback; admin pane never mounts |
| Open an implemented module setting      | Push `?section=modules&module=<encoded-id>`                                                    |
| Browser Back from module detail         | Restore the Modules list                                                                       |
| Select **Back to modules**              | Replace the detail URL with `?section=modules`                                                 |
| Select Modules while its detail is open | Clear `module` and show the list                                                               |
| Unknown/removed section or module       | Fall back to the permitted list state without a blank pane or loop                             |

Mode and last valid category may remain in versioned local storage for the no-query fallback. They
must not override a valid URL during initial render or browser history traversal.

## Build slices

### Slice 1 — grouped shell and durable navigation (`routine`)

- Replace the flat personal/admin registries with the locked grouped IA.
- Keep `profile` and `people`; remove `general` and `identity`.
- Make the section query parameter durable and history-aware.
- Update focused navigation/storage tests, including invalid and non-admin deep links.

### Slice 2 — merged destinations (`routine`)

- Compose the current Profile + General content under Account & preferences.
- Compose current People + Identity content under People & access.
- Remove duplicate pane headings and the negative auth-provider note.
- Preserve all existing query keys, mutations, confirmation policy, and admin guards.
- Keep touched source files below the repository file-size gate; move a cohesive pane to a focused
  file only if the existing 1,000-line boundary requires it.

### Slice 3 — module reachability and list/detail recovery (`routine`)

- Replace the hard-coded toggleable-only visibility rule with the locked configurable-module rule.
- Show Briefings, Chat, and Notifications as required/configurable rows with no toggle.
- Use the URL contract for legacy and contributed module details.
- Add the shared contributed-surface **Back to modules** control once in `ModuleSettingsRouter`.
- Clicking the Modules category while detail is open returns to the list.

### Slice 4 — responsive layout and acceptance (`routine`)

- Bound desktop rail scrolling and keep active/focus states visible.
- Preserve grouping and full reachability at narrow width.
- Let shared field/help layouts use the detail width without changing pane-specific designs.
- Add focused Playwright coverage at desktop, short desktop, and narrow viewport.

Slices 1 and 2 may share shell/pane files and should be one builder lane. Slice 3 may run in parallel
only after exact path locks exclude `settings-page.tsx` and `settings-personal-data-panes.tsx`; the
lowest-collision plan is one #986 builder through Slices 1–4.

## Exact path and collision map

### #986-owned implementation paths

| Path                                                              | #986 ownership                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `~/Jarv1s/apps/web/src/settings/settings-page.tsx`                | Grouped registries, merged destination registration, URL/mode/category shell state |
| `~/Jarv1s/apps/web/src/settings/settings-navigation.ts`           | Pure section/query coercion helpers if needed; no second router                    |
| `~/Jarv1s/apps/web/src/settings/settings-personal-panes.tsx`      | Account & preferences composition/profile content                                  |
| `~/Jarv1s/apps/web/src/settings/settings-personal-data-panes.tsx` | General-content move/composition and Modules list/detail URL state                 |
| `~/Jarv1s/apps/web/src/settings/settings-admin-panes.tsx`         | People + registration merge only; do not edit `InstanceModulesPane` behavior       |
| `~/Jarv1s/apps/web/src/settings/settings-module-view-model.ts`    | Configurable-module visibility and unchanged control semantics                     |
| `~/Jarv1s/apps/web/src/settings/settings-module-subviews.tsx`     | Legacy module back/category link copy and URL-driven detail only                   |
| `~/Jarv1s/packages/settings-ui/src/router.tsx`                    | One shell-owned back control for contributed settings surfaces/fallbacks           |
| `~/Jarv1s/apps/web/src/styles/settings.css`                       | Group labels, bounded sticky rail, responsive navigation, shared field/help width  |
| `~/Jarv1s/tests/unit/web-settings-navigation.test.ts`             | Section/query/fallback model                                                       |
| `~/Jarv1s/tests/unit/web-settings-module-view-model.test.ts`      | Required configurable rows and toggle preservation                                 |
| `~/Jarv1s/tests/unit/settings-page-priorities.test.tsx`           | Grouped shell/non-admin render regression, or rename to a focused shell test       |
| `~/Jarv1s/tests/e2e/settings-shell.spec.ts`                       | New #986 desktop/narrow acceptance                                                 |

Reuse `tests/e2e/mock-api.ts` and `tests/e2e/mock-modules.ts` fixtures without changing their global
contracts where possible; a #986-specific route override belongs in `settings-shell.spec.ts`.

### Hard exclusions and coordination locks

- **#965 / primary Coordinator owns behavior:**
  `~/Jarv1s/external-modules/job-search/src/web/screens/monitors.tsx`,
  `~/Jarv1s/apps/api/src/external-module-jobs.ts`, and
  `~/Jarv1s/packages/jobs/src/module-jobs.ts`. #986 does not touch RunNowButton, job sending, queue
  dedupe, module enable/install/run behavior, or their tests.
- **Instance modules behavior:** do not edit the `InstanceModulesPane` implementation, its registry
  download/install controls, external-module mutations, or module lifecycle copy. In
  `settings-admin-panes.tsx`, #986's lock ends at the People/Identity merge hunks.
- **#1000:** do not prescribe or edit its seed tooling, Compose harness, install UAT, or selector
  implementation. #1000 adapts to the post-#986 accessible names after this issue lands.
- **Later #983 panes:** #991, #993, #994, and #995 own pane-specific Assistant/Priorities,
  host/account/operator, Skills, and Connected-account behavior/copy. #986 changes only their shell
  label/group/layout.
- Do not edit `apps/api`, `apps/worker`, `packages/module-registry`, database code, migrations,
  Compose, or production deployment files.

The UX Coordinator must re-sync with the primary Coordinator immediately before implementation if
either side has opened `settings-admin-panes.tsx`, `settings-page.tsx`, shared Playwright fixtures,
or settings selectors. Use isolated worktrees, explicit-path staging, and never `git add -A`.

## Automated acceptance

### Focused unit/component checks

- Group registries contain every locked destination exactly once and in the approved order.
- Removed stored IDs (`general`, `identity`) safely coerce to the first permitted merged
  destination; valid IDs remain stable.
- A non-admin cannot select or render an admin section from state or URL.
- Required configurable modules are visible with `kind: "required"` and no toggle; optional modules
  retain enabled, disabled, and admin-locked semantics.
- Unknown module IDs return to the list/fallback instead of blanking the pane.
- `ModuleSettingsRouter` renders the shared back action for a successful surface, loading/error
  boundary, missing bundle, and no-UI fallback.

### Playwright E2E

Add a focused spec that uses role/name assertions, not CSS structure or #1000's future install
selectors.

1. **Desktop — `1440x900`:**
   - Personal nav shows the four group labels and ten final destinations.
   - `Profile & account` and `General` are absent; Account & preferences contains identity, locale,
     quiet-hours, sessions/export/delete sections already available on current `main`.
   - Admin / Setup shows the three group labels and six final destinations.
   - `Identity & registration` is absent; People & access contains registration, pending/member
     content, and existing admin actions.
   - Section clicks update the URL; browser Back/Forward restores section and mode.
2. **Short desktop — `1280x640`:**
   - The settings rail is keyboard reachable from first to last destination.
   - Scrolling the rail can reveal and focus the final item while the active detail pane remains
     usable; no destination is clipped behind the viewport.
3. **Narrow — `390x844`:**
   - Every group and destination remains reachable by keyboard and touch.
   - Selecting Account & preferences, Modules, and People & access (admin fixture) renders the
     expected pane without horizontal page overflow.
   - The active destination and focus indicator are visible.
4. **Permission regression:**
   - A non-admin sees no Admin / Setup control or admin group/destination.
   - Direct navigation to an admin section does not mount or request the admin pane and lands on a
     permitted personal section.
5. **Modules list/detail:**
   - Fixture data includes required Briefings, Chat, and Notifications plus a contributed module.
   - All four are visible; required rows have no enable checkbox and retain a Configure action.
   - Open a legacy detail and a contributed detail; each has **Back to modules**.
   - Browser Back from detail, the visible back action, and selecting Modules while detail is open
     each return to the list with the URL contract above.

## Verification gate

Before PR handoff:

```text
pnpm prettier --check <all-touched-files>
pnpm lint
pnpm check:file-size
pnpm check:design-tokens
pnpm typecheck
pnpm test:unit -- <focused settings tests>
pnpm playwright test tests/e2e/settings-shell.spec.ts
pnpm verify:foundation
```

Run the Playwright spec in Chromium at the three declared viewports. Final #986 acceptance is against
the built app. #988 owns the later full narrated desktop/narrow dogfood pass.

## Non-goals

- Module download, installation, enable/disable, run-now, job dedupe, restart, or lifecycle behavior.
- The #1000 UAT harness, seed levels, Compose environment, or final selector choices.
- New settings APIs, database changes, migrations, authorization, RLS, or admin powers.
- Email-change, 2FA, auth-provider configuration, export, backup, or restore delivery.
- Pane-specific redesigns owned by #987 and #989–#995.
- Coming-soon inventory/reconciliation (#1002) or iCloud Mail/Calendar delivery (#1003).
- A new router, state library, drawer, component framework, or parallel design system.
- Changing the app's global shell navigation or module runtime registration.

## Fable approval gate

No product code may start until Fable confirms:

- the stable-ID choice (`profile` and `people`) is compatible with the approved destination merges;
- URL/history semantics satisfy list/detail recovery without a second routing system;
- shell-owned contributed-module back navigation is the correct shared seam;
- the routine tier is sufficient given the explicit non-admin E2E regression check; and
- the #965, Instance modules behavior, and #1000 exclusions are collision-safe.

No unresolved product question remains. Fable may return **APPROVE**, **APPROVE WITH CHANGES**, or
**HOLD**; only approved slices may dispatch.
