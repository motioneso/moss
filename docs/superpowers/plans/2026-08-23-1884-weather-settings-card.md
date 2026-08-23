# Combined Weather settings card — build plan (#1884)

Part of #1884. Spec: `docs/superpowers/specs/2026-08-23-1884-weather-settings-card.md` (approved).

## Seams check (file:line citations)

- Current groups live in `apps/web/src/settings/settings-personal-panes.tsx:335` (`Weather
  location` group, ends `:406`) and `:408` (`Temperature` group, ends `:421`). Both are siblings
  inside `ProfilePane`'s returned JSX — merging is a matter of deleting the second `<Group>`
  wrapper and moving its `<Row>` into the first.
- `weatherUnit`, `weatherUnitQuery`, `weatherUnitMutation` are already computed at
  `settings-personal-panes.tsx:214-227`; `putWeatherUnitSettings`'s `onSuccess` already calls
  `queryClient.invalidateQueries({ queryKey: queryKeys.weather.today })` at `:224` — this
  invalidation must not change.
- `Switch` is `packages/ui/src/switch.tsx:1-23`, a native `<input type="checkbox">` wrapped in
  `<label className="jds-switch">`, exported re-export chain:
  `apps/web/src/settings/settings-ui.tsx:1` → `@moss/ui`. It already carries native checkbox
  semantics (`checked`, `aria-label`) that assistive tech reads directly — no `role`/`aria-checked`
  needed on top.
