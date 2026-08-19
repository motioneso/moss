# Sports broadsheet post-merge cleanup (#837) Implementation Plan

> **For agentic workers:** This plan is executed inline by the build agent itself (superpowers
> execution/subagent-driven skills are disabled in this repo). Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Clean up three minor findings from the Fable 5 review of PR #831/#839: tokenize the
retained `sp-fc` raw-px CSS block, relocate `FollowedCard` to its only consumer, and delete a dead
CSS rule. Visual-only, zero behavior change.

**Architecture:** Three independent, sequential edits in the existing `packages/sports` module —
no new files, no new abstractions. Each edit is verified against the full frontend gate before the
next begins.

**Tech Stack:** React 18 + TypeScript (packages/sports/src/web), CSS with the existing
`--space-*` / `--text-*` token scale (apps/web/src/styles/tokens.css), Playwright for
focused browser DOM/layout assertions.

## Global Constraints

- No hardcoded px literals for spacing/type in the `sp-fc` block — bind to `--space-1`…`--space-11`
  and `--text-2xs`…`--text-6xl` only (spec: 2026-07-05-sports-editorial-redesign.md §1).
- No behavior change; all six regression items in the spec §5 must keep passing as-is (none of
  this touches query/fetch logic).
- `git add` by explicit path only — never `-A` or repo-wide `pnpm format`.
- File-size gate: `sports-1.css` must stay under 1000 lines (currently 736; this only shrinks it).

---

## Reference: token scale

```
--space-0: 0      --space-4: 16px    --space-9: 48px
--space-1: 4px    --space-5: 20px    --space-10: 64px
--space-2: 8px    --space-6: 24px    --space-11: 80px
--space-3: 12px   --space-7: 32px    --space-12: 96px
                  --space-8: 40px    --space-14: 128px

--text-2xs: 11px  --text-md: 15px    --text-2xl: 24px
--text-xs: 12px   --text-lg: 17px    --text-3xl: 30px
--text-sm: 13px   --text-xl: 20px    ...
```

## Reference: verified current file state (re-checked on this branch, 616b9ed1 base)

