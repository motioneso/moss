# Moss design system

The one reference for how Moss looks. Park Press direction, finished 2026-09-05; Today is the
reference implementation. When this file and the shipped CSS disagree, the CSS in
`apps/web/src/styles/tokens.css` and `packages/ui/src/styles/` wins, and this file gets fixed.

Workflow and the invented-class audit: `.claude/skills/design-system/SKILL.md`.

## Sources of truth

| What                           | Where                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| Tokens (every colour literal)  | `apps/web/src/styles/tokens.css`                                                     |
| Shared primitives (CSS)        | `packages/ui/src/styles/*.css`, imported by `packages/ui/src/styles.css`             |
| Shared primitives (React)      | `packages/ui/src/*.tsx`, exported from `@moss/ui`                                    |
| Legal variant/size/tone values | `packages/ui/OPTIONS.md`, `packages/ui/catalogue.json` (generated)                   |
| App screens (layout)           | `apps/web/src/styles/*.css`                                                          |
| Paper grain                    | `apps/web/src/styles/texture.css`                                                    |
| Runtime custom themes          | `apps/web/src/theme/theme-runtime.ts`                                                |
| Load order                     | `apps/web/src/styles/index.css`: tokens, then `@moss/ui/styles.css`, then app sheets |

Regenerate the catalogue with `pnpm build:ui-catalogue` after changing a component's prop types.

## Typography

| Token            | Value                                      | Use                             |
| ---------------- | ------------------------------------------ | ------------------------------- |
| `--font-display` | `"Archivo", var(--font-sans)`              | Headings, titles, mastheads     |
| `--font-sans`    | Helvetica Neue, Helvetica, system-ui stack | Body, labels, eyebrows, numbers |

- Archivo is self-hosted from `apps/web/public/fonts/archivo/` (weights 400-900). Never add a
  remote font `@import`; it breaks the content security policy.
- Display and sans share one fallback chain, so they cannot drift apart on machines without
  Archivo.
- Numbers line up with `font-variant-numeric: tabular-nums`, not a fixed-width face.
- No serif, anywhere (Ben, 2026-09-24). There is no serif token.
- Monospace only for real code: chat code blocks (`.chatd-md code`) and code snippets
  (`.set2-note code`). Written as a local literal stack, never a token.
- Scale: `--text-2xs` 11px, `--text-xs` 12, `--text-sm` 13, `--text-md` 15, `--text-lg` 17,
  `--text-xl` 20, `--text-2xl` 24, `--text-3xl` 30, `--text-4xl` 38, `--text-5xl` 48,
  `--text-6xl` 60.
- Weights: `--weight-regular` 400 through `--weight-black` 900 (`medium`, `semibold`, `strong`
  650, `bold`, `heavy` 800).
- Leading: `--leading-none|tight|snug|normal|relaxed`. Tracking: `--tracking-tight|snug|normal|wide|caps`.
- Eyebrows: sans, `--text-2xs`, semibold, `--tracking-caps`, uppercase, `--text-subtle`.
- Prose measure: `--measure` (66ch) or `--measure-narrow` (48ch). Only real prose gets a measure.

## Colour

Page is bone paper, cards are warm white, one living accent (forest) plus decorative gold.

| Role                 | Tokens                                                                               |
| -------------------- | ------------------------------------------------------------------------------------ |
| Page / surfaces      | `--bg` (`--paper`), `--surface`, `--surface-2`, `--surface-3`                        |
| Text                 | `--text`, `--text-muted`, `--text-subtle`, `--text-faint`, `--text-on-accent`        |
| Lines                | `--border-subtle`, `--border`, `--border-strong` (`--line*`)                         |
| Accent               | `--accent`, `--accent-hover`, `--accent-fg` (text), `--accent-soft`, `--accent-rule` |
| Gold (decoration)    | `--gold`, `--gold-strong`, `--gold-soft`, `--gold-ink`                               |
| Drift / caution      | `--warn*` (`--amber*`). Anti-shame, never error red                                  |
| Error / destructive  | `--danger*` (`--red*`). True errors and deletes only                                 |
| Quiet info           | `--info*` (`--steel*`)                                                               |
| Masthead band        | `--masthead-bg`, `-fg`, `-fg-muted`, `-accent`, `-rule`, `-action-bg`, `-action-fg`  |
| Today hero band      | `--hero-bg`, `--hero-fg`, `--hero-fg-muted`, `--hero-accent`                         |
| Dark "next up" block | `--rail-bg`, `--rail-fg`, `--rail-fg-muted`, `--rail-marker`                         |
| Hover                | `--hover-tint`, `--hover-raise`, `--surface-hover`                                   |
| Focus                | `--focus-ring`                                                                       |