- `Segmented` (`packages/ui/src/segmented.tsx`) renders both options as visible buttons
  (`aria-pressed` per button) — explicitly ruled out by the spec ("not a two-sided segmented
  control"), confirmed by reading the component: it always renders every entry in `options`.
- CSS: layout rules for `.jds-switch`/`.jds-switch__track`/`.jds-switch__thumb` are in
  `apps/web/src/styles/components-forms.css:117-148` (structural: size, position, transform); the
  color/token rules for the same classes are in `packages/ui/src/styles/components-forms.css:88-104`
  (background, border, focus ring — all via `var(--*)` tokens, no raw colors). Both files already
  define the classes; no new stylesheet is needed, only an addition inside the existing rule sets.
- `packages/ui/catalogue.json:392-402` lists `Switch`'s only flags as `checked`/`disabled` — adding
  a new optional prop needs a catalogue rebuild (`pnpm build:ui-catalogue`) so `check:ui-catalogue`
  doesn't flag it as undocumented.
- Test file already exists and owns this surface: `tests/unit/settings-personal-panes.test.tsx`
  (server-rendered via `renderToString`, `QueryClient` preseeded via `queryKeys.weather.unit`
  `queryKeys.weather.location` etc. at lines 84-93). This is the "focused test" the spec's
  Verification section requires — extend it, don't create a parallel file.
- Integration test `tests/integration/settings-weather-unit.test.ts` covers the API contract only
  (not UI) — out of scope, left untouched, expected to stay green because the API/mutation contract
  doesn't change.
- No existing pattern in the repo renders a state-dependent letter inside a switch thumb (checked
  via `grep -rn "jds-toggle\|unit-toggle" apps/web/src`, no hits) — this is new but stays inside the
  `jds-switch` vocabulary, not a new component family.

## Determinism boundary

N/A — no model/AI involvement. This is a static settings control backed by REST mutations that
already exist; no new turns, no model-authored content.

## Decision: how the toggle shows "C"/"F"

Extend `Switch` with an optional `label?: string` prop rendered as text content inside
`.jds-switch__thumb`. The caller computes the label from its own state (`weatherUnit === "imperial"
? "F" : "C"`), so `Switch` stays a dumb, generic checkbox wrapper — this is the same generalization
direction as its existing `disabled`/`checked` flags, adds no new element, and every existing call
site (14 other files) is unaffected because the prop is optional and defaults to rendering nothing.

Rejected: `Segmented` (spec explicitly rules out a two-option visible control); a bespoke new
component (violates "reuse existing JDS switch/control vocabulary... do not invent a new style
system").

## Task 1 — extend `Switch` with an optional letter label

Files:
- `packages/ui/src/switch.tsx`
- `packages/ui/src/styles/components-forms.css` (color/sizing for the label text — add rules under
  the existing `.jds-switch__thumb` block, e.g. a `.jds-switch__thumb-label` class using
  `var(--text-xs)`/`var(--white)`/existing weight token; no new custom properties)
- `packages/ui/catalogue.json`, `packages/ui/OPTIONS.md` (regenerate via `pnpm build:ui-catalogue`)

Signature change:
```ts
export interface SwitchProps {
  readonly ariaLabel: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly onChange?: (checked: boolean) => void;
}
```
`label`, when present, renders as a `<span className="jds-switch__thumb-label" aria-hidden="true">`
inside `.jds-switch__thumb`. `aria-hidden` because the visible letter is a sighted-user affordance; the accessible name itself
(computed by the caller, see Task 2) is what carries the unit information to assistive tech — no
ARIA role is added on top of the native checkbox.

Test case (extend `tests/unit/settings-personal-panes.test.tsx`, no separate `switch.test` file —
this repo has no existing per-primitive `@moss/ui` test suite and adding one is out of scope):
would fail against a broken implementation that always renders "F", or that renders both letters
at once, or that omits the letter when `label` is passed.

## Task 2 — merge the groups in `ProfilePane`

File: `apps/web/src/settings/settings-personal-panes.tsx`

- Rename the `Group` at `:335` from `title="Weather location"` to `title="Weather"`. Keep its `desc`
  and all existing children (search field, Search row, candidate rows, Manual override row)
  unchanged.
- Delete the `Group title="Temperature"` wrapper at `:408-421`. Move its one `<Row>` inside the
  renamed `Weather` group, immediately after the `Manual override` row.
- Replace that `Row`'s `control` from `<Switch ariaLabel="Use Fahrenheit" .../>` to:
  ```tsx
  <Switch
    ariaLabel={`Temperature units: ${weatherUnit === "imperial" ? "Fahrenheit" : "Celsius"}`}
    checked={weatherUnit === "imperial"}
    disabled={weatherUnitQuery.isLoading || weatherUnitMutation.isPending}
    label={weatherUnit === "imperial" ? "F" : "C"}
    onChange={(enabled) => weatherUnitMutation.mutate(enabled ? "imperial" : "metric")}
  />
  ```
  **Coordinator correction (blocking, resolved):** a static `ariaLabel="Temperature units"` plus
  the checkbox's bare `checked`/`unchecked` state does not satisfy the spec's "assistive technology
  must be able to determine the selected unit" — a screen reader announces only "Temperature units,
  checked", which doesn't say checked means which unit. Fix: the accessible name is now
  **dynamic**, carrying both the setting name and the current full unit word ("Temperature units:
  Fahrenheit" / "Temperature units: Celsius"). This stays a plain native `<input
  type="checkbox">` — no ARIA role added — and the visible `C`/`F` span stays `aria-hidden` since
  the accessible name alone already fully conveys state.
  Keep the `Row`'s `name`/`desc` text as-is (already correct: `"Weather temperatures are shown in
  Fahrenheit/Celsius."`).
- No changes to `weatherLocationQuery`, `weatherLocationMutation`, `weatherUnitQuery`,
  `weatherUnitMutation`, `clearWeatherLocation`, or any query key — persistence, loading/pending
  disabling, error toasts (`onError: (error) => toast(readError(error), { tone: "drift" })`), and
  the `queryKeys.weather.today` invalidation on unit change are all untouched, satisfying the
  spec's "preserve existing... behavior" requirement by construction (no line in that logic is
  edited).

Test cases (extend `tests/unit/settings-personal-panes.test.tsx`):
- `html` contains exactly one `Weather` group heading and does **not** contain `"Weather location"`
  or `"Temperature"` as group titles — would fail against a version that only renamed the group
  without deleting the old `Temperature` wrapper, or that left both headings.
- Rendered with `queryKeys.weather.unit` seeded `{ unit: "metric" }`: HTML contains the visible
  letter `C` inside the switch and does not contain `F` in that control's markup — would fail if
  the label defaulted to the wrong letter or was hardcoded.
- Rendered with `queryKeys.weather.unit` seeded `{ unit: "imperial" }`: HTML contains `F`, not `C`,
  in that control — would fail against a control that always shows one letter regardless of state.
- Metric render: `aria-label="Temperature units: Celsius"` present on the checkbox input. Imperial
  render: `aria-label="Temperature units: Fahrenheit"`. Both would fail if the accessible name were
  a static string (doesn't change with state) or still said "Use Fahrenheit".
- Existing assertions (`Quiet hours`, `Location`, `>Member<` exclusions, data export ordering,
  `parseWeatherLocationFields`, primed-location `"Currently using Home."`) stay and must still pass
  unmodified — they cover behavior this change must not touch.

## Task 3 — update the existing UAT spec (already wired, do not create a new file)

File: `tests/uat/specs/1571-weather-location-and-units.uat.spec.ts` — already present and already
listed in `.claude/skills/coordinate/uat-trigger-map.tsv:83-85` against
`apps/web/src/settings/settings-personal-panes.tsx`, `packages/weather/**`, `packages/settings/**`.
No new trigger-map row needed; this file already blocks on the exact file we're editing.

Every `page.getByLabel("Use Fahrenheit")` call (`:34`, `:85`) breaks once the accessible name
becomes dynamic (`"Temperature units: Celsius"` / `"Temperature units: Fahrenheit"`). Replace with
a regex locator that tolerates either state: `page.getByLabel(/Temperature units:/)` for lookups
that don't depend on which unit is current (`:34`, `:85` before the first toggle), and, after each
toggle, an explicit assertion on the exact resulting name — `page.getByLabel("Temperature units:
Celsius")` / `page.getByLabel("Temperature units: Fahrenheit")` — which both proves the toggle
worked and gives the UAT run the accessible-name proof the coordinator's correction requires. The
`.locator("..").click()` pattern (`:87`, `:97`) clicks the `<label>` wrapper, which still works
unchanged since `Switch`'s DOM structure (`<label class="jds-switch"><input/>...</label>`) doesn't
change. Add one visible-letter assertion after the existing Fahrenheit-toggle block (`:97-100`)
that the control shows `F` (e.g. `await expect(page.getByLabel("Temperature units:
Fahrenheit").locator("..")).toContainText("F")`) and, after the Celsius branch (`:86-89`), that it
shows `C` — this turns the existing "Today updates" coverage into proof of the spec's exact
requirement (both unit states visible AND accessible, not just the underlying value). The rest of
the spec (place search, ambiguity handling, Today temperature/city assertions, `afterAll` restore)
is already exactly the live-path proof the spec's Verification section asks for and needs no other
changes.

Run this spec live per the `run` skill / live dev instance during wrap-up; its Playwright output
(pass/fail per assertion) is the proof posted to the PR, satisfying the live-path gate without a
new spec file.

## Verification commands

```bash
pnpm build:ui-catalogue > /tmp/catalogue.log 2>&1; echo "EXIT=$?"
pnpm vitest run tests/unit/settings-personal-panes.test.tsx > /tmp/unit.log 2>&1; echo "EXIT=$?"
pnpm vitest run tests/integration/settings-weather-unit.test.ts > /tmp/int.log 2>&1; echo "EXIT=$?"
```
Full gate (`pnpm verify:foundation`) only via the `verify-gate` skill at wrap-up, per CLAUDE.md.

## Kill gate

Owner: coordinator. If Task 1's letter-in-thumb rendering turns out to fail a legibility/contrast
check against `tokens.css` (e.g. no token gives readable contrast at 17px), stop and escalate for a
design call rather than inventing a new token or growing the thumb — that's a fork the coordinator
routes, not a build decision.

## Non-goals (from spec)

Location search/geocoding/storage/automatic-location behavior, the metric/imperial API contract,
additional unit choices or per-location units, and the rest of Account & preferences are all
unchanged.