- `packages/sports/src/web/styles/sports-1.css` is **736 lines** (not 985 as the parent spec's
  §4 assumed pre-split — #839 already split out `sports-4-grid.css` / `sports-5-editorial.css`).
  File-size gate is not at risk either way.
- The `sp-fc` block is lines **340–476** of `sports-1.css`.
- The dead media query is at lines **732–736** (not "near line 962" as the issue body says — that
  line number is stale; content matches exactly: base `.sp-emptyboard` rule at line 723–731 already
  sets `grid-template-columns: 1fr`, and the `@media (max-width: 900px)` block re-sets the same
  value).
- `FollowedCard` is defined at `sports-page.tsx:205–256` and its **only** consumer anywhere in the
  repo is `today-widget.tsx:37`. `check-design-tokens.ts` only scans `apps/web/src`, not
  `packages/sports`, so this raw-px block was never caught by CI — confirms the issue's framing
  ("only untokenized island... all gates were green at merge").

---

### Task 1: Move `FollowedCard` from `sports-page.tsx` to `today-widget.tsx`

**Files:**

- Modify: `packages/sports/src/web/sports-page.tsx` (remove lines 202–257: the
  `/* ---- Followed card (Today widget) ---- */` comment + `FollowedCard` function, and prune
  imports that become unused)
- Modify: `packages/sports/src/web/today-widget.tsx` (add the function + its imports, drop the
  `FollowedCard` re-export from `sports-page.js`)

**Interfaces:**

- Consumes: nothing new — `FollowedCard(props: { card: FollowedTeamCard })` keeps its exact
  signature and JSX body, just changes file.
- Produces: `today-widget.tsx` becomes self-contained for `FollowedCard`; no other file imports it
  (verified: only consumer repo-wide).

- [ ] **Step 1: Confirm no other consumer exists (repeat the check, branch may have moved)**

Run: `grep -rn "FollowedCard" packages apps --include='*.ts' --include='*.tsx'`
Expected: only `today-widget.tsx` (usage + import) and `sports-page.tsx` (definition).

- [ ] **Step 2: Edit `today-widget.tsx` — replace the whole file**

```tsx
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { FollowedTeamCard } from "@jarv1s/shared";

import { getSportsOverview } from "./sports-client.js";
import { sportsQueryKeys } from "./query-keys.js";
import { hasLiveGame, LIVE_REFETCH_INTERVAL_MS } from "./sports-page.js";
import { useUserLocale } from "./locale.js";
import { CalendarIcon, Crest, FormPips, TrophyIcon } from "./sports-parts.js";
import { NewsIcon } from "./sports-news.js";
import { formatNextMatch } from "./sports-ticker.js";

/**
 * Today "Sports desk" widget (#799 module-web-registry Phase A).
 *
 * Replaces the old hardcoded `SportsDesk` in `apps/web/src/today/today-page.tsx`, which rendered
 * demo/placeholder data from `TodayFeed["sports"]` — dead code, since no caller ever populated
 * that field with real data. This widget instead reuses the same `getSportsOverview()` query
 * (identical `sportsQueryKeys.overview` key, so it shares the React Query cache with the
 * `/sports` page). `FollowedCard` lives here (not on the `/sports` page) because this widget is
 * its only consumer since the ticker refactor (#837). This is a real-data-contract addition, not
 * a byte-identical port — see the design spec's declared screenshot-diff exemption for this
 * widget.
 */
export function SportsTodayWidget(): ReactNode {
  const overviewQuery = useQuery({
    queryKey: sportsQueryKeys.overview,
    queryFn: () => getSportsOverview(),
    refetchInterval: (query) => (hasLiveGame(query.state.data) ? LIVE_REFETCH_INTERVAL_MS : false),
    refetchIntervalInBackground: false
  });
  const data = overviewQuery.data;
  if (!data || data.followed.length === 0) return null;

  return (
    <section className="jds-brief" aria-label="Sports desk">
      <div className="jds-brief__head">
        <span className="jds-brief__kicker">Sports desk</span>
      </div>
      <div className="jds-brief__title">Your teams, today</div>
      <div className="sp-fcgrid">
        {data.followed.slice(0, 4).map((card) => (
          <FollowedCard key={`${card.competitionKey}:${card.teamKey}`} card={card} />
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- Followed card (Today widget) */

function FollowedCard(props: { card: FollowedTeamCard }) {
  const { card } = props;
  const locale = useUserLocale();
  return (
    <article className="sp-fc">
      <div className="sp-fc__hd">
        <Crest name={card.name} crestUrl={card.crestUrl} size="md" />
        <div className="sp-fc__id">
          <span className="sp-fc__name">{card.name}</span>
          <span className="sp-fc__comp">{card.competitionLabel}</span>
        </div>
        <span className={`sp-tag sp-tag--${card.status}`}>{card.status}</span>
      </div>

      <div className="sp-fc__primary">
        {card.status === "news" ? (
          <>
            <span className="sp-fc__newsic">
              <NewsIcon />
            </span>
            {card.news ? (
              <a className="sp-fc__newstx" href={card.news.url} target="_blank" rel="noreferrer">
                {card.news.title}
              </a>
            ) : (
              <span className="sp-fc__newstx">No recent news</span>
            )}
          </>
        ) : (
          <span className="sp-fc__resscore">{card.primary}</span>
        )}
      </div>

      <div className="sp-fc__form">
        {card.standing ? (
          <span className="sp-fc__standing">
            <TrophyIcon />
            {card.standing}
          </span>
        ) : null}
        <FormPips form={card.form} />
      </div>

      {card.nextMatch ? (
        <div className="sp-fc__next">
          <span className="sp-fc__nextlbl">
            <CalendarIcon />
            Next
          </span>
          <span className="sp-fc__nextmatch">{formatNextMatch(card.nextMatch, locale)}</span>
        </div>
      ) : null}
    </article>
  );
}
```

Note: `FollowedCard` is no longer exported (`function` not `export function`) — nothing outside
this file uses it anymore, so keep it module-private per YAGNI.

- [ ] **Step 3: Edit `sports-page.tsx` — remove the `FollowedCard` function**

Delete lines 202–257 (the `/* ---- Followed card (Today widget) ---- */` comment block through the
closing `}` of `FollowedCard`), leaving `HeroSide`'s closing brace directly followed by
`BroadsheetGrid`'s definition.

- [ ] **Step 4: Edit `sports-page.tsx` — prune now-unused imports**

Change:

```tsx
import type {
  FollowedTeamCard,
  GameSide,
  OverviewHero,
  SportsOverviewResponse
} from "@jarv1s/shared";

import { getSportsOverview } from "./sports-client.js";
import { sportsQueryKeys } from "./query-keys.js";
import { formatDate, formatTime, useUserLocale } from "./locale.js";
import { CalendarIcon, Crest, FormPips, LiveDot, TrophyIcon } from "./sports-parts.js";
import { LatestColumn, NewsBand, NewsIcon, StoryHero } from "./sports-news.js";
import { SportsTicker, formatNextMatch } from "./sports-ticker.js";
```

to:

```tsx
import type { GameSide, OverviewHero, SportsOverviewResponse } from "@jarv1s/shared";

import { getSportsOverview } from "./sports-client.js";
import { sportsQueryKeys } from "./query-keys.js";
import { formatDate, formatTime, useUserLocale } from "./locale.js";
import { CalendarIcon, Crest, LiveDot, TrophyIcon } from "./sports-parts.js";
import { LatestColumn, NewsBand, StoryHero } from "./sports-news.js";
import { SportsTicker } from "./sports-ticker.js";
```

(Drops `FollowedTeamCard`, `FormPips`, `NewsIcon`, `formatNextMatch` — each verified above as used
only inside the removed `FollowedCard`. `CalendarIcon`, `Crest`, `TrophyIcon`, `useUserLocale`,
`LiveDot`, `LatestColumn`, `NewsBand`, `StoryHero`, `SportsTicker` all have other call sites left in
this file.)

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter @jarv1s/sports typecheck && pnpm --filter @jarv1s/sports lint`
Expected: both pass with no unused-import or missing-symbol errors. If the package name differs,
fall back to `pnpm typecheck` / `pnpm lint` from repo root.

- [ ] **Step 6: Run existing unit tests touching these files**

Run: `pnpm test:unit -- sports-page`
Expected: PASS (no test references `FollowedCard` directly — confirmed via
`grep -rln "FollowedCard" tests/`, which returned nothing).

- [ ] **Step 7: Commit**

```bash
git add packages/sports/src/web/sports-page.tsx packages/sports/src/web/today-widget.tsx
git commit -m "refactor(sports): move FollowedCard to its only consumer (today-widget)

FollowedCard hasn't been rendered by /sports since the ticker refactor
(#831); today-widget.tsx is its sole caller. Move it there and drop it
from the public surface of sports-page.tsx.

Part of #837."
```

---

### Task 2: Tokenize the `sp-fc` CSS block

**Files:**

- Modify: `packages/sports/src/web/styles/sports-1.css:340-476`

**Interfaces:** none — pure CSS value substitution, class names and selectors unchanged.

- [ ] **Step 1: Re-read the current block to confirm line numbers haven't drifted**

Run: `sed -n '340,476p' packages/sports/src/web/styles/sports-1.css`
Expected: matches the "before" text quoted in Step 2 below. If it has drifted, locate the block by
selector name (`.sp-fcgrid` / `.sp-fc`) instead of line number before editing.

- [ ] **Step 2: Replace the block**

Before (lines 340–476):

```css
.sp-fcgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(266px, 1fr));
  gap: 12px;
}
.sp-fc {
  position: relative;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--surface);
  padding: 15px 16px 14px;
  display: flex;
  flex-direction: column;
}
.sp-fc__hd {
  display: flex;
  align-items: center;
  gap: 11px;
}
.sp-fc__id {
  flex: 1;
  min-width: 0;
}
.sp-fc__name {
  display: block;
  font-family: var(--font-sans);
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.2;
}
.sp-fc__comp {
  display: block;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-top: 2px;
}
.sp-tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-subtle);
  background: var(--surface-2);
  padding: 3px 7px;
  border-radius: var(--radius-pill);
}
.sp-tag--live {
  color: var(--accent-fg);
  background: var(--forest-soft);
}
.sp-tag--today {
  color: var(--forest-ink);
  background: var(--forest-soft);
}
.sp-tag--news {
  color: var(--steel-ink);
  background: var(--steel-soft);
}
.sp-fc__primary {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 13px;
}
.sp-fc__resscore {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
}
.sp-fc__newsic {
  flex: none;
  color: var(--steel);
  display: inline-flex;
  margin-top: 1px;
}
.sp-fc__newstx {
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.4;
  color: var(--text-muted);
}
.sp-fc__form {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 11px;
}
.sp-fc__standing {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.02em;
  color: var(--text-subtle);
}
.sp-fc__standing svg {
  color: var(--text-faint);
}
.sp-fc__next {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
  padding-top: 11px;
  border-top: 1px solid var(--border-subtle);
}
.sp-fc__nextlbl {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.sp-fc__nextlbl svg {
  color: var(--text-faint);
}
.sp-fc__nextmatch {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
```

After:

```css
.sp-fcgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(266px, 1fr));
  gap: var(--space-3);
}
.sp-fc {
  position: relative;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--surface);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
}
.sp-fc__hd {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.sp-fc__id {
  flex: 1;
  min-width: 0;
}
.sp-fc__name {
  display: block;
  font-family: var(--font-sans);
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--text);
  line-height: 1.2;
}
.sp-fc__comp {
  display: block;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
  margin-top: var(--space-1);
}
.sp-tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-subtle);
  background: var(--surface-2);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-pill);
}
.sp-tag--live {
  color: var(--accent-fg);
  background: var(--forest-soft);
}
.sp-tag--today {
  color: var(--forest-ink);
  background: var(--forest-soft);
}
.sp-tag--news {
  color: var(--steel-ink);
  background: var(--steel-soft);
}
.sp-fc__primary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-3);
}
.sp-fc__resscore {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--text-md);
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
}
.sp-fc__newsic {
  flex: none;
  color: var(--steel);
  display: inline-flex;
  margin-top: var(--space-0);
}
.sp-fc__newstx {
  font-family: var(--font-sans);
  font-size: var(--text-md);
  line-height: 1.4;
  color: var(--text-muted);
}
.sp-fc__form {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-3);
}
.sp-fc__standing {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  letter-spacing: 0.02em;
  color: var(--text-subtle);
}
.sp-fc__standing svg {
  color: var(--text-faint);
}
.sp-fc__next {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}
.sp-fc__nextlbl {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.sp-fc__nextlbl svg {
  color: var(--text-faint);
}
.sp-fc__nextmatch {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
}
```

Nearest-token mapping used (documented for the PR description — several source values are
equidistant between two tokens; ties resolved toward the token that keeps padding/gaps uniform
within the same rule rather than toward a fixed up/down rule, since #829's own conversions weren't
consistent either way):

- `gap: 12px` → `--space-3` (exact)
- `padding: 15px 16px 14px` → `--space-4` uniform (15→16 nearest, 16 exact, 14 tie 12/16 resolved
  up to keep all three sides equal — cleaner than three different token values for a 1-2px source
  spread)
- `gap: 11px` → `--space-3` (12, nearest)
- `font-size: 14.5px` → `--text-md` (15, nearest)
- `font-size: 10px` → `--text-2xs` (11, nearest — smallest token in the scale)
- `margin-top: 2px` → `--space-1` (4, nearest non-zero over 0)
- `font-size: 9.5px` → `--text-2xs` (11, nearest — smallest token in the scale)
- `padding: 3px 7px` → `--space-1 --space-2` (4/8, nearest each)
- `gap: 5px` → `--space-1` (4, nearest)
- `gap: 8px` → `--space-2` (exact)
- `margin-top: 13px` → `--space-3` (12, nearest)
- `font-size: 15px` → `--text-md` (exact)
- `margin-top: 1px` → `--space-0` (0, nearest — this one _does_ round down since 0 is closer than 4)
- `font-size: 14px` → `--text-md` (15, tie 13/15 resolved up for consistency with the other
  `.sp-fc` body text already at `--text-md`)
- `gap: 10px` → `--space-3` (12, tie 8/12 resolved up)
- `margin-top: 11px` → `--space-3` (12, nearest)
- `font-size: 10.5px` → `--text-2xs` (11, nearest)
- `gap: 4px` → `--space-1` (exact)
- `margin-top: 12px` → `--space-3` (exact)
- `padding-top: 11px` → `--space-3` (12, nearest)
- `font-size: 13px` → `--text-sm` (exact)

- [ ] **Step 3: Lint and format**

Run: `pnpm format:check && pnpm lint`
Expected: PASS (no raw-px lint rule exists for this package per Step 0 finding, but formatting
must stay clean).

- [ ] **Step 4: Design-token guard**

Run: `pnpm check:design-tokens`
Expected: `No design-token violations found.` (all tokens used are already defined in
`apps/web/src/styles/tokens.css`).

- [ ] **Step 5: File-size gate**

Run: `pnpm check:file-size`
Expected: PASS — this only shortens `sports-1.css` (var() names vs. bare numbers are roughly
line-neutral, no lines added or removed).

- [ ] **Step 6: Commit**

```bash
git add packages/sports/src/web/styles/sports-1.css
git commit -m "style(sports): tokenize the sp-fc card's raw px literals

sp-fc was the only untokenized island left in the sports CSS after
#829/#839 (it renders the Today 'Sports desk' widget, so it was
deliberately left alone during that merge). Sweep gap/padding/margin to
--space-* and font-size to --text-* using nearest-token matching.