- Use semantic aliases (`--text`, `--accent`, `--border`) over primitives (`--ink`, `--forest`,
  `--line`) where one exists.
- Gold is never semantic. Caution is amber; error is red.
- `--forest-*` is the accent slot. Themes re-point it, so "forest" means "the current accent".

## Themes

| Theme                    | How it is set                                                   |
| ------------------------ | --------------------------------------------------------------- |
| Default (forest)         | `:root`                                                         |
| Sage, Canyon, Teal, Dusk | `[data-theme="<name>"]`, re-points the accent ramp              |
| Dark (warm charcoal)     | `[data-color-mode="dark"]`, combinable with any park theme      |
| Custom                   | Runtime: paper, surface, ink, line, accent; accent ramp derived |

- Red, amber and steel stay locked in every theme.
- Anything built from tokens follows every theme for free. A hardcoded colour breaks at least one.
- Check new UI in light, dark and at least one park theme.

## Spacing, radius, elevation

- Space: `--space-1` 4px, `-2` 8, `-3` 12, `-4` 16, `-5` 20, `-6` 24, `-7` 32, `-8` 40,
  `-9` 48, `-10` 64, `-11` 80, `-12` 96 (`-0-5` 2px, `-14` 128).
- Radius: `--radius-xs` 4, `-sm` 6, `-md` 8, `-lg` 10, `--radius-card` 12, `-xl` 16,
  `-2xl` 22, `-pill`.
- Surfaces separate by hairline rules, not shadow. `--shadow-xs` and `--shadow-sm` are keyline
  rings; `--shadow-md|lg|xl`, `--shadow-pop`, `--shadow-drawer` are for things that float
  (dialogs, menus, drawers).
- Motion: `--dur-*`, `--ease-*`, `--transition-control`. Reduced motion is handled in `tokens.css`.

## Page width

- Use the horizontal space (Ben, reaffirmed 2026-08-19). Working screens run wide.
- Today: `.cmd-wrap` max 1220px. Workshop: `.workshop-page` max 1220px. `--container` 1240px.
- Sidebar: pale, `--nav-w` 194px (168px at 1180px and below), collapsible to an icon rail.
- Phone: chat stays a drawer over the page.

## Page anatomy (Today is the reference)

| Part                  | Shipped as                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Section-home masthead | `<Masthead tone="field">` (`.jds-masthead--field`): full-bleed forest band, 4px gold bottom rule, eyebrow, Archivo title, optional lede and aside. Action button `<Button variant="field">` |
| Plain masthead        | `<Masthead>`: ink on paper, with `MastheadDateline` and `MastheadClock`                                                                                                                     |
| Today hero            | `.today-hero` (Today only, `kit-today-hero.css`): forest band, 3px gold rule, contour texture, weather row, briefing summary                                                                |
| Section index         | `.today-hero__sections`: a hairline-ruled row of in-page links under the hero                                                                                                               |
| Main grid             | `.cmd-grid`: content column plus 270px rail (`.cmd-aside`), stacks on narrow screens                                                                                                        |
| Section               | `.jds-brief`: hairline top rule (`--border`), `--space-5` vertical padding, no card                                                                                                         |
| Section head          | `.jds-brief__head` + `.jds-brief__kicker` (eyebrow) + `.jds-brief__title` (Archivo 24px)                                                                                                    |
| Numbered section head | `.tl-head` / `.desk-head` / `.ev-head`: small accent number over a 2px gold underline, Archivo title, right-aligned meta. Today-local copies, not yet a primitive                           |
| Rows                  | `<RowIndex>` (`.jds-index`): heavy rule on top, one hairline per row, meta right-aligned; hover is a straight inset gold marker plus accent title, never a filled block                     |
| Cards                 | `<Card>` (`.jds-card`): `--surface`, `--border`, `--radius-card`. Use for contained widgets, not for whole sections                                                                         |
| Hairlines             | `<Divider>` (`.jds-divider`, `--strong`, `--ink`, `--vertical`), `.jds-section-head__rule`                                                                                                  |
| Eyebrows              | `.jds-eyebrow` (`--gold`, `--muted`, `--accent` tones), `.jds-masthead__eyebrow`                                                                                                            |
| Small text            | `.jds-caption`, `.jds-label`                                                                                                                                                                |
| Footers               | No shared section footer. Dialogs use `.jds-dialog__foot`; the briefing reader uses `.brief-reader__footer-*`                                                                               |
| Paper grain           | `body::after` in `texture.css`; static, `--texture-opacity`                                                                                                                                 |

