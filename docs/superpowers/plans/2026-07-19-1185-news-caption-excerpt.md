# Plan — #1185 News caption/excerpt polish

**Spec:** `docs/superpowers/specs/2026-07-19-1185-news-caption-excerpt.md`
**Branch:** `feedback/1185-news-layout`

## Verified against branch

- `packages/news/src/web/news-mosaic.tsx` — `MosaicArticle` renders `.nw-mosaic__art` (flex column,
  uniform `gap: var(--space-2)` for img/kicker/title/blurb/link), `.nw-mosaic__art--textonly` applies
  only when `!major && !headline.imageUrl`.
- `packages/news/src/web/styles/news-2.css:150-157` — textonly blurb currently raises the clamp to
  `-webkit-line-clamp: 10` (not removed). Photo cards clamp to 3 lines (news-2.css:138-149) — unchanged.
- `packages/news/src/web/styles/news-1.css:5-7` — `.nw-wrap` has no top padding.
  `packages/sports/src/web/styles/sports-1.css:7-18` — `.sp-wrap` adds
  `padding: var(--space-6) var(--space-6) var(--space-11)`. Both wraps sit directly under the shared
  `<main class="content-surface">` (`apps/web/src/styles.css:531`, `space-7 space-6`), so today News
  gets `space-7` above its masthead and Sports gets `space-7 + space-6` — confirmed offset gap, and
  the concrete top-spacing fix.
- No existing render test for `NewsMosaic`/`MosaicArticle` markup — `tests/unit/news-mosaic.test.ts`
  only covers `composeMosaic`/`interleaveGroups` (pure logic). `tests/unit/sports-page.test.tsx` is
  the render-test seam to copy: `renderToString` + `QueryClientProvider`, string-`toContain` on
  classes, no jsdom/testing-library (repo convention).

## Tasks (CSS-only, existing tokens; no markup/component changes)

1. **Render-test seam.** New `tests/unit/news-mosaic-render.test.tsx`: render `<NewsMosaic plan={...}>`
   directly (already exported, no query client needed) with a plan containing one photo standard and
   one no-photo standard. Assert via `renderToString` output:
   - photo card: has `nw-mosaic__img`, lacks `nw-mosaic__art--textonly`.
   - no-photo card: has `nw-mosaic__art--textonly`, no `<img`.
   - both: `nw-mosaic__artkicker` present. No assertions on title/summary copy (spec: "without
     snapshotting incidental text").

2. **`.nw-wrap` top spacing** (`news-1.css`) — add `padding-top: var(--space-6);` so News' top offset
   above the masthead matches Sports' (`content-surface` space-7 + this space-6), same token both
   pages already use. No side/bottom change (out of scope, `content-surface` already governs those
   for both pages equally).

3. **Photo→kicker binding** (`news-2.css`, `.nw-mosaic__img`) — add
   `margin-bottom: calc(var(--space-1) - var(--space-2));` to pull the kicker 4px closer, so the
   effective photo→kicker gap (space-1 = 4px) is tighter than the other internal gaps (space-2 = 8px,
   kicker→title etc., unchanged) and far tighter than the inter-card grid gap (space-5/6 = 20/24px).
   Applies to majors and standards alike (majors always carry art). Card's existing
   `border-bottom`/`padding-bottom` keyline is untouched — still defines the card boundary.

4. **Remove textonly clamp** (`news-2.css:155-157`) — replace `-webkit-line-clamp: 10;` with
   `display: block; -webkit-line-clamp: unset; overflow: visible;` so the full sanitized summary
   shows before "Continue reading" with no clamp. Photo-card blurb rule (3-line clamp) is untouched.

## Exit

- `pnpm vitest run tests/unit/news-mosaic-render.test.ts tests/unit/news-mosaic.test.ts` green.
- Pre-push trio (`format:check`, `lint`, `typecheck`) green, rebased on `origin/main`.
- Hand off to the separate QA agent for live `5178` DOM assertions before the three annotations
  resolve (not this agent's job per collision notes).
