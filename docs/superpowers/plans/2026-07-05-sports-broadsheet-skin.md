# Sports Broadsheet Skin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin `/sports` from floating cards into a dense hairline-ruled editorial layout — followed-teams ticker on top, edge-to-edge hero, keyline grid — per spec `docs/superpowers/specs/2026-07-05-sports-editorial-redesign.md` (issue #829, child of epic #726).

**Architecture:** Visual-only refactor of `apps/web/src/sports/*` and `apps/web/src/styles/sports-*.css`. New `SportsTicker` component replaces the followed-team card grid and the league-chips section; hero and split-grid lose their card containers in favor of `var(--border-subtle)` hairlines. All new layout CSS lives in a new `sports-4-grid.css`; replaced rules are deleted from `sports-1.css` in the same pass (no-stale-concepts rule). Park Press round 1 already landed (PR #788), so current semantic tokens are the final values except fonts (#780 swaps `--font-*` targets later — we bind to the vars, so that flip is free).

**Tech Stack:** React 18 + TanStack Query (frontend only — no API/backend changes), plain CSS with Jarvis tokens, Vitest `renderToString` unit tests, and focused Playwright DOM/layout assertions.

## Global Constraints

- **No backend/API changes.** `SportsOverviewResponse` and all queries stay untouched. Frontend files only.
- **Tokens only.** Every color via `var(--...)` (enforced by `pnpm check:design-tokens`). Spacing properties (`margin`/`padding`/`gap`) use `--space-*` tokens; font sizes use `--text-*` tokens. Fixed intrinsic sizes (crest width, 1px hairlines, border-radius) may stay literal px.
- **File-size gate:** every source file < 1000 lines (`pnpm check:file-size`). `sports-1.css` starts at 985 — Task 1 must land the deletions alongside additions.
- **Must not regress (spec §5):** #796 live polling (`hasLiveGame` + `refetchInterval`), #811 zero-follow default slate, #763 league follows first-class, #765 degraded band + skeleton, `localDay(ESPN_TIMEZONE)`, `competitionLabel` everywhere, never-red form pips, `prefers-reduced-motion` guards.
- **Work in an isolated worktree** on branch `829-sports-broadsheet` (shared-tree rule — another session may be mid-build). Create via the superpowers:using-git-worktrees skill at execution time.
- **Commits:** conventional prefix + one user-facing release-note line in the body. Gate before every commit: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`.
- **Type-size mapping** (use everywhere; do not invent sizes):

  | Legacy literal                       | Token                                                  |
  | ------------------------------------ | ------------------------------------------------------ |
  | 9–11.5px                             | `var(--text-2xs)` (11px — a11y floor, nothing smaller) |
  | 12–12.5px                            | `var(--text-xs)`                                       |
  | 13px                                 | `var(--text-sm)`                                       |
  | 14–15.5px                            | `var(--text-md)`                                       |
  | 16–17px                              | `var(--text-lg)`                                       |
  | 20px                                 | `var(--text-xl)`                                       |
  | 24–27px                              | `var(--text-2xl)`                                      |
  | 30px                                 | `var(--text-3xl)`                                      |
  | 34–38px (page title, story headline) | `var(--text-4xl)`                                      |
  | 44–48px (hero score)                 | `var(--text-5xl)`                                      |

- **Spacing mapping:** nearest `--space-*` (`--space-1` 4 / `--space-2` 8 / `--space-3` 12 / `--space-4` 16 / `--space-5` 20 / `--space-6` 24 / `--space-7` 32 / `--space-8` 40). E.g. `gap: 3px` → `var(--space-1)`, `gap: 11px` → `var(--space-3)`, `padding: 15px 16px 14px` → `var(--space-4)`.

---

### Task 1: `SportsTicker` component replaces followed cards + league chips

The dense top-of-page strip. One horizontal, keyboard-scrollable row containing league blocks (whole-league follows, #763) followed by team blocks. Retains **all** card data: name, competition label, status tag, primary line (score or news link), standing, form pips, next match.

**Files:**

- Create: `apps/web/src/sports/sports-ticker.tsx`
- Create: `apps/web/src/styles/sports-4-grid.css`
- Create: `tests/unit/sports-ticker.test.tsx`
- Modify: `apps/web/src/sports/sports-page.tsx` (imports at 1–38, render at 92–112, delete components at 214–315)
- Modify: `tests/unit/sports-page.test.tsx` (assertions at 173–194, 322–345)

**Interfaces:**

- Consumes: `FollowedTeamCard`, `FollowedLeagueRef` from `@jarv1s/shared`; `Crest`, `FormPips`, `LiveDot` from `./sports-parts`; `NewsIcon` from `./sports-news`; `formatDate`, `formatTime`, `useUserLocale` from `../locale/locale-format.js`.
- Produces: `export function SportsTicker(props: { followed: readonly FollowedTeamCard[]; leagues: readonly FollowedLeagueRef[] }): JSX.Element | null` (returns `null` when both arrays are empty). Also `export function formatNextMatch(next: FollowedNextMatch, locale: LocaleSettingsDto): string` — **moved verbatim** from `sports-page.tsx:33-38`. Task 5 relies on class names `sp-ticker`, `sp-tk`, `sp-tk--league`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/sports-ticker.test.tsx` (repo pattern: `renderToString` inside a `QueryClientProvider`, assert on the HTML string):

```tsx
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { FollowedLeagueRef, FollowedTeamCard } from "@jarv1s/shared";

import { SportsTicker } from "../../apps/web/src/sports/sports-ticker.js";

function card(overrides: Partial<FollowedTeamCard> = {}): FollowedTeamCard {
  return {
    teamKey: "min",
    competitionKey: "nfl",
    competitionLabel: "NFL",
    name: "Minnesota Vikings",
    crestUrl: null,
    status: "live",
    primary: "MIN 21 – 14 DAL",
    news: null,
    form: ["W", "W", "L"],
    standing: "2nd · NFC North",
    nextMatch: {
      opponentName: "Green Bay Packers",
      homeAway: "home",
      startsAt: "2026-07-11T20:00:00Z"
    },
    rationale: "You follow the Vikings",
    ...overrides
  };
}

function render(followed: FollowedTeamCard[], leagues: FollowedLeagueRef[] = []): string {
  const client = new QueryClient();
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(SportsTicker, { followed, leagues })
    )
  );
}

describe("SportsTicker", () => {
  it("renders a team block with score, form pips, standing, and next match", () => {
    const html = render([card()]);
    expect(html).toContain("sp-ticker");
    expect(html).toContain("Minnesota Vikings");
    expect(html).toContain("MIN 21 – 14 DAL");
    expect(html).toContain("sp-formpip");
    expect(html).toContain("2nd · NFC North");
    expect(html).toContain("vs Green Bay Packers");
  });

  it("renders a news-status team as a link to the story", () => {
    const html = render([
      card({
        status: "news",
        primary: "",
        news: { title: "Cowboys clinch the division", url: "https://example.com/h1" }
      })
    ]);
    expect(html).toContain('href="https://example.com/h1"');
    expect(html).toContain("Cowboys clinch the division");
  });

  it("renders league follows as distinct leading blocks, never dropped", () => {
    const html = render([], [{ competitionKey: "eng.1", competitionLabel: "Premier League" }]);
    expect(html).toContain("sp-tk--league");
    expect(html).toContain("Premier League");
    expect(html).toContain("Following");
    expect(html).toContain("1 league");
  });

  it("is a labeled, keyboard-focusable scroll region with a manage link", () => {
    const html = render([card()]);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Followed teams and leagues"');
    expect(html).toContain("/settings?section=modules&amp;module=sports");
  });

  it("renders nothing when there are no follows", () => {
    expect(render([], [])).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/sports-ticker.test.tsx`
Expected: FAIL — `Cannot find module '.../sports-ticker.js'`

- [ ] **Step 3: Write the component**

Create `apps/web/src/sports/sports-ticker.tsx`:

```tsx
import type { FollowedLeagueRef, FollowedNextMatch, FollowedTeamCard } from "@jarv1s/shared";
import type { LocaleSettingsDto } from "@jarv1s/shared";

import { formatDate, formatTime, useUserLocale } from "../locale/locale-format.js";
import { Crest, FormPips, LiveDot } from "./sports-parts";
import { NewsIcon } from "./sports-news";

const SETTINGS_HREF = "/settings?section=modules&module=sports";

// "vs Green Bay Packers · Sat, Jul 4 · 3:00 PM" — user's persisted locale + timezone (spec D2).
// Moved from sports-page.tsx with the ticker refactor (#829).
export function formatNextMatch(next: FollowedNextMatch, locale: LocaleSettingsDto): string {
  const at = next.startsAt;
  const date = formatDate(at, locale, { weekday: "short", month: "short", day: "numeric" });
  const time = formatTime(at, locale);
  return `${next.homeAway === "home" ? "vs" : "at"} ${next.opponentName} · ${date} · ${time}`;
}

// Newspaper-style scoreboard strip: league follows lead (kept first-class per #763), then one
// dense block per followed team. Horizontal scroll; tabIndex + role="region" make the overflow
// keyboard-reachable (arrow keys scroll a focused scrollable region).
export function SportsTicker(props: {
  followed: readonly FollowedTeamCard[];
  leagues: readonly FollowedLeagueRef[];
}) {
  if (props.followed.length === 0 && props.leagues.length === 0) return null;
  return (
    <section className="sp-ticker" aria-label="Followed">
      <div
        className="sp-ticker__scroll"
        tabIndex={0}
        role="region"
        aria-label="Followed teams and leagues"
      >
        {props.leagues.length > 0 ? <LeagueBlocks leagues={props.leagues} /> : null}
        {props.followed.map((card) => (
          <TickerTeam key={`${card.competitionKey}:${card.teamKey}`} card={card} />
        ))}
      </div>
      <a className="sp-ticker__manage" href={SETTINGS_HREF}>
        Manage
      </a>
    </section>
  );
}

function LeagueBlocks(props: { leagues: readonly FollowedLeagueRef[] }) {
  const count = props.leagues.length;
  return (
    <div className="sp-tk sp-tk--league">
      <span className="sp-tk__eyebrow">{`Following ${count} league${count === 1 ? "" : "s"}`}</span>
      <div className="sp-tk__leagues">
        {props.leagues.map((league) => (
          <span key={league.competitionKey} className="sp-tk__leaguename">
            {league.competitionLabel}
          </span>
        ))}
      </div>
    </div>
  );
}

function TickerTeam(props: { card: FollowedTeamCard }) {
  const { card } = props;
  const locale = useUserLocale();
  return (
    <article className="sp-tk">
      <div className="sp-tk__hd">
        <Crest name={card.name} crestUrl={card.crestUrl} size="sm" />
        <span className="sp-tk__name">{card.name}</span>
        {card.status === "live" ? (
          <span className="sp-tk__live">
            <LiveDot />
            Live
          </span>
        ) : (
          <span className="sp-tk__status">{card.status}</span>
        )}
      </div>
      <div className="sp-tk__primary">
        {card.status === "news" ? (
          <>
            <span className="sp-tk__newsic">
              <NewsIcon />
            </span>
            {card.news ? (
              <a className="sp-tk__newstx" href={card.news.url} target="_blank" rel="noreferrer">
                {card.news.title}
              </a>
            ) : (
              <span className="sp-tk__newstx">No recent news</span>
            )}
          </>
        ) : (
          <span className="sp-tk__score">{card.primary}</span>
        )}
      </div>
      <div className="sp-tk__meta">
        {card.standing ? <span className="sp-tk__standing">{card.standing}</span> : null}
        <FormPips form={card.form} />
      </div>
      {card.nextMatch ? (
        <div className="sp-tk__next">{formatNextMatch(card.nextMatch, locale)}</div>
      ) : null}
    </article>
  );
}
```

- [ ] **Step 4: Write the ticker CSS**

Create `apps/web/src/styles/sports-4-grid.css` with this content (grid/hero sections are appended by Tasks 2–4):

```css
/* Sports broadsheet skin (#829, child of epic #726) — ticker + hairline editorial grid.
   Tokens only: colors via var(--*), spacing via --space-*, type via --text-*. */

/* ============================================================= TICKER */
.sp-ticker {
  position: relative;
  display: flex;
  align-items: stretch;
  gap: var(--space-2);
  margin-top: var(--space-4);
  border-top: 2px solid var(--border);
  border-bottom: 1px solid var(--border-subtle);
}
.sp-ticker__scroll {
  flex: 1;
  min-width: 0;
  display: flex;
  overflow-x: auto;
  scrollbar-width: thin;
  /* overflow affordance: content fades at the right edge instead of clipping hard */
  mask-image: linear-gradient(to right, black calc(100% - 32px), transparent);
}
.sp-ticker__scroll:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}
.sp-tk {
  flex: none;
  width: 232px;
  padding: var(--space-3) var(--space-4);
  border-right: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.sp-tk--league {
  width: auto;
  max-width: 232px;
  justify-content: center;
}
.sp-tk__eyebrow {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-subtle);
}
.sp-tk__leagues {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
}
.sp-tk__leaguename {
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
}
.sp-tk__hd {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.sp-tk__name {
  flex: 1;
  min-width: 0;
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-tk__live {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent-fg);
}
.sp-tk__status {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}
.sp-tk__primary {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-height: 20px;
}
.sp-tk__score {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--text-md);
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
}
.sp-tk__newsic {
  flex: none;
  color: var(--steel);
  display: inline-flex;
}
.sp-tk__newstx {
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  line-height: 1.35;
  color: var(--text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sp-tk__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.sp-tk__standing {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  letter-spacing: 0.02em;
  color: var(--text-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-tk__next {
  font-family: var(--font-sans);
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sp-ticker__manage {
  flex: none;
  align-self: center;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--accent-fg);
  text-decoration: none;
  padding: var(--space-1) var(--space-2);
}
.sp-ticker__manage:hover {
  background: var(--forest-soft);
}
@media (max-width: 768px) {
  .sp-tk {
    width: 200px;
  }
}
```

- [ ] **Step 5: Wire the ticker into the page**

In `apps/web/src/sports/sports-page.tsx`:

1. Add imports: `import "../styles/sports-4-grid.css";` (after the two existing CSS imports) and `import { SportsTicker } from "./sports-ticker";`.
2. Delete `formatNextMatch` (lines 32–38) and the now-unused imports it strands: `FollowedLeagueRef`, `FollowedNextMatch`, `FollowedTeamCard`, `LocaleSettingsDto`, `formatDate`, `formatTime`, `useUserLocale`, `Crest`, `FormPips`, `NewsIcon`, `CalendarIcon`/`TrophyIcon` **only if** no remaining use (TrophyIcon is still used by `EmptyState`; CalendarIcon by `GamedayHero` — keep those).
3. Delete `FollowedSection`, `FollowedLeaguesSection`, and `FollowedCard` (lines 216–315).
4. Replace the `hasFollows` render block (lines 97–110) with the ticker-first order:

```tsx
{
  hasFollows ? (
    <>
      <SportsTicker followed={data.followed} leagues={data.followedLeagues} />
      <Hero hero={data.hero} />
      <SplitSection data={data} followedPairs={followedPairs} />
      <LeagueNewsSection groups={data.leagueNews} />
    </>
  ) : (
    <EmptyState data={data} followedPairs={followedPairs} />
  );
}
```

Keep `hasTeamFollows`/`hasLeagueFollows`/`hasFollows` (lines 88–90) exactly as-is — that is the #763 regression lock; only the two-section conditional goes away because the ticker renders both kinds.

- [ ] **Step 6: Update the page tests**

In `tests/unit/sports-page.test.tsx`:

- Test `"renders the followed-team card with form pips and next match"` (line 173): rename to `"renders the followed-team ticker block with form pips and next match"` and add `expect(html).toContain("sp-ticker");` — the content assertions (`"MIN 21 – 14 DAL"`, `"sp-formpip"`, `"vs Green Bay Packers"`) stay unchanged.
- Test `"renders a news-status card as a link to the story"` (line 180): assertions unchanged (href + title survive in the ticker); rename "card" → "ticker block".
- Test `"shows a distinct leagues header (not the empty-state CTA) for a league-only follower"` (line 322): all existing assertions (`"Following"`, `"1 league"`, `"Premier League"`, not-CTA) still hold against `LeagueBlocks`; add `expect(html).toContain("sp-tk--league");`.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run tests/unit/sports-ticker.test.tsx tests/unit/sports-page.test.tsx`
Expected: PASS (all suites)

- [ ] **Step 8: Delete the replaced card CSS**

In `apps/web/src/styles/sports-1.css` delete these rule blocks (now dead — verify each selector has zero remaining matches with `grep -rn "sp-fc\|sp-fcgrid" apps/web/src --include='*.tsx'` first, expect no output):

- `.sp-fcgrid`, `.sp-fc`, `.sp-fc__hd`, `.sp-fc__id`, `.sp-fc__name`, `.sp-fc__comp`, `.sp-fc__primary`, `.sp-fc__resscore`, `.sp-fc__newsic`, `.sp-fc__newstx`, `.sp-fc__form`, `.sp-fc__standing`, `.sp-fc__standing svg`, `.sp-fc__formrow`, `.sp-fc__next`, `.sp-fc__nextlbl`, `.sp-fc__nextlbl svg`, `.sp-fc__nextmatch` (lines 356–525)
- `.sp-tag`, `.sp-tag--live`, `.sp-tag--today`, `.sp-tag--news` (lines 397–423) — the ticker's plain `sp-tk__status` replaces the pill tags

Keep `.sp-formpip*` (used by ticker), `.sp-crest*`, `.sp-livedot`/`.sp-live`, `.sp-chips`/`.sp-chip` (scoreboard filter still uses them).

- [ ] **Step 9: Run the gates**

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`
Expected: all exit 0 (`sports-1.css` now well under the cap)

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/sports/sports-ticker.tsx apps/web/src/sports/sports-page.tsx apps/web/src/styles/sports-4-grid.css apps/web/src/styles/sports-1.css tests/unit/sports-ticker.test.tsx tests/unit/sports-page.test.tsx
git commit -m "feat(sports): followed-teams ticker strip replaces card grid (#829)

Your followed teams and leagues now appear as a dense scoreboard strip at
the top of the Sports page — scores, form, standing, and next match at a
glance, like a newspaper ticker.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Edge-to-edge hero with broadsheet typography

Strip the hero's card container; it becomes a full-width block sitting on hairlines directly under the ticker, with `--text-5xl` scores and `--text-4xl` headlines. Adds the scoped `aria-live` (hero score only, `polite` — per the amendment recorded on issue #829).

**Files:**

- Modify: `apps/web/src/styles/sports-1.css` (hero block, lines 116–305 in the original file)
- Modify: `apps/web/src/sports/sports-page.tsx` (`GamedayHero`, score div at line 177)
- Modify: `tests/unit/sports-page.test.tsx` (gameday hero test, line 163)

**Interfaces:**

- Consumes: `.sp-hero` markup from `GamedayHero`/`StoryHero` (class names unchanged).
- Produces: restyled `.sp-hero*` rules; `aria-live="polite"` on `.sp-hero__score` when the game is live. No API changes for later tasks.

- [ ] **Step 1: Extend the failing test**

In `tests/unit/sports-page.test.tsx`, in `"renders the gameday hero with the rationale, both teams, and scores"` (line 163), add:

```tsx
expect(html).toContain('aria-live="polite"');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx`
Expected: FAIL on the new assertion only

- [ ] **Step 3: Add the scoped live region**

In `apps/web/src/sports/sports-page.tsx`, `GamedayHero`, change the score container (line 177):

```tsx
<div
  className="sp-hero__score"
  aria-live={game.state === "live" ? "polite" : undefined}
  aria-atomic="true"
>
```

(Only the hero score is a live region — announcing the whole 60s-polled scoreboard would spam screen readers.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx`
Expected: PASS

- [ ] **Step 5: Restyle the hero CSS**

In `apps/web/src/styles/sports-1.css`, apply these edits to the hero section:

```css
/* was: border + radius + surface card */
.sp-hero {
  margin-top: 0;
  border: none;
  border-bottom: 2px solid var(--border);
  border-radius: 0;
  background: none;
  padding: var(--space-6) 0;
}
.sp-hero--live {
  background: none;
  border-color: var(--border);
}
```

and scale the type (same blocks, replace the literal sizes):

- `.sp-hero__score .n` → `font-size: var(--text-5xl);`
- `.sp-hero__score .dash` → `font-size: var(--text-2xl);`
- `.sp-hero__team` → `font-size: var(--text-md);`
- `.sp-hero__headline` → `font-size: var(--text-4xl); line-height: 1.08;`
- `.sp-hero__dek` → `font-size: var(--text-lg);`
- `.sp-hero__comp`, `.sp-hero__phase` → `font-size: var(--text-2xs);`
- `.sp-hero__note` → `font-size: var(--text-md);`
- `.sp-hero__also` → `font-size: var(--text-sm);`
- Spacing sweep within the hero block: `gap: 12px` → `var(--space-3)`, `gap: 20px` → `var(--space-5)`, `margin: 18px 0 6px` → `var(--space-4) 0 var(--space-1)`, `gap: 14px`/`margin-top: 14px`/`padding-top: 14px` → `var(--space-4)`, `margin-top: 12px` → `var(--space-3)`, `margin: 12px 0 0` → `var(--space-3) 0 0`, `margin: 10px 0 0` → `var(--space-2) 0 0`, `gap: 10px` → `var(--space-2)`, `gap: 8px` → `var(--space-2)`, `gap: 6px` → `var(--space-1)`.
- `.sp-photo`, `.sp-photo--herostory`: replace `border-radius: var(--radius-lg)` with `border-radius: 0;` (broadsheet photos are square-cut), keep the striped placeholder pattern.

- [ ] **Step 6: Run the gates**

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`
Expected: all exit 0

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/styles/sports-1.css apps/web/src/sports/sports-page.tsx tests/unit/sports-page.test.tsx
git commit -m "feat(sports): edge-to-edge hero with broadsheet type scale (#829)

The lead game or story now spans the full page width with a large
newspaper-style score and headline, and live scores are announced to
screen readers as they update.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Hairline editorial grid (scoreboard, headlines rail, standings)

Replace every remaining card container below the hero with hairline rules: game rows become boxless list rows separated by hairlines, the rail column is demarcated by a vertical keyline, section heads get a heavy top rule. Mobile (<768px) collapses to one column; the vertical keyline becomes horizontal rules.

**Files:**

- Modify: `apps/web/src/styles/sports-1.css` (split/scoreboard/rail/standings sections, original lines 527–910)
- Modify: `apps/web/src/styles/sports-4-grid.css` (append grid rules)
- Modify: `apps/web/src/styles/sports-3.css` (news-card rules, lines 38–61)

**Interfaces:**

- Consumes: existing markup/class names from `SplitSection`, `Scoreboard`, `GameRow`, `StandingsRail`, `TopStoriesRail`, `LeagueNewsSection` — **no JSX changes in this task**.
- Produces: the final grid look; Task 4 reuses the `.sp-rule-head` pattern defined here.

- [ ] **Step 1: Append grid rules to `sports-4-grid.css`**

```css
/* ============================================================= EDITORIAL GRID */
.sp-split {
  grid-template-columns: 1fr 316px;
  gap: 0;
}
.sp-railcol {
  border-left: 1px solid var(--border-subtle);
  padding-left: var(--space-6);
  margin-left: var(--space-6);
}
@media (max-width: 900px) {
  .sp-railcol {
    border-left: none;
    border-top: 1px solid var(--border-subtle);
    padding-left: 0;
    margin-left: 0;
    padding-top: var(--space-6);
    margin-top: var(--space-6);
  }
}
/* Heavy section rule — the broadsheet section header pattern (reused by Task 4 states). */
.sp-rule-head {
  border-top: 2px solid var(--border);
  padding-top: var(--space-2);
}
/* Broadsheet rank numerals on the headlines rail (NYT-mockup "1. 2. 3." treatment). */
.sp-rail__list {
  counter-reset: sp-hl;
}
.sp-rail__list .sp-hl__title::before {
  counter-increment: sp-hl;
  content: counter(sp-hl) ". ";
  font-family: var(--font-display);
  font-weight: 700;
  color: var(--text);
}
```

- [ ] **Step 2: Restyle rows and rails in `sports-1.css`**

- `.sp-game`: delete `border`, `border-radius`, `background`; replace `padding: 10px 12px` with `padding: var(--space-2) 0;` and add `border-top: 1px solid var(--border-subtle);`.
- `.sp-game--you`: delete `border-color`; keep `background: var(--forest-soft);` and add `padding-left: var(--space-2); padding-right: var(--space-2);` (a committed color field, per Park Press, marks your teams — no border box needed).
- `.sp-boardgrp__games`: change to `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0 var(--space-6); margin-top: 0;`.
- `.sp-boardgrp__hd`: replace `border-bottom: 1px solid var(--border)` with `border-bottom: 2px solid var(--border);` (heavy rule under league names).
- `.sp-rail`, `.sp-standings`: delete `border`, `border-radius`, `background`; set `padding: 0;` and add `border-top: 2px solid var(--border);`.
- `.sp-hl`: replace `padding: 12px 15px` with `padding: var(--space-3) 0;`; `.sp-hl:hover` background → `var(--surface-2)` stays.
- `.sp-rail__hd`, `.sp-standings__hd`: replace px paddings with `padding: var(--space-3) 0 var(--space-2);`.
- Fractional/literal type sweep across these sections using the Global Constraints mapping — every `font-size` in `.sp-chip`, `.sp-game*`, `.sp-hl*`, `.sp-tbl*`, `.sp-boardgrp__hd .nm`, `.sp-standings*`, `.sp-sec__title`, `.sp-managebtn`, `.sp-title`, `.sp-lede`, `.sp-live`, `.sp-photo__cap`, `.sp-crest--*` becomes a `--text-*` token (e.g. `9.5px`/`10px`/`10.5px`/`11px`/`11.5px` → `var(--text-2xs)`, `12.5px` → `var(--text-xs)`, `14.5px` → `var(--text-md)`, `34px` → `var(--text-4xl)`).
- Spacing sweep in the same sections: all `margin`/`padding`/`gap` literals → nearest `--space-*` per the Global Constraints mapping (`gap: 3px` → `var(--space-1)`, `gap: 5px`/`6px` → `var(--space-1)`, `gap: 8px` → `var(--space-2)`, `gap: 10px` → `var(--space-2)`, `margin-top: 30px` → `var(--space-7)`, `gap: 30px` → `var(--space-7)`, `gap: 20px` → `var(--space-5)`, `gap: 16px` → `var(--space-4)`).
- `.sp-wrap`: `padding: 30px 40px 110px` → `padding: var(--space-7) var(--space-8) var(--space-11);`.

- [ ] **Step 3: De-card the news grid in `sports-3.css`**

`.sp-news__card`: delete `background`, `border`, `border-radius`; replace `padding: 12px` with `padding: var(--space-3) 0;` and add `border-top: 1px solid var(--border-subtle);`. `.sp-news__card:hover`: replace both declarations with `background: var(--surface-2);`. `.sp-news__img`: `border-radius: 0;`. `.sp-news__grid`: `gap: 0 var(--space-6);`.

- [ ] **Step 4: Verify no literal spacing/type remains in the swept sections**

Run: `grep -nE "font-size: [0-9]|gap: [0-9]|padding: [0-9]|margin(-top)?: [0-9]" apps/web/src/styles/sports-1.css apps/web/src/styles/sports-3.css apps/web/src/styles/sports-4-grid.css | grep -v "0;" | grep -v "1px" | grep -v "2px solid"`
Expected: no output (crest/livedot intrinsic `width`/`height`/`min-width`/`min-height` literals are fine and not matched by this pattern)

- [ ] **Step 5: Run the gates**

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`
Expected: all exit 0 (unit tests assert content/classes, not the removed box styles — no test churn expected; if one fails, fix the assertion to the new class, never by re-adding box styles)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/styles/sports-1.css apps/web/src/styles/sports-3.css apps/web/src/styles/sports-4-grid.css
git commit -m "feat(sports): hairline editorial grid replaces floating cards (#829)

Scores, headlines, and standings now sit on a clean newspaper-style
keyline grid instead of separate bordered cards, with consistent
spacing and type sizes throughout.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Empty / degraded / skeleton states in the new aesthetic

Same authored behavior (that's the #765/#811 lock), new clothes: hairline rules instead of `var(--surface-2)` containers, skeleton shapes matching the ticker + hero + grid rhythm.

**Files:**

- Modify: `apps/web/src/styles/sports-1.css` (empty-state block, original lines 912–985)
- Modify: `apps/web/src/styles/sports-3.css` (`.sp-degraded`, `.sp-skel*`)
- Modify: `apps/web/src/sports/sports-page.tsx` (`SportsSkeleton` shapes only)
- Modify: `tests/unit/sports-page.test.tsx`

**Interfaces:**

- Consumes: `.sp-rule-head` from Task 3; existing `EmptyState`/`DegradedBand` markup unchanged.
- Produces: final state styling. `SportsSkeleton` renders classes `sp-skel--ticker`, `sp-skel--hero`, `sp-skel--row`.

- [ ] **Step 1: Write the failing test**

In `tests/unit/sports-page.test.tsx`, add to the existing loading-state coverage (or as a new test in the root describe if none asserts the skeleton):

```tsx
it("renders a ticker-shaped skeleton row while loading", () => {
  const client = new QueryClient(); // nothing primed → loading branch
  const html = renderToString(
    createElement(QueryClientProvider, { client }, createElement(SportsPage))
  );
  expect(html).toContain("sp-skel--ticker");
  expect(html).toContain("sp-skel--hero");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx`
Expected: FAIL — `sp-skel--ticker` not found

- [ ] **Step 3: Update `SportsSkeleton`**

In `apps/web/src/sports/sports-page.tsx`:

```tsx
function SportsSkeleton() {
  return (
    <div className="sp-skeleton" role="status" aria-label="Loading your teams">
      <div className="sp-skel sp-skel--ticker" aria-hidden="true" />
      <div className="sp-skel sp-skel--hero" aria-hidden="true" />
      <div className="sp-skel sp-skel--row" aria-hidden="true" />
      <div className="sp-skel sp-skel--row" aria-hidden="true" />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/sports-page.test.tsx`
Expected: PASS

- [ ] **Step 5: Restyle the states**

In `sports-3.css`:

```css
/* Degraded-source notice (#765 M1) — hairline treatment, same copy and role="status". */
.sp-degraded {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  color: var(--text-muted);
  padding: var(--space-1) 0 var(--space-1) var(--space-2);
  border-radius: 0;
  background: none;
  border: none;
  border-left: 2px solid var(--warn);
}
```

(A straight 2px functional status rule — not the banned curved/rounded card accent; same family as the task-priority borders.)

```css
.sp-skel {
  border-radius: 0;
  background: var(--surface-2);
}
.sp-skel--ticker {
  height: 96px;
  border-top: 2px solid var(--border);
}
.sp-skel--hero {
  height: 180px;
}
.sp-skel--row {
  height: 64px;
  border-top: 1px solid var(--border-subtle);
}
```

In `sports-1.css` empty-state block: `.sp-empty__mark` → `border-radius: 0; background: none; border: 1px solid var(--border-subtle);`; `.sp-empty__title` → `font-size: var(--text-2xl);`; `.sp-empty__lede` → `font-size: var(--text-md);`; `.sp-nofollow__btn` → `font-size: var(--text-xs); border-radius: 0;`; `.sp-emptyboard` → add `class` pairing: change `border-top: 1px solid var(--border-subtle)` to `border-top: 2px solid var(--border);` and spacing literals (`margin-top: 42px`, `padding-top: 30px`, `gap: 30px`, `margin: 16px auto 0`, `margin-bottom: 18px`, `margin: 12px 0 20px`, `padding: 6px 11px`) to the nearest `--space-*` tokens per the Global Constraints mapping.

- [ ] **Step 6: Run the gates**

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm typecheck && pnpm test:unit`
Expected: all exit 0

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/styles/sports-1.css apps/web/src/styles/sports-3.css apps/web/src/sports/sports-page.tsx tests/unit/sports-page.test.tsx
git commit -m "feat(sports): loading, empty, and degraded states join the broadsheet look (#829)

The Sports page's loading placeholders, first-run screen, and outage
notice now match the new newspaper layout instead of the old card style.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Regression sweep + layout verification

Nothing new is built here; this task proves spec §5 and §6 with executable layout assertions.

**Files:**

- Test: full suites + live DOM/computed-style assertions (no source changes expected; fixes found here fold back into the owning file)

**Interfaces:**

- Consumes: everything above.
- Produces: green `verify:foundation`-equivalent run, light/dark/mobile layout assertions, checked-off spec §5 checklist in the PR description.

- [ ] **Step 1: Functional regression greps (spec §5)**

Run each; expected output noted:

```bash
grep -n "refetchInterval" apps/web/src/sports/sports-page.tsx        # hasLiveGame-gated interval present (#796)
grep -n "hasLeagueFollows" apps/web/src/sports/sports-page.tsx       # league follows in hasFollows (#763)
grep -n "sp-degraded" apps/web/src/sports/sports-page.tsx            # degraded band renders (#765)
grep -n "hasSlate" apps/web/src/sports/sports-page.tsx               # zero-follow slate branch (#811)
grep -rn "competitionKey.toUpperCase" apps/web/src                   # expect: no output (M4 stays dead)
grep -n "prefers-reduced-motion" apps/web/src/styles/sports-1.css apps/web/src/styles/sports-3.css  # both guards intact
```

- [ ] **Step 2: Full unit + frontend gate**

Run: `pnpm lint && pnpm format:check && pnpm check:file-size && pnpm check:design-tokens && pnpm check:no-ambient-dates && pnpm check:package-deps && pnpm typecheck && pnpm test:unit`
Expected: exit 0. (Skip `test:integration` unless backend files changed — they must not have; per the multi-agent Postgres-contention rule, frontend-only QA scopes to the frontend gate.)

- [ ] **Step 3: Browser layout assertion sweep**

Run focused Playwright assertions against `/sports` in light **and** dark theme. Checklist:

- Ticker: hairline top rule, blocks separated by vertical hairlines, right-edge fade visible when overflowing, focus ring on tab.
- Hero: no card box; `--text-5xl` score; 2px bottom rule.
- Grid: rail keyline visible in dark theme (hairline contrast); `--forest-soft` field on followed games readable in both themes.
- Mobile (<768px viewport in the harness): single column, keylines rotated to horizontal rules, no horizontal page scroll (ticker scrolls internally only).
- Reduced motion: with `prefers-reduced-motion: reduce` emulated, live dot and skeleton do not animate.

- [ ] **Step 4: Fix anything the sweep catches, re-run Steps 2–3 until clean**

Fold fixes into the file that owns them; amend nothing — new commit per fix with the same gate.

- [ ] **Step 5: Final commit + PR**

```bash
git add -u  # worktree is exclusively ours; still verify with git status first
git commit -m "chore(sports): broadsheet skin verification sweep (#829)

No user-visible change beyond the redesign itself — this finalizes
browser-verified polish for the new Sports layout.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Open the PR against `main` with: the user-facing summary ("The Sports page has a new dense, newspaper-style layout…"), the spec §5 checklist ticked with assertion evidence links, and "Closes #829".

---

## Self-Review Notes

- **Spec coverage:** §1 typography/spacing → Tasks 2–4 sweeps + Global Constraints mapping; §2.1 ticker → Task 1; §2.2 grid + hero + responsive → Tasks 2–3; §3 states + a11y (`aria-live`, keyboard ticker, reduced-motion) → Tasks 1, 2, 4, 5; §4 file split → Task 1 (create `sports-4-grid.css`, delete card CSS from `sports-1.css`); §5/§6 → Task 5.
- **Known judgment calls recorded:** status pill tags replaced by plain mono ticker status text (pills are a card-era device); square-cut photos; `--text-2xs` (11px) as the type floor — nothing under 11px survives, which slightly **raises** the old 9–10px micro type for a11y.
- **Type consistency check:** `SportsTicker` props match `data.followed` (`FollowedTeamCard[]`) and `data.followedLeagues` (`FollowedLeagueRef[]`) from `SportsOverviewResponse`; `formatNextMatch` signature unchanged from `sports-page.tsx:33`.