Part of #837."
```

---

### Task 3: Delete the dead `.sp-emptyboard` media query

**Files:**

- Modify: `packages/sports/src/web/styles/sports-1.css:723-736`

**Interfaces:** none.

- [ ] **Step 1: Re-confirm the redundancy**

Run: `sed -n '723,736p' packages/sports/src/web/styles/sports-1.css`
Expected:

```css
.sp-emptyboard {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-7);
  margin-top: var(--space-8);
  padding-top: var(--space-7);
  border-top: 2px solid var(--border);
  align-items: start;
}
@media (max-width: 900px) {
  .sp-emptyboard {
    grid-template-columns: 1fr;
  }
}
```

Confirm the base rule's `grid-template-columns: 1fr` (already single-column) makes the media query
block a no-op at every viewport width.

- [ ] **Step 2: Delete the dead block**

Remove lines 732–736 (the entire `@media (max-width: 900px) { .sp-emptyboard { ... } }` block),
leaving `.sp-emptyboard`'s closing `}` as the last thing in that section.

- [ ] **Step 3: Grep for any other place relying on this specific media query existing**

Run: `grep -n "sp-emptyboard" packages/sports/src/web/*.tsx packages/sports/src/web/styles/*.css`
Expected: only the `.sp-emptyboard` selector itself and its one usage site in
`sports-page.tsx` (`EmptyState`) — no other rule targets this media query.

- [ ] **Step 4: Lint, format, file-size**

Run: `pnpm format:check && pnpm lint && pnpm check:file-size`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sports/src/web/styles/sports-1.css
git commit -m "style(sports): remove dead .sp-emptyboard media query

The <=900px rule re-set grid-template-columns: 1fr, which the base
rule already sets — a no-op left over from an earlier responsive
pass. Delete it.

Part of #837."
```

---

### Task 4: Full verification pass

**Files:** none modified — verification only.

- [ ] **Step 1: Full frontend gate**

Run:

```bash
pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit
```

Expected: all green, real exit code 0 (do not pipe through `tail`).

- [ ] **Step 2: Layout check — sp-fc has no existing focused assertion**

Before relying on the broad browser suite alone: confirm neither existing check actually exercises the
`sp-fc` card. Run:

```bash
grep -n "registerMockSportsRoutes\|sportsOverviewFixture" tests/e2e/capture-screens.spec.ts | grep -i today
```

Expected: no output — the `"capture: today + chat drawer"` test does not mock sports follows, so
`SportsTodayWidget` renders `null` there today (`data.followed.length === 0` — no mock registered
means the query never resolves truthy data in that test). The broad suite therefore does not
exercise the tokenized `sp-fc` block. See Step 3 for the focused check.

- [ ] **Step 3: Focused DOM/computed-style check of the tokenized sp-fc card**

Add a temporary (uncommitted) Playwright script in the scratchpad directory to render `/today` with
mocked follows and assert its DOM, computed styles, and layout, since no committed check does this today:

```ts
// scratchpad-only, do not commit
import { test } from "@playwright/test";
import { registerMockSportsRoutes } from "../../tests/e2e/mock-sports-api.js"; // adjust relative path
// (or: copy the relevant mockApi/baseState + registerMockSportsRoutes calls from
// tests/e2e/capture-screens.spec.ts's "capture: sports" test, but page.goto("/today") instead)
```

In practice: temporarily copy the `"capture: today + chat drawer"` test body, insert
`await registerMockSportsRoutes(page);` before `await page.goto("/today")`, and run just that one
test with Playwright. Compare the resulting DOM/computed-style metrics before and after the CSS
change. Discard the temporary test edit afterward — do not commit it; note the result in the wrap-up report.

- [ ] **Step 4: Run the full browser suite for regressions elsewhere**

Run the existing focused Playwright browser suite.
Expected: all assertions pass. This confirms nothing else on `/sports` or `/today` broke; Step 3
covers the specific `sp-fc` gap.

- [ ] **Step 5: Rebase and pre-push trio**

Run:

```bash
pnpm format:check && pnpm lint && pnpm typecheck
git fetch origin main && git rebase origin/main
```

Expected: clean rebase (no conflicts expected — this branch only touches files no other merged PR
has touched since `616b9ed1`).

## Self-Review

- **Spec coverage:** §1 (tokens) → Task 2. §4 (file-size) → verified in Task 2 Step 5 and reference
  section (base state 736 lines, well under 1000; no split needed for this cleanup). §5 regression
  checklist → untouched by this plan (no query/fetch/logic edits in any task) — explicitly confirmed
  in Global Constraints. §6 exit criteria → Task 4 covers gate + visual audit, with the capture-gap
  called out rather than glossed over.
- Issue's three findings map 1:1 to Tasks 1–3.
- No placeholders: every step has literal before/after code or an exact command.
