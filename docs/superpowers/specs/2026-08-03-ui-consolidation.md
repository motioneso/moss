# Spec: UI consolidation — one authored component set, one vocabulary

_Locked via grill — Claude + Ben, 2026-08-03. Decisions D1–D8 below are rulings, not proposals._

## Goal

Every surface Jarv1s ships draws its visual identity from one set of authored components with typed
options, discoverable by an agent from a generated catalogue, and enforced in CI. Screens keep their
own layout and nothing else. External modules get the same components and the same guidance, but are
confined rather than blocked.

## The problem, measured

Verified against the working tree on 2026-08-03:

| Fact                                                           | Evidence                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No component library of any kind                               | no Tailwind, Radix, CVA or headless kit in `apps/web/package.json` or the lockfile                                                                                                                                                  |
| 41 `jds-*` families / 175 class variants                       | `apps/web/src/styles/components-*.css`                                                                                                                                                                                              |
| 2,690 `className=` sites, hand-typed                           | `rg -c 'className=' -g '*.tsx' apps packages external-modules`                                                                                                                                                                      |
| 3 React component sets, none aware of the others               | `apps/web/src/ui/card.tsx` emits `ui-card` + inline styles; `packages/settings-ui/src/index.tsx` exports 8 primitives (Switch, Segmented, Badge, Avatar, Select, Group, Row, Field) used only by settings; neither emits `jds-card` |
| 32 authored components imported by nothing                     | `Jarvis Design System/_ds_manifest.json`                                                                                                                                                                                            |
| ~1,300 selectors of per-screen CSS                             | `onb-*` 321, `wl-*` 290, `tk-*` 235, `chatd-*` 143, `cal-*` 109, +15 smaller                                                                                                                                                        |
| 6 classes used in shipped code, defined nowhere                | `jds-btn--ghost` (10× in finance, 8× in settings), `jds-btn--pine`, `jds-btn--active`, `jds-badge--pine`, `jds-caption`, `jds-muted`                                                                                                |
| Module CSS is a global `<style>` tag the module creates itself | `external-modules/finance/src/web/root.tsx:38`; the host only hands over a React root (`apps/web/src/external-modules/loader.ts`)                                                                                                   |
| Some class names are built by interpolation                    | `jds-bubble--${row.role}`, `jds-drift--${drift}` — invisible to a literal scan                                                                                                                                                      |

The invented classes render as unstyled elements. Nothing detects them: no lint rule, no build step,
no test. Both the finance reference module and settings are offenders.

`packages/settings-ui`'s primitives are the closest thing to a component set we have. They are
extraction candidates for `@jarv1s/ui`, not a parallel set to preserve.

## Decisions locked

- **D1. Scope is the whole vocabulary, not just the primitives.** Per-screen CSS is in scope. Uniformity
  was the stated goal; a half-migrated tree leaves two ways to do everything.
- **D2. A screen's own CSS may do layout only** — position, spacing, grid, flex. Colour, type, border,
  radius and shadow come from a component or a token. Finance already works this way and passes
  `check:design-tokens`. Escape hatch: a named exception with a comment, reviewed like any change.
- **D3. Enforced internally, guidance externally.** Internal surfaces (`apps/web`, `packages/*`, and
  `external-modules/finance` — it ships in our image as the reference module) fail CI on violation.
  Modules built in this repo get the components; a module built outside it gets the catalogue and the
  rule as guidance, never a blocker. Publishing `@jarv1s/ui` or the SDK for outside consumption is out
  of scope — both are `private: true` and `external-modules/` is not a workspace, so the epic promises
  components only to in-repo modules. Every module's CSS is confined regardless of origin.
- **D4. Code is the truth.** Components live in `packages/ui` (`@jarv1s/ui`). The design system folder
  was a static starting point and becomes a generated preview surface. New designs still start as
  hand-authored previews; once accepted, the component moves into code and the preview regenerates.
- **D5. A generated catalogue in the repo,** written in the shadcn registry shape so it can be served
  over MCP later without rework. CI fails if it is stale. Serving it is out of scope for this epic.
  Precedent: `scripts/build-app-map.ts` → `dist/app-map.json`, already inside `verify:foundation`.
- **D6. Like-for-like migration.** Each section swaps bespoke CSS for components while keeping its
  layout. Before a section starts, its intended visible changes are listed and approved by Ben.
  Anything not on that list is a regression. Redesign is a separate issue, afterwards.