Workshop project screen: chat fixed to the viewport, only the thread scrolls, composer pinned at
the bottom; an artifact panel beside it whose tabs appear only once they have content.

## Primitives

Import from `@moss/ui`. Full option list in `packages/ui/OPTIONS.md`.

| Group     | Components                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------- |
| Actions   | `Button`, `ButtonLink`, `IconButton`, `Menu`, `Segmented`, `Switch`                                   |
| Forms     | `Field`, `FormLabel`, `Select`, `Combobox`                                                            |
| Structure | `Masthead`, `Card`, `Divider`, `RowIndex`, `Dialog`, `PeekPanel`, `PeekCloseButton`, `HeldBanner`     |
| Status    | `Badge`, `Chip`, `Indicator`, `StatTile`, `InfoTip`, `EmptyState`                                     |
| Time/data | `AgendaRow`, `DayCell`, `EventChip`, `AllDayChip`, `MonthChip`, `NowLine`, `TodayPill`, `WeatherChip` |
| Identity  | `Avatar`, `BrandMark`, `CategoryDot`, `LegendSwatch`                                                  |
| Chat      | `Thread`, `ActivityPeek`, `ChatFreshnessFooter` (from `chat-thread.tsx`)                              |

- Use a component before a raw `jds-*` class. Use a listed option before adding one.
- Missing a variant? Extend the component's union type in `packages/ui/src/`, then run
  `pnpm build:ui-catalogue`.
- Missing a primitive? Add it to `packages/ui/src/` and `packages/ui/src/styles/`, never to the
  calling screen.

## Empty and loading states

- Don't render a section that has nothing useful to say (no "No plan yet" panels).
- Inline, inside a section: one quiet sentence, `role="status"`. Today uses `.cmd-empty` and
  `.agenda-clear` ("Gathering your morning briefing...").
- Whole page or panel: `<EmptyState>` (`.jds-empty`) with title, optional description and action.
- No fake counts, no generic placeholder cards, no spinners in the middle of a page.
- Copy is sentence case and reads like the product talking, not documentation. Don't repeat the
  section name already on screen.

## Modules

| Module kind                           | Rule                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| First-party (everything in this repo) | Use shared primitives and tokens fully, so every theme works. Module CSS does layout only |
| Third-party (installed)               | May style however it likes                                                                |

- News and Sports styling (`packages/news/src/web/styles/`, `packages/sports/src/web/styles/`,
  `components-news.css`, `components-sports-*.css`) is known debt, not precedent. Both will be
  redesigned to match Today.
- A new module needs agreed mockups naming the primitives each screen uses before it is built.
  See `docs/DEVELOPMENT_STANDARDS.md`.

## Don'ts

- No curved accent left border on cards or panels. Straight markers that carry meaning (task
  priority, calendar event colour, the row hover marker) are fine.
- No monospace outside real code.
- No serif.
- First-party code: no raw colours (hex, `rgb()`, `rgba()`) outside `tokens.css`.
- No invented `jds-*` classes. An undefined class renders as nothing, silently.
- No unstyled shadcn, Radix or Tailwind-default primitives.
- No soft drop shadows to separate flat surfaces.
- No angled stripe or hatch textures, literal park illustrations, landscapes, seals or mascots.
- No lucide `Sparkles` icon (lint-enforced).

## Checks

| Command                        | Catches                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| `pnpm check:design-tokens`     | Colour literals outside `tokens.css`; `var(--x)` with no definition         |
| `pnpm check:ui-classes`        | `jds-*` classes used in TSX but defined nowhere                             |
| `pnpm check:ui-catalogue`      | Stale `OPTIONS.md` / `catalogue.json`                                       |
| `pnpm check:migrated-sections` | Raw `jds-*` classes in migrated screens where a `@moss/ui` component exists |
