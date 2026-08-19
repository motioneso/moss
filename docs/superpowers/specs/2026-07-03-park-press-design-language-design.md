# Park Press — Design Language Extraction (Round 1)

**Status:** Approved design (brainstorm complete) — pending implementation plan
**Date:** 2026-07-03
**Author:** Ben + Claude (design-language exploration)
**Supersedes:** the "serif headings / muted-pine / soft-shadow" authored look for the core web shell.

---

## Problem

Jarvis's current UI works and passes finish/consistency audits, but the _look_ reads as
timid — "too sterile, too AI-designed." The cause is not the architecture; the token layer
already describes itself as _"a near-monochrome editorial canvas (warm newsprint paper + ink)
with one living accent."_ The timidness is in the **values**: near-white paper, a muted pine
accent, soft 3–6% drop shadows, quiet serif headings, and no texture.

This spec extracts the **"Park Press"** design language — validated over an extended
artifact-mockup exploration — into the real platform by **re-tuning the existing token layer up**
(warmer, bolder, committed) and adding the two capabilities it lacks (paper texture, a hero type
treatment). It is a design-language change, not a new feature or component set.

### Design DNA (target)

Warm oat grounds (never sterile white); a confident national-park palette (forest primary + gold
companion, with sage/canyon/teal/dusk as theme accents); bold Swiss display type used big as the
hero; subtle riso/letterpress paper tooth; thin keyline grids; committed color _fields_ rather than
timid dabs.

---

## Scope (Round 1)

**Global, via `tokens.css` (auto-reskins the whole app):**
warm oat paper, forest + gold accents, hairline rules replacing default soft shadows, Neue Haas
Grotesk type, riso texture overlay.

**Hand-polished this round:**

- The **app shell** (nav rail → committed forest field, topbar).
- The **Today** landing screen (flagship proof).

**Inherits the token flip only (hand-polish deferred to follow-up specs):**
Tasks, Calendar, Notes, Chat, Wellness, Settings.

### Non-goals

- No Sports broadsheet skin — that is a separate, later spec.
- No hand-polish of the non-flagship screens beyond what the token flip gives them.
- No new components, features, or data changes.
- No serif reading face — deferred with the Sports work.

---

## Decisions

### 1. Color & the token re-tune

| Concern         | Now (timid)                | Park Press                            |
| --------------- | -------------------------- | ------------------------------------- |
| `--paper`       | `#fbfaf6` near-white       | warm **oat** `~#ece4d1`               |
| primary accent  | muted pine `#2f6a4c`       | confident **forest** `#294b39`        |
| shadows         | soft 3–6% blurs everywhere | hairline **rules** + committed fields |
| decorative gold | _(none)_                   | new **`--gold`** `~#c2872b` co-accent |

- **Gold is a new token, distinct from `--amber`.** `--amber` remains semantically locked to
  meaning (caution / drift / recovery — anti-shame, never decorative, never error-red). Park Press
  gold is _decorative_ (straps, labels, active markers, spines). They must not be conflated. The
  signature pairing is **forest + gold**.
- **Semantic colors stay locked.** Red = true error/destructive; amber = caution/drift; steel =
  quiet info. Values may warm a hair to sit correctly on oat, but their _meaning_ is unchanged.
- **Shadows are demoted, not deleted.** Flat surfaces (cards, panels, list rows) separate via
  `--line-strong` hairline rules + oat/surface color fields. Shadow tokens are retained **only for
  genuine elevation**: drawers, modals, popovers, the command palette. Soft-shadow-as-default-
  decoration is the single biggest "AI-designed" tell and is removed.

**Token structure — Approach B (rename primitives, keep the alias layer stable):**
Introduce `--forest`, `--gold`, `--oat` (and warm-neutral) primitives; point the existing
semantic alias layer (`--accent`, `--paper`, `--bg`, …) at them; retire `--pine`. Because the
alias layer is the seam every kit stylesheet consumes, **no component CSS changes** — only the
primitive block moves. Honest names, contained diff.

`tokens.css` remains the **only** file in `apps/web` permitted to contain hex/rgb literals.

### 2. Typography — "type as hero"

This **intentionally overrides** the prior "serif headings" guardrail. Serif headings on a warm
ground are the current default "tasteful AI" tell; retiring them is the core of the shift. (Per
Ben: the old design guardrails are void for this work.)

| Role              | Now                   | Park Press                                                                      |
| ----------------- | --------------------- | ------------------------------------------------------------------------------- |
| Headings          | _serif_ (Newsreader)  | **Neue Haas Grotesk Display** — black/800, big, caps for labels, tight tracking |
| Eyebrows / labels | mono (IBM Plex Mono)  | mono (IBM Plex Mono) — **keep**                                                 |
| Body / UI         | sans (Hanken Grotesk) | **Neue Haas Grotesk Text** — upgrade, still sans                                |