- **D7. Section order** — foundation, then calendar as pilot, then today, then onboarding + wellness,
  then tasks + shipped modules, then settings + chat last (epics #983 and #1238 are live in those
  files). Calendar leads because it is the smallest complete surface (789 lines), not because it
  matters least; today follows immediately because it is the front page.
  **The live-epic avoidance is partial, not absolute.** Foundation's own day-one work edits
  `settings-people-pane.tsx`, `settings-skills-pane.tsx` (#983) and
  `chat/assistant-surface/surface.tsx` (#1238), because that is where the undefined and interpolated
  classes live. Those specific edits are agreed with the epic owners before foundation starts; what
  section 6 defers is the bulk migration, not every line.
- **D8. Build against demand.** Foundation ships only the components calendar needs (~12), preferring
  extraction from `packages/settings-ui` over fresh authoring. Each section adds what it needs.
  Evidence: `ui/card.tsx`, the settings-ui primitives and the 32-component design folder were all built
  ahead of broader demand and none spread past its first caller.
- **D9. Module CSS is confined by selector prefixing, enforced at the host, not by shadow DOM.** Shadow
  DOM is the one mechanism that would also cut modules off from the host `jds-*` stylesheet, defeating
  the epic. Instead: the module contract changes so a module hands the host a CSS string rather than
  creating a `<style>` element, and **the host is the enforcement point** — it parses the incoming CSS
  and rejects any rule not scoped to that module's own `[data-module="…"]` root, whatever produced it.
  `scripts/build-external-module.ts` applies the same transform at build time as a convenience for
  in-repo modules, but a module that arrives unprefixed is rewritten or refused at install, so the
  guarantee does not depend on who built it. Modules keep the host cascade; only their own rules are
  boxed in.

## Approach

### Section 1 — Foundation

Delivers `packages/ui`, the catalogue, the guards, and module CSS confinement. No screen changes.

Contracts:

- `@jarv1s/ui` exports one component per file, each with a typed options interface. Browser-safe: no
  `node:*`, same constraint `@jarv1s/shared` carries.
- Components render the existing `jds-*` classes. The authored CSS is not rewritten in this epic —
  it moves to `packages/ui` and keeps its class names, so migration is swap-in, not restyle.
- **The CSS move must not break the cascade.** `packages/ui` exports one `@jarv1s/ui/styles.css`
  entry. The same commit replaces lines 10–11 of `apps/web/src/styles/index.css` with that single
  import, at the same position. Moving the files without rewiring the import deletes the styling of
  every screen that still types class strings — which, at foundation time, is all of them.
- `@jarv1s/module-web-sdk` re-exports the component surface. Finance builds with `jsxFactory: h` and
  no React dependency, so the SDK also exposes a JSX shim over the React that `loader.ts` already
  publishes on `window.__JARVIS_MODULE_RUNTIME__` — concretely, `h` and `Fragment` bound to that
  runtime handle, so a module keeps its existing `jsxFactory` config and gains components without
  taking a React dependency. `scripts/build-external-module.ts` aliases `react`/`react-dom` to the
  runtime handle and marks them external. Acceptance is finance's own produced bundle: no bundled
  React in it, and a `@jarv1s/ui` component rendering in a live-path check.
- A module author imports components, never class strings.
- `scripts/build-ui-catalogue.ts` emits the catalogue from component source. Checked in, so an agent
  reads it without a build. CI regenerates and fails on diff.
- **The catalogue carries typed option schemas, not just file lists, and something points an agent at
  it.** The plain shadcn registry shape records names, files and dependencies — not the options an
  agent needs to call a component correctly, which is what the Goal actually promises. And an artifact
  nobody is directed to read is exactly the failure already in the problem table: 32 components in
  `_ds_manifest.json`, imported by nothing. So each registry item is extended with its component's
  option schema, and foundation's deliverable includes the consumption hook — a `CLAUDE.md` pointer
  naming the catalogue as the source of truth for available components. Acceptance: a fresh agent
  asked to build a screen reaches for a catalogue component rather than typing a class string.
- **A one-page option vocabulary,** linted by `check:ui-catalogue` against new components. Without it,
  D8's build-against-demand plus one task issue per section means option naming is reviewed by nobody
  — D6 change lists review visible changes, not APIs — and the existing primitives already disagree
  (`Badge` takes `tone`, `Indicator` takes `status`), while the invented classes name colours
  directly (`--pine`). The vocabulary fixes the semantics of `variant`, `tone`, `size` and `state`,
  and bans colour names as option values.
- **`apps/web/src/ui/card.tsx` is retired in the calendar section** and its callers moved to
  `@jarv1s/ui`. It is named in the problem table as one of the three competing sets; without an owning
  section it survives the epic and the count stays at three.
- Module CSS confinement per D9. Three pieces, all in foundation:
  - **Contract.** `ExternalWebContribution` gains an optional `css: string`. The host installs one
    `<style>` per module id, deduplicated by id, set via `textContent` never `innerHTML`, and removed
    when the contribution unmounts. Module-created `<style>` elements become a contract violation.
    The web contract version bumps; finance is the only module that has to move.
  - **Transform.** A real CSS parse, not a regex — `styles.ts` is a TypeScript template string today
    and `build-external-module.ts` has no CSS stage at all, so this is new machinery. Foundation picks
    the parser and states the grammar semantics explicitly for the cases that a naive prefixer gets
    wrong: comma-separated selector lists (each branch prefixed), `@media`/`@supports` (wrapper passes
    through, inner selectors prefixed), `@keyframes` and other custom identifiers (namespaced per
    module), pseudo-elements and pseudo-classes (preserved), nested rules. `:root`, `html` and `body`
    are rewritten to the module root or refused. Three constraints decide whether D9 confines anything
    at all, so they are recorded here rather than left to the implementer:
    - **The scope root is host-owned and unique.** The host creates the scope element and its
      identifier; a module cannot supply or duplicate `data-module`. Otherwise a rewritten selector
      still reaches another matching subtree or a portal. Finance sets its own `data-module="finance"`
      today, so this is a change.
    - **Namespacing `@keyframes` means rewriting every reference** — `animation`, `animation-name`,
      shorthand and nested declarations — atomically with the declaration. Renaming only the at-rule
      silently breaks the animation. Tested at both declaration and use.
    - **Global at-rules are rejected or namespaced by category, not by a deny-list of three.** At
      minimum `@import`, `@font-face`, `@property`, `@namespace`, `@page`, `@counter-style` and
      unscoped `@layer` affect the document without going through a selector.
  - **Fixtures.** The transform ships with adversarial cases, including a module that tries
    `.jds-btn { display: none }`, one that escapes via a comma list, and one that collides on a
    `@keyframes` name with the host.

Foundation's **first** task, before any guard is switched on: map each of the 6 undefined classes to an
approved existing class or a temporary compatibility definition, and land those swaps. This is a
visible change and carries a D6 change list. Without it the gate cannot merge — it would red the tree
on day one, and settings, which holds most of the violations, does not migrate until section 6.

Guards added to `verify:foundation`:

1. `check:ui-classes` — fails on any literal `jds-*` class used in TSX that no CSS file defines. Its
   acceptance test is the 6 known-undefined classes: it must fail on the tree as it stands today, and
   pass only after foundation's mapping task lands.
   **The definition scope is `packages/ui`'s styles plus `apps/web/src/styles/` — nothing else.** Not
   `Jarvis Design System/` (D4 makes it generated _from_ `packages/ui`, so counting it as a definition
   source is circular) and not `.claude/worktrees/`, which holds 13 full copies of the tree at
   different branches; a repo-wide glob would make the guard's result depend on which other agents
   have worktrees open.
   The scope pin is load-bearing, not tidiness: `Jarvis Design System/components.css:124` really does
   define `.jds-badge--pine`, so a repo-wide glob counts one of the six as defined and the acceptance
   test silently weakens. None of the six are defined inside the pinned scope — verified 2026-08-03.
   **The guard must enumerate its files explicitly rather than glob a directory**, because the design
   folder is gitignored (`.gitignore:33`): a Node/`fast-glob` scan sees it, a `ripgrep` scan does not,
   so an unpinned implementation gives different answers depending on which tool it reaches for. That
   discrepancy is what hid this class from an earlier verification pass on this very spec.
2. `check:ui-classes` also rejects `jds-*` names built by suffix interpolation
   (`` `jds-drift--${drift}` ``) outside `packages/ui`, since a literal scan cannot see them. Inside
   the package, variant-to-class mapping lives in typed constants. Template literals that carry whole
   literal classes are fine and are already scanned.
   **This guard has the same day-one problem guard 1 has, and gets the same treatment.** 9 interpolation
   sites exist today — including `packages/settings-ui/src/index.tsx`, the extraction source for
   foundation's own components. Foundation's mapping task converts them alongside the undefined
   classes, or the guard ships with an explicit burn-down list that each section empties. It does not
   ship as a bare gate.
3. `check:ui-catalogue` — fails when the checked-in catalogue differs from a fresh generation.
4. `check:design-tokens` grows a banned-property list for feature CSS, per D2, scoped to migrated
   sections only so it does not red the tree on day one. The list is enumerated in the foundation
   task, not left to judgment: `color`, `background`/`background-color`, `border`/`border-color`,
   `font-family`, `font-size`, `font-weight`, `box-shadow`, `border-radius`, and the four cases that
   are otherwise argued every review — `background-image` gradients, `outline`, `fill`/`stroke`,
   `filter: drop-shadow`.
5. A per-section component guard: once a section migrates, its paths are added to a list where any raw
   `jds-*` string fails. A defined-but-hand-typed class passes check 1, so without this nothing
   actually forces component use — the stated goal.
6. The same per-section guard covers **inline styles**, which otherwise evade every other check: a
   class scan cannot see them and `check:design-tokens` reads CSS files. 36 files under
   `apps/web/src` use `style={{…}}` today, 50 lines of them carrying a visual property, so without
   this a migrated section can pass all five guards while hard-coding a hex colour in JSX. Layout
   properties inline stay legal per D2; the banned list from guard 4 applies.

Guards 4, 5 and 6 are the ones that enforce the epic's actual goal, so each ships with a failing-case
test, not just the guards whose failures are easy to construct.

Test cases (behaviour, and why each fails against a broken implementation):

- A TSX file using `jds-btn--nonexistent` fails `check:ui-classes`. Without the class-set diff, an
  invented class passes silently — the exact live defect in finance.
- A module injecting `.jds-btn { display: none }` does not affect host buttons. Without confinement
  the host button disappears, which is the current behaviour.
- Renaming a component option without regenerating fails `check:ui-catalogue`. Without the staleness
  check the catalogue drifts and an agent builds against options that no longer exist.
- `@jarv1s/ui` importing `node:fs` fails the browser-bundle check. Without it the web build breaks at
  runtime, not at CI.

### Sections 2–6

Each section is one task issue and follows the same shape:

1. List the intended visible changes; Ben approves before work starts (D6).
2. Add to `@jarv1s/ui` only what this section needs (D8).
3. Replace the section's class strings with components; reduce its CSS to layout (D2).
4. Delete the section's dead selectors in the same PR — no orphan CSS left behind.
5. Focused browser DOM/computed-style assertions against the approved list, plus live-path proof on a dev instance.

Order and size: calendar (789 lines) → **today (2,089: `kit-today.css` 949, `kit-today-feeds.css` 388,
`kit-today-misc.css` 475, `kit-weather.css` 67, `command-palette.css` 210; 9 TSX files,
`today-page.tsx` alone 900 lines), plus notifications and the command palette** → onboarding (2,068) +
wellness (1,865) → tasks (1,426) + sports/news/finance → settings (3,038) + chat (1,177).

Today was missing from the first draft of this spec. It is the app's front page and the second-largest
pile in the tree — omitting it would have left the most-seen surface on the old vocabulary while
claiming the whole vocabulary was consolidated (D1).

## Invariants

- Old class names keep working until a section's final PR deletes them. Sections land independently;
  there is no big-bang cutover.
- No section merges with its CSS reduced but its markup unconverted, or the reverse.
- The catalogue is generated, never hand-edited.
- Job Search (#1280) has no UI files yet. Its UI builds on `@jarv1s/ui` and must not introduce a ninth
  prefix — foundation should land before its web slice starts.

## Risks / open questions

- **Section 5 may need a component reshaped after four sections use it.** Accepted: options are typed,
  so a reshape is a compile error at every call site, not silent drift.
- **Settings is the largest pile (3,038 lines) and is last.** If #983 stalls, settings blocks. Revisit
  the order if #983 has not landed by the time section 5 finishes.
- **Confinement changes the module web contract** (D9): a module hands over CSS instead of creating a
  `<style>`. That is a breaking change for any module already built, which today means finance only.
  Bumping the contract version is part of foundation.
- **Browser assertion coverage is unverified.** If it does not already cover a section's screens, that
  section's first task is adding the capture.

## Out of scope

- Adopting any third-party component library. No Tailwind, no Radix, no shadcn components. The design
  language stays authored.
- Serving the catalogue over MCP or HTTP. Format now, serving later.
- Redesign of any screen (D6).
- Changing tokens, fonts or the colour system.
- Third-party module enforcement (D3).
- Publishing `@jarv1s/ui` or `@jarv1s/module-web-sdk` for consumption outside this repo, and any host
  compatibility policy that would imply. Both stay `private: true`.
- Rewriting the authored `jds-*` CSS. It moves packages and keeps its class names.

## GitHub structure

One epic, nine task issues: foundation, calendar, **today** (including notifications and the command
palette), onboarding, wellness, tasks, modules, settings, chat. Each task links `Part of #<epic>` and
carries its approved change list before work starts.

Foundation's issue additionally carries the pre-gate mapping work — the 6 undefined classes and the 9
interpolation sites — and names the #983 and #1238 owners whose files it touches on day one.
