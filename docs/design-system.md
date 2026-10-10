# Moss design system

The one reference for how Moss looks. Park Press direction, finished 2026-09-05. **Today is the
standard** (Ben, 2026-10-02): when this file and the Today screen disagree, Today wins and this
file gets fixed, except where Today breaks a standing rule or carries a known defect (see
[Known Today defects](#known-today-defects)). Tokens live in `apps/web/src/styles/tokens.css` and
shared primitives in `packages/ui/src/styles/`.

Reconciled 2026-10-10 against main `bc9e76d` and the current shared component implementation.
Historical specs remain dated design records; current source and verified behavior determine the
contracts below. Fixture checks are visual evidence, never live acceptance.

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
- **Floor: 11px (`--text-2xs`).** Nothing smaller, at any width, phone breakpoints included
  (#2918).
- Weights: `--weight-regular` 400 through `--weight-black` 900 (`medium`, `semibold`, `strong`
  650, `bold`, `heavy` 800).
- Leading: `--leading-none|tight|snug|normal|relaxed`. Tracking: `--tracking-tight|snug|normal|wide|caps`.
- Prose measure: `--measure` (66ch) or `--measure-narrow` (48ch). Only real prose gets a measure.

### Type roles

Today's reference sizes, with the token new code uses. Some editorial geometry intentionally
retains existing values; do not snap it to a different size during an accessibility repair.

| Role                          | Face, weight    | Token                               | Today ships                |
| ----------------------------- | --------------- | ----------------------------------- | -------------------------- |
| Hero headline                 | Display, 900    | `--text-3xl` to `--text-5xl`, 3.1vw | `clamp(30px, 3.1vw, 47px)` |
| Big number (next meeting)     | Display, 900    | `--text-4xl`                        | 39px                       |
| Section title (numbered head) | Display, 900    | `--text-2xl`                        | 25px                       |
| Desk title (numbered head)    | Display, 900    | `--text-2xl`                        | 25px                       |
| Lead story title (desks)      | Sans, 700       | `--text-3xl`                        | 29px, 27px below 1080px    |
| Rail item title               | Sans, 700       | `--text-xl`                         | 21px                       |
| Evening recap introduction    | Sans, 400       | `--text-lg`, leading 1.65           | 17px, 15px on phones       |
| Hero summary, lead body       | Sans, 400       | `--text-sm`, leading 1.6-1.65       | 14px                       |
| Notes, secondary body, links  | Sans, 400-600   | `--text-xs`, leading 1.6-1.65       | 12px                       |
| Meta, datelines, legends      | Sans, 400       | `--text-2xs`                        | 11px shared floor          |
| Eyebrow                       | Sans, 700, caps | `--text-2xs`, `--tracking-caps`     | 11px shared eyebrow        |
| Section number                | Sans, 700       | `--text-2xs`                        | 11px shared floor          |

- Display titles track tight: about -0.03em (Today: -1.5px on the hero, -0.7px at 25px).
- Ordinary body copy is dense: 12-14px. The one larger paragraph is the evening recap
  introduction, a short lede that opens the recap.
- Eyebrows: sans, `--text-2xs`, bold, `--tracking-caps`, uppercase, in `--accent-fg` on paper and
  `--hero-fg` on the hero (see the hero contrast rule under Colour).

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
| Today hero band      | Ground `--accent` (ships as `--forest`), `--hero-fg`, `--hero-fg-muted`, `--gold`    |
| Note fills           | `--sage-light` (plan and practical notes), `--forest-soft`                           |
| Dark "next up" block | `--rail-bg`, `--rail-fg`, `--rail-fg-muted`, `--rail-marker`. Not used on Today      |
| Hover                | `--hover-tint`, `--hover-raise`, `--surface-hover`                                   |
| Focus                | `--focus-ring`                                                                       |

- Use semantic aliases (`--text`, `--accent`, `--border`) over primitives (`--ink`, `--forest`,
  `--line`) where one exists. Today often reaches for primitives; follow its roles, not its names.
- Accent-coloured text is `--accent-fg`, never raw `--forest`. Dark mode keeps `--forest`
  unchanged, so forest text on charcoal reads at 1.8:1 (#2914).
- Gold is never semantic. Caution is amber; error is red.
- Plain `--gold` is for rules and marks only. Gold text uses `--gold-strong` (large) or
  `--gold-ink` (small); plain gold text fails contrast (#2914).
- Hero text: small text on the accent band uses `--hero-fg`. Public `Eyebrow tone="hero"`
  uses that role, not `--hero-fg-muted`, whose blend is against the darker `--hero-bg`.
  The current Today-specific sage override passes the named-theme matrix; retain the measured
  treatment rather than treating an old warning as a current failure.
- Shared muted Eyebrow, plain Masthead lede/dateline, AgendaRow metadata and instrument labels
  use `--text-faint`, tested on paper, surface and surface-2 in all ten named combinations.
  Light surface-3 is not a general muted-text ground; use normal text or verify a specific pair.
  Decorative `--ink-3`/`--ink-4` are not text contracts and are unchanged.
- `--focus-ring` is opaque `--accent-fg`, tested at 3:1 on the four neutral grounds. Field
  Masthead scopes it to `--masthead-fg`. Other reversed bands must supply their matching
  foreground. Custom themes remain user-controlled and require checks on their actual grounds.
- Wellness category/medication ramps are shared `--wellness-*` tokens. The six emotion names,
  seven medication hues and light/dark ramp meanings are preserved. Use `-ink` on `-soft/-soft2`
  and `-on-tint` on `-tint`; do not substitute white labels on the medium light-mode tint.
- Every text colour clears 4.5:1 (3:1 for large text) on every surface it sits on, not only on
  the page colour. Check `--text-faint` and destructive fills in dark mode (#2914).
- `--forest-*` is the accent slot. Themes re-point it, so "forest" means "the current accent".

## Themes

| Theme                    | How it is set                                                   |
| ------------------------ | --------------------------------------------------------------- |
| Default (forest)         | `:root`                                                         |
| Sage, Canyon, Teal, Dusk | `[data-theme="<name>"]`, re-points the accent ramp              |
| Dark (warm charcoal)     | `[data-color-mode="dark"]`, combinable with any park theme      |
| Custom                   | Runtime: paper, surface, ink, line, accent; accent ramp derived |

- Red, amber and steel stay locked in every theme.
- Tokens follow theme selection; they do not prove readable contrast on every ground. Custom
  palette warnings must describe the actual component pairs and never claim universal compliance.
- Check new UI in light, dark and at least one park theme.

## Spacing, radius, elevation

- Space: `--space-1` 4px, `-2` 8, `-3` 12, `-4` 16, `-5` 20, `-6` 24, `-7` 32, `-8` 40,
  `-9` 48, `-10` 64, `-11` 80, `-12` 96 (`-0-5` 2px, `-14` 128).
- Minimum gaps between neighbours. Nothing touches or crowds the next element, at any width:

  | Neighbours                                                        | Minimum gap               |
  | ----------------------------------------------------------------- | ------------------------- |
  | Lines inside one text block (eyebrow over title, title over meta) | `--space-1` 4px           |
  | Icon and its label; label and its control                         | `--space-2` 8px           |
  | Button, link or chip beside another, including wrapped rows       | `--space-2` 8px both ways |
  | Button or control and the text block above or below it            | `--space-3` 12px          |
  | Separate blocks inside a section                                  | `--space-5` 20px          |
  | Sections                                                          | `--space-7` 32px          |

  Set the gap on the parent (`gap`) so wrapping rows keep it. Check desktop and phone width.

- Radius: `--radius-xs` 4, `-sm` 6, `-md` 8, `-lg` 10, `--radius-card` 12, `-xl` 16,
  `-2xl` 22, `-pill`.
- Surfaces separate by hairline rules, not shadow. `--shadow-xs` and `--shadow-sm` are keyline
  rings; `--shadow-md|lg|xl`, `--shadow-pop`, `--shadow-drawer` are for things that float
  (dialogs, menus, drawers).
- Motion: `--dur-*`, `--ease-*`, `--transition-control`. Reduced motion is handled in `tokens.css`.

## Page width

- Use the horizontal space (Ben, reaffirmed 2026-08-19). Working screens run wide.
- Today: hero spans the whole content region, 16px in from each side (6px on phones). Body `.cmd-wrap` max
  1220px. Workshop: `.workshop-page` max 1220px. `--container` 1240px.
- Sidebar: pale, `--nav-w` 194px (168px at 1180px and below), collapsible to an icon rail.
- Phone: chat stays a drawer over the page.

## Page anatomy (Today is the standard)

| Part                  | Shipped as                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Today hero            | `.today-hero` (`kit-today-hero.css`): accent band inset 16px (6px on phones), 3px gold bottom rule and a static topographic contour overlay. Eyebrow, display headline, summary, a hairline, weather row, then underlined links and the prepared time on one row. Only the fallback headline splits into a muted second line; saved morning and evening reports show one plain headline, and a new headline need not split |
| Section index         | `.today-hero__sections`: a hairline-ruled row of in-page links under the hero, 11px accent text                                                                                                                                                                                                                                                                                                                            |
| Main grid             | `.cmd-grid`: content column plus 270px rail, 34px gap, ordinary `--border` keyline on the rail's left edge. Quick actions top the rail; the day plan spans both rows. Desks and widgets run full width below. One column at 1080px and below                                                                                                                                                                               |
| Section               | `.jds-brief`: hairline top rule (`--border`), `--space-5` vertical padding, no card                                                                                                                                                                                                                                                                                                                                        |
| Section head          | Numbered head: section number (accent, bold, 2px gold underline), display title, meta right-aligned. Day plan (`.tl-head`), desks (`.desk-head`), evening (`.ev-head`). Shared `SectionHead`, see below                                                                                                                                                                                                                    |
| Desk head             | Numbered head with no rule beneath it. The desk section carries a 1px `--accent-rule` rule above instead                                                                                                                                                                                                                                                                                                                   |
| Block head            | Smaller blocks inside a section (Start here, Overnight, Focus, Needs you): `.jds-brief__head` + `.jds-brief__kicker` (eyebrow) + `.jds-brief__title`                                                                                                                                                                                                                                                                       |
| Rail block            | Flat, no card. Eyebrow plus a small accent title over a 2px `--accent-rule` underline, rows split by hairlines (`.well` inside `.cmd-aside`)                                                                                                                                                                                                                                                                               |
| Next up               | Flat rail block: eyebrow, big display time in accent, sans title, muted note, underlined link, hairline beneath. Not the dark `--rail-*` block                                                                                                                                                                                                                                                                             |
| Notes                 | Three shared `Note` variants; see below                                                                                                                                                                                                                                                                                                                                                                                    |
| Links                 | Action links (open the briefing, meeting actions, hero links): `--accent-fg`, underlined, 4px offset, weight 600; `--hero-fg` on the hero. Section index links: accent, no underline at rest, underline on hover. Story headline links: normal ink, no accent. The news reading action still ships a 3px offset; new action links use 4px                                                                                  |
| Rows                  | `<RowIndex>` (`.jds-index`): one bottom hairline per row (no implicit top rule), meta right-aligned; hover is a straight inset gold marker plus accent title, never a filled block                                                                                                                                                                                                                                         |
| Cards                 | `<Card>` (`.jds-card`): `--surface`, `--border`, `--radius-card`. For contained widgets in dialogs and settings. Today's sections and rail are not boxed                                                                                                                                                                                                                                                                   |
| Hairlines             | `<Divider>` (`.jds-divider`, `--strong`, `--ink`, `--vertical`), `.jds-section-head__rule`                                                                                                                                                                                                                                                                                                                                 |
| Eyebrows              | `.jds-eyebrow` (`--gold`, `--muted`, `--accent` tones), `.jds-masthead__eyebrow`                                                                                                                                                                                                                                                                                                                                           |
| Small text            | `.jds-caption`, `.jds-label`                                                                                                                                                                                                                                                                                                                                                                                               |
| Section-home masthead | Other sections' homes: `<Masthead tone="field">` (`.jds-masthead--field`), forest band, 4px gold bottom rule, eyebrow, Archivo title, optional lede and aside. Action button `<Button variant="field">`                                                                                                                                                                                                                    |
| Plain masthead        | `<Masthead>`: ink on paper, with `MastheadDateline` and `MastheadClock`                                                                                                                                                                                                                                                                                                                                                    |
| Footers               | No shared section footer. Dialogs use `.jds-dialog__foot`; the briefing reader uses `.brief-reader__footer-*`                                                                                                                                                                                                                                                                                                              |
| Paper grain           | `body::after` in `texture.css`; static, `--texture-opacity`                                                                                                                                                                                                                                                                                                                                                                |

Workshop project screen: chat fixed to the viewport, only the thread scrolls, composer pinned at
the bottom; an artifact panel beside it whose tabs appear only once they have content.

### Notes

| Kind           | Look                                                                                                | Today example                            |
| -------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Plan note      | `--sage-light` band, hairline top, `--text-xs` accent text (ships at 11px), one line plus an action | Under "Your day, laid out"               |
| Pull note      | Straight 2px gold left rule, eyebrow, `--text-xs` muted text, about 290px wide                      | "Your news, in context" in the news desk |
| Practical note | `--sage-light` fill, straight 2px gold left rule, `--text-xs` text in `--accent-fg`                 | "A little practical context" in the rail |

### Today's shared pieces (#2918)

Today invented these locally; they now live in `@moss/ui` and Today uses them. A new screen that
needs one uses the shared piece and never copies Today's local rules. Screens own width and margins
only. All text sits at or above the 11px floor.

| Pattern                | Shared piece                                                                                                                                | Replaces                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Numbered section head  | `<SectionHead number title meta rule align>`, `.jds-section-head`                                                                           | `.tl-head`, `.desk-head`, `.ev-head`                                                                                                                |
| Eyebrow                | `<Eyebrow tone>` (`subtle`, `gold`, `muted`, `accent`, `hero`), bold, 11px                                                                  | `.today-hero__eyebrow`, `.well__eyebrow`, `.nw-twnote__eyebrow`, `.ev-tomorrow__eyebrow`                                                            |
| Notes                  | `<Note variant>` (`plan`, `pull`, `practical`), `.jds-note--*`                                                                              | `.tl-note`, `.nw-twnote`, `.cmd-practical`                                                                                                          |
| Text-link buttons      | `<Button variant="link">` (retint with `--btn-link-color`)                                                                                  | `.today-hero__link`, `.cmd-next__link`                                                                                                              |
| Clickable row          | `<RowButton className>`, `.jds-rowbtn` (strips the native button look; the screen sets spacing and hover)                                   | `.jds-task__main`, `.loose-row__main`, `.ev-done__main`, `.ev-loop__open`, `.ev-tomorrow__item`, `.brief-snapshot__main`, `.plan-review__titlelink` |
| Expand/collapse toggle | `<DisclosureToggle expanded controls className>`, `.jds-disclosure` (sets `aria-expanded` and `aria-controls`; the screen draws the marker) | `.brief-reader__schedule-toggle`, `.brief-reader__callout-disclosure`                                                                               |

### Hand-built Today buttons (#2918)

Moved onto shared pieces: the hero, meeting and evening-plan text links, Check in, Done, the
evening choice buttons (`chip` look), Plan tomorrow, Chat, the briefing Accept, Dismiss, Reply,
Close and report-picker buttons, Undo and Retry (`link` look), and the medication plus, nudge
dismiss and medications dialog close (`IconButton`, retinted with `--iconbtn-*` variables).

Left as they are:

- Briefing tabs (`brief-reader__tab`). They are true tabs with tab roles, arrow-key movement and
  a panel link, so the shared `Segmented` control would change their look and keyboard behaviour.

Clickable rows and expand/collapse controls now use `RowButton` and `DisclosureToggle`.
The old missing-primitive list tracked closed work; do not create replacements. `DisclosureToggle`
reserves `::after` for its phone hit target, so a visual chevron is an aria-hidden child.

### Known Today defects

Current screen owners must verify wrapped link-row spacing and control behavior at phone widths.
Older warnings about raw-forest notes and absent texture do not describe the current shared
implementation. Today's sage secondary hero text currently clears 4.5:1 in the named themes,
including Teal; its portability to custom palettes remains a separate check.

## Primitives

Import from `@moss/ui`. Full option list in `packages/ui/OPTIONS.md`.

| Group     | Components                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------- |
| Actions   | `Button`, `ButtonLink`, `IconButton`, `RowButton`, `DisclosureToggle`, `Menu`, `Segmented`, `Switch`  |
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

## Interaction contracts

- `Dialog` remains inline so footer submit buttons keep their enclosing form. It generates title
  and description ids; an explicit `aria-labelledby` remains supported. Mount it only when open.
  Initial focus stays on an already-focused child, otherwise uses `initialFocusRef`, otherwise
  the dialog surface. Never choose the first destructive button automatically.
- Modal dialogs contain Tab/focus, isolate sibling subtrees with native `inert` and `aria-hidden`,
  lock body scroll, handle Escape and restore a surviving opener. Nested dialogs own their own
  Escape/isolation; cleanup restores previous attributes and scroll state. Newly inserted sibling
  nodes are isolated by a child-list observer. Supported browsers must implement native `inert`.
- Optional `closeLabel` adds a shared, named close button; `closeDisabled` marks pending state.
- `dismissOnEscape` and `dismissOnBackdrop` default true. Pending callers can disable them while
  also guarding their onClose action. `returnFocusRef` supplies an explicit surviving opener.
  A replacement dialog keeps its newly established focus instead of being overwritten by cleanup.
- `PeekPanel` is explicitly nonmodal by default. `modal={true}` requires `onClose`, owns the
  `.cal-peek-scrim` and uses the same lifecycle. Give it `aria-label` or `aria-labelledby`.
- Responsive hosts may use `useDialogLifecycle({ref, enabled, modal, onClose, initialFocusRef,
returnFocusRef, dismissOnEscape, backdropRef})`; attach its returned onKeyDown to the focusable
  surface. A backdrop exception must be an aria-hidden, noninteractive scrim, not a content wrapper.
- `Menu` focuses an enabled item on open, supports Arrow Up/Down, Home/End, Escape and native Tab
  departure. Trigger Enter/Space retain native activation. `triggerContent`, `triggerVariant="content"`
  and `placement="top"` support the account menu without a second keyboard implementation.
- Settings `Switch`, `Segmented`, `Avatar` and `Indicator` re-export canonical components. The
  compatibility Badge translates `pine` to `forest`. Settings `Field` accepts `controlId`, `hintId`,
  `errorId`, and `error`; the consumer supplies matching control id/aria-describedby/aria-invalid.
  Field wrappers are neutral by default so an independently labeled control has one label target.
  Use `group` explicitly for multiple independently labeled controls without `controlId`; arbitrary
  children are never automatically relabeled or cloned.
- Shared SectionHead keeps its 25px reference geometry and explicit bold weight; Today retains
  its heavier local heading treatment. RowIndex supplies bottom rules, not a top rule.

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

- A module's settings are reached by the cog icon in the page header, which the shell draws next to
  the module title when the module declares a settings page. A module never adds its own text
  Settings link.
- News and Sports styling (`packages/news/src/web/styles/`, `packages/sports/src/web/styles/`,
  `components-news.css`, `components-sports-*.css`) is known debt, not precedent. Both will be
  redesigned to match Today.
- A new module needs agreed mockups naming the primitives each screen uses before it is built.
  See `docs/DEVELOPMENT_STANDARDS.md`.

## Don'ts

- No curved accent left border on cards or panels. Straight markers are fine: ones that carry
  meaning (task priority, calendar event colour, the row hover marker) and the 2px gold rule on
  pull and practical notes.
- No text below 11px.
- No text colour under 4.5:1 (3:1 for large text) on any surface it sits on, in any theme or mode.
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
| `pnpm check:design-tokens`     | App and shared-UI colour literals; undefined `var(--x)` references          |
| `pnpm check:ui-classes`        | `jds-*` classes used in TSX but defined nowhere                             |
| `pnpm check:ui-catalogue`      | Stale `OPTIONS.md` / `catalogue.json`                                       |
| `pnpm check:migrated-sections` | Raw `jds-*` classes in migrated screens where a `@moss/ui` component exists |