- Newsreader **retires from the core language** (may return later as a Sports reading face).
- "Hero" is treatment, not just face: Today's header and section heads are set assertively at the
  top of the existing scale (`--text-4xl/5xl/6xl`), Neue Haas Display, some in caps with
  `--tracking-caps`, tight leading. Type carries the page so decoration can recede.
- **Self-hosted woff2** (Display + Text cuts). Ben supplies the licensed font files. IBM Plex Mono
  stays for the data/mono role.

### 3. Surface treatment

1. **Riso tooth (global).** One inline SVG `feTurbulence` noise overlay over the oat ground:
   opacity `~0.04`, `mix-blend-mode: multiply`, **static** (no animation → cheap, reduced-motion
   is a non-issue). Single fixed element at the app root, behind content. Dark theme runs it lower
   (`~0.03`) / screen-blended so charcoal stays clean.
2. **Keyline grid.** `--line-strong` hairline rules become _the_ region-separation system: nav
   from content, section from section, row from row. Cards become bounded oat/surface fields, not
   floating white rectangles.
3. **Committed color fields.** The signature move: the **app nav rail becomes a full forest
   field** (committed forest ground, cream text, gold active marker) — the reversed rail from the
   validated mockups. Section grounds and accent blocks follow the same "commit the color" rule.

### 4. Theming

Five national-park themes on the **existing theme runtime** (no new machinery for built-ins):

`Forest #294b39` (default) · `Sage #4a5d3a` · `Canyon #8a4b2b` · `Teal #2f6d6a` · `Dusk #4b4a63`

- Each built-in theme **swaps the primary accent only**; oat paper, gold, and texture are global
  and shared. Forest replaces pine as the default.
- **Gold behavior:** **constant** for the five system themes (one gold tuned to sit on oat under
  any accent). **Configurable for user/custom themes** — add `--gold` as a 6th overridable
  aesthetic slot in the custom-theme editor, with contrast validation. Built-ins hardcode the
  constant gold, so the runtime change is contained to the custom-theme path.
- **Dark theme:** keep the existing warm charcoal (already on-taste); carry forest + gold accents
  in; texture ~0.03. Both themes must clear WCAG AA; semantic red/amber/steel remain locked.

### 5. Verification & handoff

- **Browser layout:** focused DOM/computed-style assertions across both themes; confirm a11y
  contrast holds; `pnpm verify:foundation` green. Ben's eye is final sign-off.
- **Claude Design handoff:** this spec is the source of truth. It is fed to the `Jarvis Design
System` Claude Design project to author the component gallery. **`tokens.css` remains runtime
  truth; the gallery mirrors it.** The gallery is never a ship gate. Author the Park Press palette
  once; keep the two deliberately in sync.

---

## Risks

- **Contrast.** Oat is darker than near-white, so some AA values shift. Re-run the ink ramp and
  accent-on-paper contrast checks for both themes; adjust `--text-subtle`/`--text-faint` and
  accent-on-paper as needed.
- **Auto-reskin surprises.** A few components hardcode assumptions and will look off under the
  flip. Expected — browser assertions surface them; log for follow-up specs, don't chase all now.
- **File-size gate.** 1000-line CSS cap per file. `tokens.css` is at ~343; room to grow, but watch
  it as primitives/aliases expand.
- **Font blocker.** The Neue Haas woff2 files gate the type step. Everything else can proceed
  without them.
- **Shared working tree.** Another session may be mid-build. Do not disturb its worktree; ground
  and implement cleanly, stage only this work's files.

---

## Deliverables

1. Re-tuned `apps/web/src/styles/tokens.css` — Approach B primitives, oat/forest/gold, demoted
   shadows, Neue Haas type roles.
2. Self-hosted Neue Haas Grotesk (Display + Text) woff2 + `@font-face` wiring (replaces the Google
   Fonts `@import` for the sans/display roles).
3. Riso texture overlay at the app root.
4. App shell polish — committed forest nav field + topbar.
5. Today screen polish — hero type, keyline grid, committed fields.
6. Five national-park built-in themes; Forest as default; `--gold` slot added to the custom-theme
   editor.
7. Focused browser assertions pass (both themes) + `verify:foundation` green.
8. Park Press palette authored into the `Jarvis Design System` Claude Design project.

---

## Open items (not blockers)

- Exact final hex values for oat, forest, gold, and the warm-neutral ramp are tuned during
  implementation against live contrast checks; the values above are the validated starting points.
- Confirm where Newsreader is currently consumed before retiring it (verify no reading surface
  silently depends on it); handle any such surface in the plan.
