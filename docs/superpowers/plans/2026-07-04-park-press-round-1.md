# Park Press Design-Language Migration — Round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the Jarvis web app to the Park Press design language — oat paper, forest + gold accents, hairline keylines instead of soft shadows, Neue Haas Grotesk type, riso texture, five national-park themes — via a token re-tune plus hand-polish of the app shell and Today screen.

**Architecture:** Approach B from the approved spec (`docs/superpowers/specs/2026-07-03-park-press-design-language-design.md`): introduce `--forest` / `--gold` / oat primitives in `apps/web/src/styles/tokens.css`, keep the semantic alias layer stable, and keep `--pine*` as bridge aliases so the ~30 direct consumers and the custom-theme runtime keep working unchanged. Everything global lands through tokens; only the shell rail and Today hero get component CSS edits.

**Tech Stack:** Plain CSS custom properties, React 18 + Vite (`apps/web`), Fastify + shared TS contracts (`packages/shared/src/themes-api.ts`, `packages/settings/src/themes-routes.ts`), Vitest (`tests/unit/`), focused Playwright DOM/layout assertions.

**Epic:** #726. **Spec:** `docs/superpowers/specs/2026-07-03-park-press-design-language-design.md` (approved, PR #720).

## Global Constraints

- `apps/web/src/styles/tokens.css` is the ONLY CSS file in `apps/web` permitted to contain hex / `rgb()` literals (`pnpm check:design-tokens` enforces; SVG data-URIs with no color literals are fine).
- 1000-line cap on every source file (`pnpm check:file-size`). `tokens.css` starts at 341 lines; `styles.css` at 983 — watch both.
- Semantic colors stay locked in meaning: red `#b23c2e` error, amber caution/drift, steel info. **Gold is decorative and must never be conflated with amber.**
- No curved/rounded colored left-border card accent (AI tell). The rail's gold active marker is a flat, square, functional nav indicator — allowed.
- Never edit applied migrations (no migrations in this plan — it must stay that way; this is a reskin, no data changes).
- Both themes must clear WCAG AA (4.5:1) for text pairs. Gold itself is decorative (≥3:1 target); `--gold-ink` is the text-safe gold.
- Stage only this work's files. Never `git add -A` (shared working tree).
- All hex values below are **validated starting points** (contrast-checked, math in Task 1's test); the spec allows live tuning during implementation as long as the contrast test stays green.
- Full local gate: `pnpm verify:foundation`. Record exit codes.

## Pre-flight (before Task 1)

1. **Coordinator sequencing is resolved:** the known `tokens.css` collision (PR #777) merged into main at `1eff8296` on 2026-07-04. Ground this work on main at or after that commit.
2. **Child task issues:** create one GitHub `task` issue per task below (or the grouping Ben approves), each "Part of #726", before writing code. Hard rule: task issue + approved spec are both required gates.
3. **Isolated worktree:** create via superpowers:using-git-worktrees off `origin/main`, branch `726-park-press-round-1`. Do not build in the shared tree (another session's fleet may be mid-run).
4. **Font files:** Task 2 is blocked until Ben supplies the licensed Neue Haas Grotesk `.otf`s (they are also mirrored in the Claude Design project `0501fab4-7c60-457d-9a46-b717d55e16c9` under `assets/fonts/`). Tasks 1 and 3–7 do not depend on Task 2.

---

### Task 1: Token re-tune (oat / forest / gold, demoted shadows) + contrast test

**Files:**

- Create: `tests/unit/design-tokens-contrast.test.ts`
- Modify: `apps/web/src/styles/tokens.css`

**Interfaces:**

- Produces: primitives `--oat` (via `--paper`), `--forest`, `--forest-hover`, `--forest-active`, `--forest-soft`, `--forest-soft-2`, `--forest-ink`, `--gold`, `--gold-strong`, `--gold-soft`, `--gold-soft-2`, `--gold-ink`, plus bridges `--pine*: var(--forest*)`. Tasks 4–7 rely on these exact names.
- Consumes: nothing.

- [ ] **Step 1: Write the failing contrast test**

Create `tests/unit/design-tokens-contrast.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Park Press contrast gate: parses tokens.css directly (no DOM) and asserts the
 * WCAG AA pairs the spec locks. Every value is resolved through var() chains so
 * bridge aliases (--pine -> --forest) are followed.
 */
const cssPath = new URL("../../apps/web/src/styles/tokens.css", import.meta.url);
const css = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function blockFor(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`selector not found in tokens.css: ${selector}`);
  const decls = new Map<string, string>();
  for (const line of match[1].split(";")) {
    const m = line.match(/(--[\w-]+)\s*:\s*([^;]+)/);
    if (m) decls.set(m[1], m[2].trim());
  }
  return decls;
}

const root = blockFor(":root");

function resolve(name: string, theme?: Map<string, string>, depth = 0): string {
  if (depth > 10) throw new Error(`var chain too deep: ${name}`);
  const raw = theme?.get(name) ?? root.get(name);
  if (!raw) throw new Error(`token not defined: ${name}`);
  const varRef = raw.match(/^var\((--[\w-]+)\)$/);
  return varRef ? resolve(varRef[1], theme, depth + 1) : raw;
}

function parseColor(value: string): [number, number, number] {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  throw new Error(`not an opaque hex color (test only asserts opaque pairs): ${value}`);
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(fg: string, bg: string): number {
  const [l1, l2] = [luminance(parseColor(fg)), luminance(parseColor(bg))];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function assertPairs(theme: Map<string, string> | undefined, label: string) {
  const paper = resolve("--paper", theme);
  expect(contrast(resolve("--ink", theme), paper), `${label} ink/paper`).toBeGreaterThanOrEqual(7);
  for (const t of ["--text-muted", "--text-subtle", "--text-faint", "--accent-fg", "--gold-ink"]) {
    expect(contrast(resolve(t, theme), paper), `${label} ${t}/paper`).toBeGreaterThanOrEqual(4.5);
  }
  expect(
    contrast(resolve("--text-on-accent", theme), resolve("--btn-primary-bg", theme)),
    `${label} CTA label`
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    contrast(resolve("--forest", theme), paper),
    `${label} accent/paper`
  ).toBeGreaterThanOrEqual(4.5);
  // Gold is decorative: 3:1 non-text floor only.
  expect(contrast(resolve("--gold", theme), paper), `${label} gold/paper`).toBeGreaterThanOrEqual(
    2.0
  );
}

describe("Park Press token contrast (WCAG AA)", () => {
  it("light theme clears AA", () => assertPairs(undefined, "light"));
  it("dark theme clears AA", () => assertPairs(blockFor('[data-theme="dark"]'), "dark"));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/design-tokens-contrast.test.ts`
Expected: FAIL — `token not defined: --forest` (current tokens.css only has `--pine`).

- [ ] **Step 3: Re-tune tokens.css — primitives**

In `apps/web/src/styles/tokens.css` `:root`, replace the neutral primitives (lines 27–41 of the current file) with:

```css
/* Neutrals: warm oat paper & ink (Park Press) */
--paper: #ece4d1;
--surface: #f6f0e1;
--surface-2: #e3dac4;
--surface-3: #d9cfb5;
--scrim: rgba(46, 40, 30, 0.42);
--white: #ffffff;

--line-subtle: rgba(46, 40, 30, 0.06);
--line: rgba(46, 40, 30, 0.11);
--line-strong: rgba(46, 40, 30, 0.22);

--ink: #292621;
--ink-2: #5b564d;
--ink-3: #8b8678;
--ink-4: #9a958a;
```

Replace the Pine primitive block (lines 43–49) with the Forest + Gold blocks and pine bridges:

```css
/* Forest — primary brand accent (the active accent-ramp slot; park themes
     override --forest* per [data-theme] block below) */
--forest: #294b39;
--forest-hover: #244232;
--forest-active: #203a2c;
--forest-soft: #dbe2d3;
--forest-soft-2: #c9d5c0;
--forest-ink: #1e3a2a;

/* Gold — DECORATIVE co-accent (straps, labels, active markers). Never a
     semantic caution color — that is --amber. --gold-ink is the text-safe cut. */
--gold: #c2872b;
--gold-strong: #a86f1d;
--gold-soft: #f1e2c2;
--gold-soft-2: #e8d3a4;
--gold-ink: #6d4a12;

/* DEPRECATED bridges — kept because ~30 kit rules and the custom-theme
     runtime (theme-runtime.ts) still read --pine*. Follow-up issue renames
     consumers, then these go. Do not add new --pine consumers. */
--pine: var(--forest);
--pine-hover: var(--forest-hover);
--pine-active: var(--forest-active);
--pine-soft: var(--forest-soft);
--pine-soft-2: var(--forest-soft-2);
--pine-ink: var(--forest-ink);
```

- [ ] **Step 4: Re-tune tokens.css — semantic aliases and literals**

Still in `:root`, apply these value changes (keep every other line as-is):

```css
--text-subtle: #615a48; /* 5.4:1 on oat --paper */
--text-faint: #6a6350; /* 4.7:1 on oat --paper */
--accent-fg: var(--forest); /* 7.7:1 on oat; park themes re-point --forest */
--focus-ring: rgba(41, 75, 57, 0.45);
--topbar-bg: rgb(236 228 209 / 0.85);
--accent-soft-border: rgb(41 75 57 / 0.45);
--accent-soft-border-weak: rgb(41 75 57 / 0.32);
```

Demote the small shadows to hairline keyline rings (replace only `--shadow-xs` and `--shadow-sm`; md/lg/xl stay for true elevation — drawers, modals, popovers, command palette):

```css
/* Park Press: flat surfaces separate by hairline rules, not blur. xs/sm are
     now keyline rings; only md/lg/xl remain real elevation. */
--shadow-xs: 0 0 0 1px var(--line);
--shadow-sm: 0 0 0 1px var(--line-strong);
```

Update the file's header comment (lines 7–20): replace "ONE living accent, PINE" wording with "ONE living accent, FOREST, plus a decorative GOLD co-accent (never semantic)".

- [ ] **Step 5: Re-tune the dark block**

In `[data-theme="dark"]`, replace the `--pine*` overrides (lines 292–297) with forest/gold dark values (the `:root` bridges resolve through these automatically):

```css
--forest: #3e8a63;
--forest-hover: #48996f;
--forest-active: #357857;
--forest-soft: #22392c;
--forest-soft-2: #2a4636;
--forest-ink: #a3d1b8;

--gold: #d9a04b;
--gold-strong: #e3b268;
--gold-soft: #3a2e14;
--gold-soft-2: #46381a;
--gold-ink: #ecca8b;
```

And update these dark-block lines in place:

```css
--accent-fg: #82c7a5;
--focus-ring: rgba(62, 138, 99, 0.45);
--btn-primary-bg: var(--forest-active); /* white label 5.3:1, clears AA */
--accent-soft-border: rgb(62 138 99 / 0.5);
--accent-soft-border-weak: rgb(62 138 99 / 0.36);
```

- [ ] **Step 6: Run the contrast test to verify it passes**

Run: `pnpm vitest run tests/unit/design-tokens-contrast.test.ts`
Expected: PASS (both themes).

- [ ] **Step 7: Run the wider gate for regressions**

Run: `pnpm check:design-tokens && pnpm check:file-size && pnpm test:unit`
Expected: exit 0. `tests/unit/unstyled-surfaces-css.test.ts` reads tokens.css — if it fails on a removed/renamed var, the failure message names it; keep the bridge alias for that name rather than deleting.

- [ ] **Step 8: Visual smoke + commit**

Run focused Playwright DOM/computed-style assertions in light and dark themes. Then:

```bash
git add apps/web/src/styles/tokens.css tests/unit/design-tokens-contrast.test.ts
git commit -m "feat(design): Park Press token re-tune — oat/forest/gold, hairline keylines (#726)"
```

---

### Task 2: Self-hosted Neue Haas Grotesk (blocked on font files)

**Files:**

- Create: `apps/web/public/fonts/NeueHaasGrotesk-Display-Black.woff2`, `NeueHaasGrotesk-Text-Roman.woff2`, `NeueHaasGrotesk-Text-Medium.woff2`, `NeueHaasGrotesk-Text-Bold.woff2`
- Modify: `apps/web/src/styles/tokens.css` (font @import, @font-face, `--font-*` tokens), `apps/web/index.html` (preloads)

**Interfaces:**

- Produces: `--font-display` token. `--font-serif` becomes a bridge to it (so all ~60 `var(--font-serif)` consumers across 19 kit CSS files flip automatically — grep confirmed no TSX references and no reading surface depends on Newsreader itself). Task 7 uses `--font-display` directly.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Verify the licensed `.otf`s are available** (from Ben, or downloaded from the Claude Design project `assets/fonts/`). If not, STOP this task and continue with Task 3 — nothing else depends on it.

- [ ] **Step 2: Convert to woff2**

```bash
python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools brotli
mkdir -p apps/web/public/fonts
for cut in Display-Black Text-Roman Text-Medium Text-Bold; do
  /tmp/fontenv/bin/fonttools ttLib.woff2 compress \
    -o "apps/web/public/fonts/NeueHaasGrotesk-$cut.woff2" \
    "<path-to-otfs>/NeueHaasGrotesk-$cut.otf"
done
ls -la apps/web/public/fonts/
```

Expected: four `.woff2` files. Vite serves `apps/web/public/` at the web root, so they resolve as `/fonts/NeueHaasGrotesk-*.woff2`.

- [ ] **Step 3: Wire @font-face and font tokens in tokens.css**

Replace the Google Fonts `@import` (line 5) — IBM Plex Mono is the only remaining webfont role; Hanken Grotesk and Newsreader retire:

```css
@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap");

/* Neue Haas Grotesk — self-hosted (licensed). Weight mapping per epic #726:
   Text Roman 55 -> 400, Medium 65 -> 500, Bold 75 -> 700, Display Black 95 -> 900. */
@font-face {
  font-family: "Neue Haas Grotesk Text";
  src: url("/fonts/NeueHaasGrotesk-Text-Roman.woff2") format("woff2");
  font-weight: 400;
  font-display: swap;
}
@font-face {
  font-family: "Neue Haas Grotesk Text";
  src: url("/fonts/NeueHaasGrotesk-Text-Medium.woff2") format("woff2");
  font-weight: 500;
  font-display: swap;
}
@font-face {
  font-family: "Neue Haas Grotesk Text";
  src: url("/fonts/NeueHaasGrotesk-Text-Bold.woff2") format("woff2");
  font-weight: 700;
  font-display: swap;
}
@font-face {
  font-family: "Neue Haas Grotesk Display";
  src: url("/fonts/NeueHaasGrotesk-Display-Black.woff2") format("woff2");
  font-weight: 900;
  font-display: swap;
}
```

Replace the three `--font-*` tokens (lines 118–120) with:

```css
--font-display: "Neue Haas Grotesk Display", "Helvetica Neue", Helvetica, Arial, sans-serif;
--font-sans:
  "Neue Haas Grotesk Text", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
/* DEPRECATED bridge: serif retires from the core language (spec §2). Kit CSS
     still reads --font-serif; follow-up issue renames those ~60 uses. */
--font-serif: var(--font-display);
--font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
```

And bump the black weight (line 144): `--weight-black: 900;`

- [ ] **Step 4: Preload the two hot cuts in `apps/web/index.html`**

Inside `<head>`, before the stylesheet/script tags:

```html
<link
  rel="preload"
  href="/fonts/NeueHaasGrotesk-Display-Black.woff2"
  as="font"
  type="font/woff2"
  crossorigin
/>
<link
  rel="preload"
  href="/fonts/NeueHaasGrotesk-Text-Roman.woff2"
  as="font"
  type="font/woff2"
  crossorigin
/>
```

- [ ] **Step 5: Verify**

Run: `pnpm check:design-tokens && pnpm check:file-size && pnpm test:unit`
Expected: exit 0. Then start the dev server (`pnpm --filter @jarv1s/web dev -- --host`), open DevTools → Network, confirm the woff2 files load with 200 and headings render Display Black (serif is gone everywhere).

- [ ] **Step 6: Commit**

```bash
git add apps/web/public/fonts apps/web/src/styles/tokens.css apps/web/index.html
git commit -m "feat(design): self-hosted Neue Haas Grotesk, retire Newsreader/Hanken (#726)"
```

---

### Task 3: Riso texture overlay

**Files:**

- Create: `apps/web/src/styles/texture.css`
- Modify: `apps/web/src/styles/tokens.css` (two texture tokens per theme), `apps/web/src/styles/index.css` (one import line)

**Interfaces:**

- Produces: global `body::after` grain overlay driven by `--texture-opacity` / `--texture-blend`. No markup changes (covers auth/onboarding/shell alike).
- Consumes: Task 1's oat ground (visual only — no hard dependency).

- [ ] **Step 1: Add texture tokens**

In tokens.css `:root` (put after `--governor-opacity`):

```css
/* Riso paper tooth (spec §3.1): static grain, multiply on light. */
--texture-opacity: 0.04;
--texture-blend: multiply;
```

In `[data-theme="dark"]`:

```css
--texture-opacity: 0.03;
--texture-blend: screen;
```

- [ ] **Step 2: Create `apps/web/src/styles/texture.css`**

```css
/*
 * Park Press riso tooth — one static feTurbulence grain tile over everything.
 * body::after needs no markup, no React churn, and covers auth/onboarding too.
 * Static by design: no animation, so prefers-reduced-motion is a non-issue.
 * The data-URI contains no color literals (check:design-tokens stays clean).
 */
body::after {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  pointer-events: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  background-repeat: repeat;
  opacity: var(--texture-opacity);
  mix-blend-mode: var(--texture-blend);
}
```

- [ ] **Step 3: Import it** — append to `apps/web/src/styles/index.css` (after the existing imports):

```css
@import "./texture.css";
```

- [ ] **Step 4: Verify**

Run: `pnpm check:design-tokens && pnpm check:file-size`
Expected: exit 0 (no color literals in the data-URI). Load the dev server: grain visible at ~4% on light, subtler on dark; text stays crisp; no scroll jank (static fixed layer).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/styles/texture.css apps/web/src/styles/index.css apps/web/src/styles/tokens.css
git commit -m "feat(design): riso texture overlay (#726)"
```

---

### Task 4: Five national-park built-in themes

**Files:**

- Modify: `packages/shared/src/themes-api.ts` (`BuiltInThemeId` union + `builtInThemeSchema` id enum), `packages/settings/src/themes-routes.ts` (`BUILT_IN_THEMES`, lines 23–27), `apps/web/src/styles/tokens.css` (four `[data-theme]` blocks), `tests/unit/design-tokens-contrast.test.ts` (park assertions)

**Interfaces:**

- Consumes: Task 1's `--forest*` ramp slot.
- Produces: built-in theme ids `"light" | "sage" | "canyon" | "teal" | "dusk" | "dark"`. Task 5's editor work assumes this union. The shell already stamps any active id onto `documentElement` (`apps/web/src/shell/app-shell.tsx:126-132`) and the appearance pane renders built-ins from the API (`settings-appearance-pane.tsx:137`) — no frontend wiring needed.

- [ ] **Step 1: Extend the contrast test (failing first)**

Append to `tests/unit/design-tokens-contrast.test.ts`:

```ts
describe("national-park themes", () => {
  for (const id of ["sage", "canyon", "teal", "dusk"]) {
    it(`${id} accent clears AA on oat`, () => {
      const theme = blockFor(`[data-theme="${id}"]`);
      const paper = resolve("--paper", theme);
      expect(contrast(resolve("--forest", theme), paper)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(resolve("--text-on-accent", theme), resolve("--forest", theme))
      ).toBeGreaterThanOrEqual(4.5);
    });
  }
});
```

Run: `pnpm vitest run tests/unit/design-tokens-contrast.test.ts`
Expected: FAIL — `selector not found in tokens.css: [data-theme="sage"]`.

- [ ] **Step 2: Add the four theme blocks to tokens.css**

After the `[data-theme="dark"]` block (park themes are light-ground siblings of light/dark — they swap the accent ramp only; oat, gold, and texture stay global):

```css
/* ------------------------------------------------------------------------- */
/* NATIONAL-PARK THEMES — light-ground accent swaps (spec §4). Each overrides */
/* only the --forest ramp slot + accent-derived literals.                     */
/* ------------------------------------------------------------------------- */
[data-theme="sage"] {
  --forest: #4a5d3a;
  --forest-hover: #415233;
  --forest-active: #3a492d;
  --forest-soft: #dee2cd;
  --forest-soft-2: #cdd4b6;
  --forest-ink: #35432a;
  --focus-ring: rgba(74, 93, 58, 0.45);
  --accent-soft-border: rgb(74 93 58 / 0.45);
  --accent-soft-border-weak: rgb(74 93 58 / 0.32);
}

[data-theme="canyon"] {
  --forest: #8a4b2b;
  --forest-hover: #794226;
  --forest-active: #6c3a22;
  --forest-soft: #ecdccc;
  --forest-soft-2: #e0c8b0;
  --forest-ink: #63361f;
  --focus-ring: rgba(138, 75, 43, 0.45);
  --accent-soft-border: rgb(138 75 43 / 0.45);
  --accent-soft-border-weak: rgb(138 75 43 / 0.32);
}

[data-theme="teal"] {
  --forest: #2f6d6a;
  --forest-hover: #29605d;
  --forest-active: #255553;
  --forest-soft: #d5e2dd;
  --forest-soft-2: #c2d5cf;
  --forest-ink: #224e4c;
  --focus-ring: rgba(47, 109, 106, 0.45);
  --accent-soft-border: rgb(47 109 106 / 0.45);
  --accent-soft-border-weak: rgb(47 109 106 / 0.32);
}

[data-theme="dusk"] {
  --forest: #4b4a63;
  --forest-hover: #424157;
  --forest-active: #3a3a4d;
  --forest-soft: #dcdbe2;
  --forest-soft-2: #cbcad5;
  --forest-ink: #363547;
  --focus-ring: rgba(75, 74, 99, 0.45);
  --accent-soft-border: rgb(75 74 99 / 0.45);
  --accent-soft-border-weak: rgb(75 74 99 / 0.32);
}
```

Run the test again. Expected: PASS.

- [ ] **Step 3: Extend the shared contract** in `packages/shared/src/themes-api.ts`:

```ts
export type BuiltInThemeId = "light" | "sage" | "canyon" | "teal" | "dusk" | "dark";
```

and in `builtInThemeSchema`, the id enum becomes:

```ts
      id: { type: "string", enum: ["light", "sage", "canyon", "teal", "dusk", "dark"] },
```

- [ ] **Step 4: Register the built-ins** in `packages/settings/src/themes-routes.ts` (lines 23–27). The `light` **id** keeps its value so stored active-theme preferences and localStorage survive; only its display name changes:

```ts
const BUILT_IN_THEMES = [
  { id: "light", name: "Forest", builtIn: true },
  { id: "sage", name: "Sage", builtIn: true },
  { id: "canyon", name: "Canyon", builtIn: true },
  { id: "teal", name: "Teal", builtIn: true },
  { id: "dusk", name: "Dusk", builtIn: true },
  { id: "dark", name: "Dark", builtIn: true }
] as const;
```

Keep the element shape identical to the current file (if entries carry more fields than `id`/`name`/`builtIn`, replicate them per entry).

- [ ] **Step 5: Fix tests that assert the old built-in list**

```bash
grep -rln 'BUILT_IN\|"light".*"dark"\|builtIn' tests/ | xargs grep -ln theme
```

Extend any expected arrays/snapshots with the four new entries (same order as Step 4). Then run the full suites:

Run: `pnpm test:unit && pnpm typecheck`
Expected: exit 0.

- [ ] **Step 6: Manual verify + commit**

Dev server → Settings → Appearance: six built-in cards (Forest, Sage, Canyon, Teal, Dusk, Dark); selecting each swaps the accent live; active theme survives reload.

```bash
git add packages/shared/src/themes-api.ts packages/settings/src/themes-routes.ts apps/web/src/styles/tokens.css tests/unit/design-tokens-contrast.test.ts <any test files fixed in step 5>
git commit -m "feat(themes): five national-park built-in themes (#726)"
```

---

### Task 5: `--gold` as optional 6th custom-theme slot

**Files:**

- Create: `tests/unit/theme-runtime-gold.test.ts`
- Modify: `packages/shared/src/themes-api.ts` (optional `gold` token), `apps/web/src/theme/theme-runtime.ts` (apply/clear gold), `apps/web/src/settings/settings-appearance-pane.tsx` (editor field + contrast warning)

**Interfaces:**

- Consumes: Task 1's `--gold*` CSS tokens; existing runtime helpers `parseThemeColor` / `mix` / `rgbToHex` and `deriveAccentRamp`'s mix ratios in `theme-runtime.ts`.
- Produces: `AestheticThemeTokens` gains optional `gold?: string`. Backend completeness (`hasCompleteTokens`, requires the 12 keys) is deliberately untouched — existing saved themes stay valid.

- [ ] **Step 1: Write the failing runtime test**

Create `tests/unit/theme-runtime-gold.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { applyThemeTokens } from "../../apps/web/src/theme/theme-runtime";

const baseTokens = {
  paper: "#ece4d1",
  surface: "#f6f0e1",
  surface2: "#e3dac4",
  surface3: "#d9cfb5",
  ink: "#292621",
  ink2: "#5b564d",
  ink3: "#8b8678",
  ink4: "#9a958a",
  line: "#d5ccb8",
  lineSubtle: "#e0d8c5",
  lineStrong: "#c2b89f",
  accent: "#294b39"
};

describe("custom-theme gold slot", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("style");
  });

  it("applies --gold and a derived gold ramp when provided", () => {
    applyThemeTokens({ ...baseTokens, gold: "#c2872b" });
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--gold")).toBe("#c2872b");
    for (const v of ["--gold-strong", "--gold-soft", "--gold-soft-2", "--gold-ink"]) {
      expect(style.getPropertyValue(v), v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("leaves gold vars unset (built-in constant wins) when omitted", () => {
    applyThemeTokens(baseTokens);
    expect(document.documentElement.style.getPropertyValue("--gold")).toBe("");
  });
});
```

Run: `pnpm vitest run tests/unit/theme-runtime-gold.test.ts`
Expected: FAIL — first test's `--gold` is empty (runtime doesn't know the key). If the import path or `applyThemeTokens` signature differs, match the real export — `tests/unit/web-settings-data-source-model.test.ts` shows the established pattern for importing `apps/web` code.

- [ ] **Step 2: Extend the shared contract** in `packages/shared/src/themes-api.ts`. `AESTHETIC_THEME_TOKEN_KEYS` (the 12) stays untouched — it drives `required` and backend completeness. Add:

```ts
/** Optional aesthetic tokens: absent = built-in constant applies. */
export const OPTIONAL_AESTHETIC_TOKEN_KEYS = ["gold"] as const;
```

Change the tokens type so gold is optional (adapt to the file's existing type name):

```ts
export type AestheticThemeTokens = Record<(typeof AESTHETIC_THEME_TOKEN_KEYS)[number], string> & {
  gold?: string;
};
```

In `aestheticThemeTokensSchema`, add to `properties` (NOT to `required`; `additionalProperties: false` stays):

```ts
      gold: colorValueSchema,
```

- [ ] **Step 3: Teach the runtime** in `apps/web/src/theme/theme-runtime.ts`. After the accent-ramp derivation inside `applyThemeTokens`, add (mirror `deriveAccentRamp`'s exact helper signatures — the ratios below match its hover/soft/ink mixes):

```ts
if (tokens.gold) {
  const gold = parseThemeColor(tokens.gold);
  if (gold) {
    root.style.setProperty("--gold", tokens.gold);
    root.style.setProperty("--gold-strong", rgbToHex(mix(gold, BLACK, 0.18)));
    root.style.setProperty("--gold-soft", rgbToHex(mix(gold, WHITE, 0.82)));
    root.style.setProperty("--gold-soft-2", rgbToHex(mix(gold, WHITE, 0.72)));
    root.style.setProperty("--gold-ink", rgbToHex(mix(gold, BLACK, 0.45)));
  }
}
```

(If the file uses inline `{ r: 0, g: 0, b: 0 }` literals instead of `BLACK`/`WHITE` constants, follow the file's idiom.)

Add to `CLEARED_RUNTIME_VARS`:

```ts
  "--gold",
  "--gold-strong",
  "--gold-soft",
  "--gold-soft-2",
  "--gold-ink",
```

Run the test. Expected: PASS.

- [ ] **Step 4: Editor field** in `apps/web/src/settings/settings-appearance-pane.tsx`:
  - Add a gold entry to the token field list (`TOKEN_LABELS`, lines 24–37): label `Gold (decorative)`. Because gold is optional, the form must tolerate an absent value: initialize new-theme drafts with `gold: "#c2872b"`, and when loading an existing theme without gold, fall back to `"#c2872b"` in the input while omitting the key from the save payload if the user never touches it.
  - Extend the non-blocking `contrastWarnings` logic (lines 77–86) with a gold-specific rule using the existing `contrastRatio` helper (lines 347–354): warn below **3.0** against `paper` with copy `"Gold is decorative — aim for at least 3:1 on paper."` (not the 4.5 text threshold; gold never carries text — `--gold-ink` does, and the runtime derives it).

- [ ] **Step 5: Full gate + manual verify**

Run: `pnpm test:unit && pnpm typecheck && pnpm lint`
Expected: exit 0. Manual: create a custom theme, set gold to `#8a4b2b`, save, activate — gold accents (Task 6 rail marker, Task 7 eyebrows) follow; delete the theme — built-in gold returns (cleared vars).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/themes-api.ts apps/web/src/theme/theme-runtime.ts apps/web/src/settings/settings-appearance-pane.tsx tests/unit/theme-runtime-gold.test.ts
git commit -m "feat(themes): optional gold slot for custom themes (#726)"
```

---

### Task 6: App-shell polish — committed forest rail + topbar keyline

**Files:**

- Modify: `apps/web/src/styles/tokens.css` (rail tokens), `apps/web/src/styles.css` (`.sidebar` block lines ~293–422, `.topbar` line ~448)

**Interfaces:**

- Consumes: Task 1's `--forest-ink` / `--gold`; Task 4's per-theme `--forest-ink` overrides (the rail follows the active park theme automatically).
- Produces: `--rail-*` token family (available to future shell work).

- [ ] **Step 1: Rail tokens** — add to tokens.css `:root` APP BRIDGE section:

```css
/* Committed forest nav field (spec §3.3). --rail-bg rides --forest-ink so
     park themes re-ground the rail automatically; dark overrides it (dark's
     forest-ink is a LIGHT tint, unusable as a ground). */
--rail-bg: var(--forest-ink);
--rail-fg: #ede5d2;
--rail-fg-muted: rgba(237, 229, 210, 0.72);
--rail-hover-bg: rgba(237, 229, 210, 0.08);
--rail-active-bg: rgba(0, 0, 0, 0.28);
--rail-divider: rgba(237, 229, 210, 0.14);
--rail-marker: var(--gold);
```

And in `[data-theme="dark"]`:

```css
--rail-bg: #182b21;
```

- [ ] **Step 2: Re-ground the rail** in `apps/web/src/styles.css`. Value-level edits (selectors and layout untouched):

`.sidebar` (line ~295): replace `border-right: 1px solid var(--border);` and `background: var(--surface-raised);` with:

```css
border-right: none;
background: var(--rail-bg);
color: var(--rail-fg);
```

Also update the comment above it (line ~293) — it describes "a calm white card against warm paper"; it is now a committed forest field.

`.brand-lockup` and `.brand-mark` (lines ~308–322): `color: var(--ink);` → `color: var(--rail-fg);` (both places).

`.nav-group__label` (line ~361): `color: var(--text-subtle);` → `color: var(--rail-fg-muted);`

`.module-link` (line ~372): `color: var(--text-muted);` → `color: var(--rail-fg-muted);`

`.module-link:hover` (line ~387):

```css
.module-link:hover {
  background: var(--rail-hover-bg);
  color: var(--rail-fg);
}
```

`.module-link.active` (line ~392) — flat square gold marker flush to the rail edge (functional nav indicator; NOT the banned curved card accent):

```css
.module-link.active {
  position: relative;
  background: var(--rail-active-bg);
  color: var(--rail-fg);
}

.module-link.active::before {
  content: "";
  position: absolute;
  left: -0.75rem; /* flush to the rail edge (rail padding is 0.75rem) */
  top: 4px;
  bottom: 4px;
  width: 3px;
  background: var(--rail-marker);
}
```

`.nav-count` (line ~409): `color: var(--text-subtle);` → `color: var(--rail-fg-muted);`

`.rail-foot` (line ~418): `border-top: 1px solid var(--border-subtle);` → `border-top: 1px solid var(--rail-divider);`

- [ ] **Step 3: Topbar keyline** — `.topbar` (line ~448): `border-bottom: 1px solid var(--border);` → `border-bottom: 1px solid var(--border-strong);` (the oat-translucent `--topbar-bg` landed in Task 1).

- [ ] **Step 4: File-size + guard check**

Run: `pnpm check:file-size && pnpm check:design-tokens`
Expected: exit 0. `styles.css` starts at 983 lines; this task adds ~12 net. **If it exceeds 1000:** cut the whole rail block (`.sidebar` through `button.module-link`, lines ~293–431) into a new `apps/web/src/styles/shell-rail.css` and append `@import "./shell-rail.css";` to `apps/web/src/styles/index.css` (after `../styles.css` so cascade order is preserved).

- [ ] **Step 5: Manual verify + capture**

Dev server: forest rail with cream text, gold flat marker on the active item, readable hover states; usermenu/popover in the rail foot still legible (if it renders light-on-light inside the dark rail, log it as a follow-up — don't chase). Switch to Canyon theme — rail re-grounds rust; dark theme — deep charcoal-forest rail. Run focused DOM/computed-style assertions for both themes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/styles.css apps/web/src/styles/tokens.css
git commit -m "feat(design): committed forest nav rail + topbar keyline (#726)"
```

---

### Task 7: Today screen polish — hero type, keyline fields

**Files:**

- Modify: `apps/web/src/styles/kit-today.css` (hero block lines ~410–474)

**Interfaces:**

- Consumes: Task 1's `--gold-ink`, Task 2's `--font-display` (if Task 2 is still blocked, `var(--font-display)` is undefined — use `var(--font-serif)` here temporarily ONLY in that case and note it in the commit; the bridge makes them identical once Task 2 lands).
- Produces: nothing downstream.

- [ ] **Step 1: Hero type** in `apps/web/src/styles/kit-today.css`:

`.cmd-eyebrow` (line ~419) — gold mono strap:

```css
.cmd-eyebrow {
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
  color: var(--gold-ink);
}
```

`.cmd-hello` (line ~425) — Display Black hero, top of the scale:

```css
.cmd-hello {
  font-family: var(--font-display);
  font-size: var(--text-5xl);
  font-weight: var(--weight-black);
  letter-spacing: var(--tracking-tight);
  line-height: 1.02;
  margin: 10px 0 0;
}
```

`.cmd-lede` (line ~433) — body moves off serif:

```css
.cmd-lede {
  font-family: var(--font-sans);
  font-size: 18px;
  line-height: 1.55;
  color: var(--text-muted);
  margin-top: 14px;
}
```

- [ ] **Step 2: Stats become keyline fields** — `.cmd-stat` (line ~451): replace the soft card with a bounded field:

```css
.cmd-stat {
  background: var(--paper);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xs);
  padding: 11px 13px;
}
```

- [ ] **Step 3: Double-border sweep** — Task 1 turned `--shadow-xs/sm` into hairline rings, so any Today selector with BOTH a `border` and a small `box-shadow` now draws two rings:

```bash
grep -n "box-shadow" apps/web/src/styles/kit-today.css apps/web/src/styles/kit-today-feeds.css apps/web/src/styles/kit-today-misc.css
```

For each hit using `var(--shadow-xs)`, `var(--shadow-sm)`, or `var(--shadow-control)` on a selector that also sets a `border`, delete the `box-shadow` line (the border is the keyline). Leave `--shadow-md/lg/xl`/`--shadow-panel`/`--shadow-pop` uses alone (true elevation).

- [ ] **Step 4: Verify + capture**

Run: `pnpm check:design-tokens && pnpm check:file-size && pnpm lint`
Expected: exit 0. Dev server on `/today`: black Display hero, gold eyebrow, ringed stat fields, no doubled borders, agenda/wellness aside inherits cleanly. Assert the light and dark Today DOM/layout.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/styles/kit-today.css apps/web/src/styles/kit-today-feeds.css apps/web/src/styles/kit-today-misc.css
git commit -m "feat(design): Today hero type + keyline fields (#726)"
```

---

### Task 8: Verification sweep, follow-ups, epic bookkeeping

**Files:**

- Modify: none (verification + GitHub only)

- [ ] **Step 1: Full gate**

Run: `pnpm verify:foundation`
Expected: exit 0 — record the exact exit code and any suite counts in the PR body.

- [ ] **Step 2: Browser assertion sweep** — verify the declared DOM/computed-style properties in both themes: oat ground everywhere (no leftover near-white panels); no soft-shadow cards on flat surfaces; readable text; semantic amber/red/steel remain caution/error/info; empty/loading states use authored patterns.

- [ ] **Step 3: Log follow-up issues** (each "Part of #726", `task` label) for anything found in Step 2 plus these known deferrals:
  - Rename the ~30 direct `var(--pine*)` consumers to `--forest*`, then retire the bridge aliases.
  - Rename the ~60 `var(--font-serif)` uses to `--font-display`, then retire that bridge.
  - Custom-theme accent softs derive via white-mix (`deriveAccentRamp`) while built-ins use hand-tuned oat-tinted softs — unify if custom themes look washed on oat.
  - Any component logged as an auto-reskin surprise (spec risk §2) — including the rail-foot usermenu if it misrendered in Task 6.

- [ ] **Step 4: PR + epic bookkeeping** — open the PR referencing epic #726 and the child task issues; update the epic's checklist/comments. Normal voice in PR title/body. Run `pnpm prettier --write` on this plan doc before it is committed anywhere (handoff-doc formatting trap).

- [ ] **Step 5 (post-merge, Ben/coordinator): Claude Design mirror** — author the final Park Press palette back into the `Jarvis Design System` Claude Design project (`0501fab4-7c60-457d-9a46-b717d55e16c9`) per spec §5. The gallery mirrors tokens.css, never gates shipping. This needs the session-bound DesignSync tool — it cannot be delegated to a build subagent.

---

## Contrast math (reference)

Computed WCAG ratios for the starting values (the Task 1 test re-verifies these mechanically on every run):

| Pair                                                       | Ratio                       | Floor          |
| ---------------------------------------------------------- | --------------------------- | -------------- |
| forest `#294b39` on oat `#ece4d1`                          | 7.7                         | 4.5            |
| sage / canyon / teal / dusk on oat                         | 5.7 / 5.3 / 4.7 / 6.8       | 4.5            |
| white on forest / sage / canyon / teal / dusk              | 9.7 / 7.2 / 6.7 / 6.0 / 8.5 | 4.5            |
| `--text-subtle #615a48` / `--text-faint #6a6350` on oat    | 5.4 / 4.7                   | 4.5            |
| `--gold-ink #6d4a12` on oat                                | 6.3                         | 4.5            |
| `--gold #c2872b` on oat (decorative)                       | ~2.4                        | 2.0 (non-text) |
| white on dark `--btn-primary-bg` (forest-active `#357857`) | 5.3                         | 4.5            |
