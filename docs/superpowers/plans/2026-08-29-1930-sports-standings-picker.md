# Plan: Sports Standings League Picker (#1930)

**Status:** Approved for implementation — Ben 2026-08-29
**Spec:** `docs/superpowers/specs/2026-08-29-1930-sports-standings-picker.md` (approved)
**GitHub:** [#1930](https://github.com/motioneso/moss/issues/1930)
**Risk tier:** medium (owner-private preference write plus keyboard-accessible UI replacement)

## Outcome

Replace the flat standings league `<select>` with a compact hierarchy built from the canonical
Sports catalog. Sports settings controls the saved competition set. Team and whole-league follows
remain the only favorites model and are always visible once in a leading **Following** group.

This is one shippable phase. It adds no table, migration, provider call, dependency outside the
workspace, search, manual ordering, or second favorites model.

## Rulings ledger

- 2026-08-29: Ben's direct request to work #1930 makes #1930 the implementation work item. Do not
  create a duplicate child issue solely to satisfy issue taxonomy.
- The approved spec fixes the hierarchy as Following → sport → optional country/region →
  competition and fixes existing follows as the relevance source.
- Saved input with duplicate or unknown keys is rejected atomically. Stored keys retired from the
  catalog are ignored on read. This keeps the write boundary strict without letting old data break
  the UI.

## Verified current seams

- The canonical catalog is static ordered data in `packages/sports/src/source/catalog.ts:3-28`,
  indexed by key at `packages/sports/src/source/catalog.ts:516-520`. It already owns presentation
  facts such as labels and confederation; grouping metadata belongs here too.
- `SportsService.getCatalog()` maps that canonical data into the authenticated wire response at
  `packages/sports/src/sports-service.ts:164-176`. `CompetitionRef` and the response contract live
  in `packages/shared/src/sports-api.ts:75-86,279-283`, with the Fastify response schema at
  `packages/shared/src/sports-api.ts:740-758`.
- Sports routes already resolve authentication and enter `DataContextRunner` for actor-owned reads
  at `packages/sports/src/routes.ts:36-61,77-88,154-166`. The new preference routes fit this same
  boundary.
- `PreferencesPort` already exposes `get` and `upsert` against `DataContextDb` at
  `packages/db/src/data-context.ts:42-49`. `PreferencesRepository` implements it and derives the
  inserted owner from `app.current_actor_user_id()` at
  `packages/structured-state/src/preferences-repository.ts:15-46`.
- `app.preferences` is already unique by owner/key and has forced owner-only RLS for select,
  insert, update, and delete at `packages/structured-state/sql/0031_structured_state.sql:127-162`.
  Therefore no Sports table or migration is warranted.
- Built-in modules already depend on the public `@moss/structured-state` package and inject its
  repository behind `PreferencesPort`; Calendar is the direct precedent at
  `packages/calendar/package.json:13-23` and `packages/calendar/src/routes.ts:1-53`.
- The Sports web client already owns catalog, follows, and lazy standings calls at
  `packages/sports/src/web/sports-client.ts:19-37`; its React Query keys are centralized at
  `packages/sports/src/web/query-keys.ts:8-20`.
- `SportsFollowsRepository.list()` returns deterministic newest-first follow order with an id
  tie-break at `packages/sports/src/repository.ts:24-35`. That order can drive **Following** without
  inventing another ranking.
- `StandingsRail` owns the current league selection and lazy standings fetch at
  `packages/sports/src/web/sports-standings.tsx:115-175`; only its flat selector changes. The
  division/conference/group control remains separate in the same component.
- The rail header and current selector styles are localized at
  `packages/sports/src/web/styles/sports-1.css:354-383`. Sports settings already has a module-local,
  token-based stylesheet and narrow-width treatment at
  `packages/sports/src/settings/sports-2.css:1-3,188-190`.
- The shared `Menu` correctly closes on outside click/Escape and restores trigger focus at
  `packages/ui/src/menu.tsx:23-51`, but its contract is a flat item array
  (`packages/ui/src/menu.tsx:3-15`). It cannot express this hierarchy without broadening a shared
  primitive used by unrelated callers.
- Existing settings Playwright state is in `tests/e2e/sports-settings.spec.ts:55-124`. The dormant
  Sports page helper already provides overview/module activation at
  `tests/e2e/mock-sports-api.ts:362-397`; it can be promoted into the one shared stateful scenario
  instead of creating another harness.

## Design fork

### Chosen: module-local standings picker

Add one Sports-owned picker component. It mirrors the proven shared-menu behavior—button trigger,
outside/Escape dismissal, focus return—but owns the hierarchy, current selection, and roving option
focus locally. This keeps the change inside Sports and leaves the unchanged standings table and
view selector alone.

### Rejected: generalize `@moss/ui` Menu

The steelman: extending the shared menu would centralize dismissal, focus return, and keyboard
behavior for future grouped menus. Rejected for this phase because its public contract is flat,
the hierarchy and selection semantics are Sports-specific, and changing it expands regression
surface across unrelated callers. Generalize only when a second real grouped-menu consumer exists.

Native `<select>/<optgroup>` remains rejected by the approved spec: HTML cannot represent the
required three-level hierarchy plus a de-duplicated Following section.

## Contracts

Add to `packages/shared/src/sports-api.ts`:

- `CompetitionRef.sportLabel: string`
- `CompetitionRef.regionLabel: string | null`
- `SportsStandingsPreferencesResponse` with
  `selectedCompetitionKeys: readonly string[] | null`
- `UpdateSportsStandingsPreferencesRequest` with
  `selectedCompetitionKeys: readonly string[]`
- `sportsStandingsPreferencesResponseSchema`
- `updateSportsStandingsPreferencesSchema`

`null` means no preference row and preserves the backward-compatible all-catalog default. `[]`
means the actor explicitly selected none.

Add to `packages/sports/src/routes.ts`:

- `SportsRoutesDependencies.preferencesRepository?: PreferencesPort`
- `GET /api/sports/standings-preferences`
- `PUT /api/sports/standings-preferences`

Use the fixed key `sports.standings_competition_keys`. GET filters retired keys and returns distinct
keys in catalog order. PUT requires a unique array containing only current catalog keys, canonicalizes
it to catalog order, and performs one `upsert` inside the actor's `DataContextDb`. Any invalid member
returns 400 before writing.

Add to `packages/sports/src/web/sports-client.ts`:

- `getSportsStandingsPreferences(): Promise<SportsStandingsPreferencesResponse>`
- `updateSportsStandingsPreferences(input: UpdateSportsStandingsPreferencesRequest):
Promise<SportsStandingsPreferencesResponse>`

Add to `packages/sports/src/web/query-keys.ts`:

- `standingsPreferences: ["sports", "standings-preferences"]`

Add `packages/sports/src/web/sports-standings-picker.tsx` with exported contracts only:

- `buildStandingsPickerGroups(catalog, follows, selectedCompetitionKeys):
readonly StandingsPickerGroup[]`
- `StandingsPicker(props: StandingsPickerProps): ReactElement`

Grouping rules are pure and deterministic: followed competition keys are first-occurrence distinct
in repository order; configured remainder follows catalog order; followed entries are removed from
the remainder; region depth is rendered only where the catalog supplies it.

## Task 1 — Catalog and owner-private preference API

**Files**

- Modify `packages/sports/package.json`
- Modify `packages/sports/src/source/catalog.ts`
- Modify `packages/sports/src/sports-service.ts`
- Modify `packages/sports/src/routes.ts`
- Modify `packages/shared/src/sports-api.ts`
- Modify `tests/unit/sports-routes.test.ts`
- Add `tests/integration/sports-standings-preferences.test.ts`

**Decisions**

- Add `@moss/structured-state` as a workspace dependency; instantiate `PreferencesRepository` only
  as the default route dependency, typed as the already-public `PreferencesPort`.
- Populate explicit `sportLabel` and nullable `regionLabel` on every catalog entry. Never derive
  either in the UI from provider slugs, competition keys, or confederation.
- Keep preference validation in the authenticated route boundary. Do not add preference behavior to
  the ESPN-facing `SportsService` or create a Sports repository around a single existing port call.
- Add no SQL. The existing preference table and forced RLS are the storage model.

**Checks**

- Contract/schema test proves grouping fields are required and the PUT body rejects extra fields,
  non-arrays, oversized arrays, duplicates, and unknown keys.
- Route test proves absent → `null`, explicit empty → `[]`, canonical catalog ordering, retired-key
  filtering on read, and that validation failure performs zero writes.
- Integration test creates two actors and proves each reads only their own saved list through the
  runtime role; an admin actor receives no private-data bypass.

## Task 2 — Settings curation

**Files**

- Modify `packages/sports/src/web/sports-client.ts`
- Modify `packages/sports/src/web/query-keys.ts`
- Modify `packages/sports/src/settings/index.tsx`
- Modify `packages/sports/src/settings/sports-2.css`
- Modify `tests/unit/settings-sports-pane.test.tsx`

**Decisions**

- Add one “Standings leagues” section using ordinary checkboxes grouped by catalog sport and
  optional region. It is separate from existing follow controls.
- Render an absent preference as all checked. Each change sends the complete next set and updates
  React Query only from the successful server response—no optimistic state that can survive a
  failed write.
- Disable the checkbox group only while its replacement write is pending. On failure, retain the
  last server-confirmed selection and render one local alert with a retryable explanation.
- Reuse the shared Sports client for catalog/follows/preferences and delete duplicate local fetch
  wrappers where doing so is mechanical; do not introduce a settings service layer.

**Checks**

- Component test proves absent/all, explicit-empty/none, grouped labels, pending disablement,
  server-confirmed update, and failed-write rollback/error behavior.
- Narrow markup uses existing JDS/settings primitives and no invented color, font, radius, or
  shadow values.

## Task 3 — Hierarchical standings picker

**Files**

- Add `packages/sports/src/web/sports-standings-picker.tsx`
- Modify `packages/sports/src/web/sports-standings.tsx`
- Modify `packages/sports/src/web/styles/sports-1.css`
- Modify `tests/unit/sports-page.test.tsx`
- Add `tests/unit/sports-standings-picker.test.tsx`

**Decisions**

- `StandingsRail` queries catalog, follows, and standings preferences using existing clients and
  query keys. The table's current lazy standings fetch and `ViewSelect` remain unchanged.
- Trigger text is the current competition label. The popup uses one labelled list of selectable
  buttons with non-focusable group headings; Arrow Up/Down, Home/End, Enter/Space, Escape, Tab,
  outside click, and trigger focus return are explicit behavior.
- When visibility changes, preserve the current key if still visible; otherwise select the first
  followed key, then first configured key. Do not fetch until a non-empty fallback exists.
- With no visible competition, replace picker/table loading with the concise existing-language
  empty state and a link to `/settings?section=modules&module=sports`.
- Keep the picker inside the sticky rail header, width-bounded to the rail, and token-only. Do not
  alter standings rows, qualification legend, knockout fixtures, or division/group selection.

**Checks**

- Pure grouping test proves Following-first order, team/league follow union, de-duplication,
  catalog-order remainder, optional region depth, unsupported saved-key filtering, fallback, and
  explicit empty behavior.
- Component interaction test proves accessible trigger/group/current names, keyboard movement and
  selection, Escape/outside dismissal, focus return, and the Settings link.
- Existing standings tests continue proving all-table merge, division/group selection, lazy fetch,
  tournament fixtures, and qualification legend behavior.

## Task 4 — One assembled browser proof

**Files**

- Modify `tests/e2e/mock-sports-api.ts`
- Modify `tests/e2e/sports-settings.spec.ts`

**Decisions**

- Promote the existing Sports page mock into the settings spec's one stateful Sports scenario.
  Catalog, follows, preferences, overview, and standings share the same in-memory state; delete the
  duplicate local mock code instead of creating a third harness.
- One authenticated Playwright flow selects NFL and Premier League in Settings, follows an NBA team
  or league, reloads Settings to prove persistence, visits Sports, and proves NBA is pinned once in
  Following while an unchecked/unfollowed league is absent.
- The same flow opens the picker by keyboard, traverses groups/options, selects a league, observes
  the existing lazy standings response, closes with Escape, and checks a 390px viewport for no
  horizontal overflow or clipped trigger.

**Checks**

- The scenario fails against the current flat selector, an optimistic failed save, missing follow
  union, duplicate Following entries, broken persistence, or a picker that only works by pointer.

## Determinism boundary

- Every checkbox, group, current label, save result, loading state, and error renders from catalog,
  follows, preference records, or request state. None comes from model output.
- This feature injects no host-chat turn.
- The model has zero jobs in this feature; there is no prompt or guidance text, so the 150-word
  guidance budget and model-authored-value guards are not applicable.

## Phase 1 exit and kill gate

This whole issue is Phase 1; no follow-on search, starring, manual ordering, or generalized menu is
preplanned.

Ben owns the kill decision after the live dev proof. Stop and revert the picker expansion if the
real 390px and keyboard path is slower or less understandable than the flat selector, if followed
competitions cannot be explained without duplicates, or if owner-isolation evidence fails. Do not
patch those failures with search, a second favorites model, or a shared menu framework.

## Verification

Run each command unpiped and require `EXIT=0`:

```bash
pnpm exec vitest run tests/unit/sports-routes.test.ts tests/unit/settings-sports-pane.test.tsx tests/unit/sports-page.test.tsx tests/unit/sports-standings-picker.test.tsx > /tmp/1930-unit.log 2>&1; echo "EXIT=$?"
pnpm exec vitest run tests/integration/sports-standings-preferences.test.ts > /tmp/1930-integration.log 2>&1; echo "EXIT=$?"
pnpm exec playwright test tests/e2e/sports-settings.spec.ts --project=chromium > /tmp/1930-e2e.log 2>&1; echo "EXIT=$?"
pnpm lint > /tmp/1930-lint.log 2>&1; echo "EXIT=$?"
pnpm format:check > /tmp/1930-format.log 2>&1; echo "EXIT=$?"
pnpm check:file-size > /tmp/1930-filesize.log 2>&1; echo "EXIT=$?"
pnpm typecheck > /tmp/1930-typecheck.log 2>&1; echo "EXIT=$?"
pnpm check:design-tokens > /tmp/1930-design.log 2>&1; echo "EXIT=$?"
```

Before completion, run both isolated gates through `scripts/run-gate.sh` (`start`, `wait`, then
`status`; repeat with `--gate audit:release-hardening`) and require their trap-guaranteed final
sentinels to report `rc=0`.

Finally, exercise the assembled path on the live dev instance and record bounded DOM/network
assertions plus exit code on the PR. Mocked Playwright alone does not satisfy the live-path gate.

## Review checklist

- [x] Approved spec and open work issue
- [x] Every assumed capability cited or resolved
- [x] Contracts and decisions only; no function bodies
- [x] Determinism boundary explicit
- [x] Phase names one assembled Playwright/live e2e proof
- [x] Verification commands unpiped with expected exit code
- [x] Kill gate and owner named
- [x] Rejected shared-menu option steelmanned
