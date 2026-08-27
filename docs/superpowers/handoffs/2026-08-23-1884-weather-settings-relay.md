# #1884 weather settings card — relay handoff

Spec: `docs/superpowers/specs/2026-08-23-1884-weather-settings-card.md`
Plan (coordinator-approved, with one accessibility correction): `docs/superpowers/plans/2026-08-23-1884-weather-settings-card.md`
Branch/worktree: `build/1884-weather-settings`, this same worktree. `node_modules` present — skip `pnpm install`.
Coordinator: registered Herdr agent name `coordinator` (confirm exactly one live agent has that name before messaging).

## Done (all committed on this branch)

1. `dcea11780` — `packages/ui/src/switch.tsx` + `packages/ui/src/styles/components-forms.css`:
   added optional `label?: string` prop to `Switch`, rendered as `.jds-switch__thumb-label`
   (aria-hidden) inside the thumb. Backward compatible — every other `<Switch>` call site is
   unaffected.
2. `901c54418` — `apps/web/src/settings/settings-personal-panes.tsx` +
   `tests/unit/settings-personal-panes.test.tsx`: merged `Weather location` and `Temperature`
   groups into one `Weather` group; unit toggle now uses `label={weatherUnit === "imperial" ? "F" : "C"}`
   and a **dynamic** `ariaLabel` — `` `Temperature units: ${weatherUnit === "imperial" ? "Fahrenheit" : "Celsius"}` ``
   (this dynamic form was a coordinator-mandated correction: a static "Temperature units" name plus
   bare checked/unchecked doesn't tell assistive tech which state means which unit). Unit tests
   updated/added and passing (6/6): `pnpm vitest run tests/unit/settings-personal-panes.test.tsx`
   exits 0.
3. `5f330827e` — `tests/uat/specs/1571-weather-location-and-units.uat.spec.ts`: updated
   `page.getByLabel("Use Fahrenheit")` locators to the dynamic name (`/Temperature units:/` regex
   for state-agnostic lookups, exact `"Temperature units: Celsius"` / `"...: Fahrenheit"` after
   each toggle), added visible-letter assertions (`toContainText("C")` / `"F"`). **Not yet run
   live** — this is the file that carries the live-path proof; running it is the next step.

Plan itself is committed at `d1c2a4c83`.

## Not yet done — next steps in order

1. **Run the UAT spec live** on the dev instance (see CLAUDE.md/memory: dev instance
   `http://192.168.50.36:5173`, API `:3000`, login `ben@ben.com` / `jarvistest123!`). Use the `run`
   skill or the project's normal Playwright UAT invocation for
   `tests/uat/specs/1571-weather-location-and-units.uat.spec.ts`. This is the live-path proof
   required before wrap-up — confirms the combined card renders, both `C`/`F` states show
   correctly with the right accessible name, and Today updates on toggle.
2. **Full gate** via the `verify-gate` skill (never run `pnpm verify:foundation` or any DB-touching
   test command without it — an unscoped run hits the live dev database). Confirms
   `check:ui-catalogue` (catalogue.json/OPTIONS.md were regenerated during planning but produced no
   diff — `label` is a plain string prop, not an enum/boolean, so the generator doesn't track it;
   this is expected, not a bug), lint, typecheck, `test:unit`, `test:integration` (includes
   `tests/integration/settings-weather-unit.test.ts`, untouched by this change and expected green).
3. **Pre-push trio + rebase**: `pnpm format:check && pnpm lint && pnpm typecheck`, then
   `git fetch origin main && git rebase origin/main` — confirm no other lane touched
   `settings-personal-panes.tsx`, `switch.tsx`, or the UAT spec.
4. **`coordinated-wrap-up`**: push, open non-draft PR, post the live-path proof (UAT run output +
   pass/fail) as a PR comment, report PR + evidence to the coordinator. Do not merge, do not touch
   the board/issue — that's the coordinator's job.

## Open questions / risks

- None outstanding from the coordinator. The one blocking correction (dynamic accessible name) is
  already applied and committed.
- Double-check during the live UAT run that the 10px letter inside the 17px thumb is legible in
  both light and dark theme (`--text`/`--white` tokens used, should adapt automatically, but this
  hasn't been visually confirmed yet — first real visual check happens during the live-path proof).

## Plain-English rule (carry this forward)

Every status update, escalation, and message to the coordinator uses plain English — no jargon,
no invented shorthand. If a sentence needs more than one backtick, say it again without them.
Exact names (files, commands, error strings) are fine and expected. This applies to every agent
spawned from here too.
