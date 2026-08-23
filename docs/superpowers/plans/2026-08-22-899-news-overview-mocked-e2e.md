# #899 Mocked /news Overview E2E Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Plain English rule (carry this into every spawn prompt):** status updates and anything Ben reads must be in plain English — name things by what they do, keep exact identifiers only where he must act on them, no coined shorthand, plain ASCII punctuation.

**Goal:** Add a deterministic, fully mocked Playwright e2e suite for the `/news` overview page (hero carousel, mosaic, topic filter, degraded/empty/error states) so the page that shipped in PR #898 has automated browser coverage without any live RSS fetch.

**Architecture:** The real `NewsPage` component (`packages/news/src/web/news-page.tsx`) is compiled into the web app through the `virtual:moss-module-web` scan, so the existing e2e vite server already serves the real page at `/news`. Coverage therefore needs only (a) a shared mock fixture file `tests/e2e/mock-news-api.ts` that fulfills the `/api/news/*` routes with typed `@moss/shared` fixtures, and (b) a spec `tests/e2e/news-overview.spec.ts` that drives the page through its states. No application code changes.

**Tech Stack:** Playwright (`@playwright/test`), existing `mockApi()` harness (`tests/e2e/mock-api.ts`), `@moss/shared` news contract types.

**Spec:** Issue #899 body + its audit comment (2026-08-12) are the spec. Parent feature spec: `docs/superpowers/specs/2026-07-08-news-module.md`. This is test-only coverage for an already-shipped, already-specced page — no new design spec is required under the "Spec before build" gate (no new feature, no new UI).

## Scope rulings (read first)

1. **Screenshots are OUT of scope.** The issue's second bullet ("add `/news` to the `pnpm capture:screens` harness") was removed by the 2026-08-12 audit comment, and the issue title now says so. The capture harness no longer exists in the repo (no `capture` script in any package.json), and the repo standard forbids screenshot evidence (`docs/DEVELOPMENT_STANDARDS.md:55`; commit 2852a12c3 "docs: drop screenshot requirement from Live-Path Gate"). This plan's screenshot coverage is exactly this ruling: none, by standing policy. Do not resurrect the harness.
2. **Do NOT add news to the default fixtures in `tests/e2e/mock-modules.ts`.** The issue offers "mock-modules.ts / a mock-news-api.ts" as alternatives. Changing `modulesResponse`/`myModulesResponse` alters the default nav for every existing spec (app-shell, settings-shell, onboarding, …) and risks breaking their nav assertions. Keep everything news-specific in the new `tests/e2e/mock-news-api.ts`, mirroring how `mock-sports-api.ts` and `news-settings.spec.ts` stayed out of the shared defaults.
3. **Do not assert on focus-triggered refetch.** TanStack Query's window-focus refetch is not provably wired in Playwright (a fake focus event never reaches the network); the page relies on it deliberately (comment in `news-page.tsx`). Assert only on initial-load renders and explicit interactions.
4. **Determinism:** the hero carousel auto-advances every 7s unless `prefers-reduced-motion: reduce`, so the spec sets Playwright's `reducedMotion: "reduce"` — slides then move only when the test clicks. Fixtures use fixed ISO `publishedAt` strings; nothing on the page renders relative time, so fixed instants are safe. `imageUrl` is `null` except where a test needs art, and those use a data: URI so no network image fetch occurs.
5. **No DB, no verify-gate needed for the scoped run.** `pnpm test:e2e` boots only the vite dev server (`playwright.config.ts` webServer); a scoped run of this one spec touches no database. The full `pnpm verify:foundation` gate still requires the `verify-gate` skill as always.
6. **Local hook: never pipe a test command's output.** A `pnpm test:e2e ... | grep ...` pipeline masks the exit code and a repo hook blocks it. Always run tests with `> /tmp/<name>.log 2>&1; echo "EXIT=$?"`, then grep the log file.

## Global Constraints

- Plain Fastify REST + shared contracts: fixtures must be typed as `NewsOverviewResponse` / `NewsSourceGroup` / `NewsHeadline` imported from `@moss/shared` — no ad-hoc shapes.
- Module isolation: test files import only from `@moss/shared`, Playwright, and sibling `tests/e2e/` helpers; never from `packages/news/src/*` internals.
- e2e idiom: use `page.route("**/api/...")` fulfillment like every other `tests/e2e/mock-*.ts`; base state comes from `mockApi(page, {...})`.
- The suite must pass with `--repeat-each=2` locally (flake check) and inside CI's e2e step.
- No application/source changes anywhere under `packages/` or `apps/` — tests only.

---

### Task 1: Shared news mock — `tests/e2e/mock-news-api.ts`

**Files:**
- Create: `tests/e2e/mock-news-api.ts`

**Interfaces:**
- Consumes: `NewsEnabledSource`, `NewsHeadline`, `NewsOverviewResponse`, `NewsSourceGroup` from `@moss/shared`; `modulesResponse`, `myModulesResponse` from `./mock-modules.js`; Playwright `Page`.
- Produces (exact exports Task 2 relies on):
  - `export const NEWS_MODULE` — module descriptor with `id: "news"`, `navigation: [{ id: "news", label: "News", path: "/news", icon: "newspaper", order: 34 }]` (copy the literal from `tests/e2e/news-settings.spec.ts:11-18`).
  - `export const INLINE_IMG: string` — 1x1 data: URI PNG.
  - `export function newsHeadline(overrides?: Partial<NewsHeadline>): NewsHeadline` — deterministic single-headline builder.
  - `export function newsOverviewFixture(): NewsOverviewResponse` — the canonical loaded front page (exact content in Step 1).
  - `export async function registerMockNewsRoutes(page: Page, overview: NewsOverviewResponse): Promise<void>` — registers `**/api/modules` and `**/api/me/modules` (defaults **plus** news, active) and fulfills `**/api/news/overview` with `overview`, plus `**/api/news/catalog` and `**/api/news/prefs` so a test that follows the Settings link hits no unmocked route.

- [ ] **Step 1: Write the file**

```ts
import type { Page } from "@playwright/test";
import type {
  NewsEnabledSource,
  NewsHeadline,
  NewsOverviewResponse,
  NewsSourceGroup
} from "@moss/shared";

import { modulesResponse, myModulesResponse } from "./mock-modules.js";

// #899: shared fixture + route registration so the e2e suite covers /news without live RSS.
// Unlike mock-sports-api.ts (built for the since-removed capture harness and wired to nothing),
// this file exists to be consumed by news-overview.spec.ts. It deliberately does NOT touch the
// default fixtures in mock-modules.ts — adding news there would change the default nav under
// every existing spec.

export const NEWS_MODULE = {
  id: "news",
  name: "News",
  version: "0.1.0",
  lifecycle: "user-toggleable" as const,
  navigation: [{ id: "news", label: "News", path: "/news", icon: "newspaper", order: 34 }],
  settings: []
};

// 1x1 transparent PNG so "has art" tiles render without any network image request.
export const INLINE_IMG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

let seq = 0;
export function newsHeadline(overrides: Partial<NewsHeadline> = {}): NewsHeadline {
  seq += 1;
  return {
    id: `h-${seq}`,
    sourceKey: "bbc",
    sourceLabel: "BBC News",
    topicKey: null,
    topicLabel: null,
    title: `Default headline ${seq}`,
    url: `https://example.com/story-${seq}`,
    publishedAt: "2026-08-22T08:00:00Z",
    imageUrl: null,
    summary: "",
    ...overrides
  };
}

export function newsOverviewFixture(): NewsOverviewResponse {
  seq = 0;
  const world = { topicKey: "world", topicLabel: "World", topicLabels: ["World"] };
  const tech = {
    topicKey: "technology",
    topicLabel: "Technology",
    topicLabels: ["Technology"]
  };
  const bbc: NewsHeadline[] = [
    newsHeadline({
      ...world,
      title: "Summit reaches climate accord",
      summary: "Delegates agreed a binding emissions framework overnight.",
      imageUrl: INLINE_IMG
    }),
    newsHeadline({ ...world, title: "Markets steady after rate decision" }),
    newsHeadline({ ...tech, title: "Chipmaker unveils desktop accelerator" })
  ];
  const verge: NewsHeadline[] = [
    newsHeadline({
      ...tech,
      sourceKey: "verge",
      sourceLabel: "The Verge",
      title: "Hands-on with the new folding phone",
      summary: "A week with the hinge that finally disappears.",
      imageUrl: INLINE_IMG
    }),
    newsHeadline({
      ...tech,
      sourceKey: "verge",
      sourceLabel: "The Verge",
      title: "Browser ships tab groups sync"
    }),
    newsHeadline({
      ...world,
      sourceKey: "verge",
      sourceLabel: "The Verge",
      title: "Satellite internet reaches the archipelago"
    })
  ];
  const sourceGroups: NewsSourceGroup[] = [
    {
      sourceKey: "bbc",
      sourceLabel: "BBC News",
      homepageUrl: "https://www.bbc.com/news",
      headlines: bbc
    },
    {
      sourceKey: "verge",
      sourceLabel: "The Verge",
      homepageUrl: "https://www.theverge.com",
      headlines: verge
    }
  ];
  const enabledSources: NewsEnabledSource[] = [
    { sourceKey: "bbc", label: "BBC News" },
    { sourceKey: "verge", label: "The Verge" }
  ];
  return {
    topStories: [bbc[0], verge[0], bbc[1]],
    sourceGroups,
    activeTopics: ["world", "technology"],
    enabledSources,
    degraded: false
  };
}

export async function registerMockNewsRoutes(
  page: Page,
  overview: NewsOverviewResponse
): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
  await page.route("**/api/modules", (route) =>
    route.fulfill(json({ modules: [...modulesResponse.modules, NEWS_MODULE] }))
  );
  await page.route("**/api/me/modules", (route) =>
    route.fulfill(
      json({
        modules: [
          ...myModulesResponse.modules,
          {
            ...NEWS_MODULE,
            required: false,
            supportsUserDisable: true,
            instanceDisabled: false,
            userDisabled: false,
            active: true,
            hasPreferences: false,
            hasUserCredentials: false
          }
        ]
      })
    )
  );
  await page.route("**/api/news/overview", (route) => route.fulfill(json(overview)));
  await page.route("**/api/news/catalog", (route) =>
    route.fulfill(
      json({
        sources: [
          {
            sourceKey: "bbc",
            label: "BBC News",
            homepageUrl: "https://www.bbc.com/news",
            defaultEnabled: true,
            topics: ["world"]
          }
        ],
        topics: [{ topicKey: "world", label: "World" }]
      })
    )
  );
  await page.route("**/api/news/prefs", (route) => route.fulfill(json({ prefs: [] })));
}
```

Implementer notes:
- If typecheck complains that `NEWS_MODULE` doesn't satisfy a modules DTO type, type it exactly the way `news-settings.spec.ts` does (bare object literal) — match that file rather than inventing a type import.
- If `myModulesResponse.modules` entries carry fields not shown above, spread each existing entry unchanged and only append the news entry — the goal is defaults + news, byte-compatible with what the shell expects.
- `newsOverviewFixture()` resets `seq` so ids are stable run-to-run (`h-1`…`h-6`); tests key on titles, never on ids.

- [ ] **Step 2: Typecheck the new file**

Run the repo's existing check that covers `tests/e2e` (see how `pnpm typecheck` / `pnpm lint` scope it), redirecting to a log:

```bash
pnpm typecheck > /tmp/899-typecheck.log 2>&1; echo "EXIT=$?"
grep -E "mock-news|news-overview" /tmp/899-typecheck.log || echo CLEAN
```

Expected: `EXIT=0` and `CLEAN`.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/mock-news-api.ts
git commit -m "test(news): add shared mocked news API fixtures for e2e (#899)"
```

(This branch's worktree is isolated. If executing in the shared checkout instead, use the `shared-checkout` skill before any commit; path-scoped `git add` only, never `git add -A`.)

### Task 2: Overview spec — `tests/e2e/news-overview.spec.ts`

**Files:**
- Create: `tests/e2e/news-overview.spec.ts`

**Interfaces:**
- Consumes: `mockApi` from `./mock-api.js`; `newsOverviewFixture`, `registerMockNewsRoutes` from `./mock-news-api.js`.
- Produces: nothing downstream; this is the leaf deliverable.

- [ ] **Step 1: Write the spec**

```ts
import { expect, test } from "@playwright/test";

import { mockApi } from "./mock-api.js";
import { newsOverviewFixture, registerMockNewsRoutes } from "./mock-news-api.js";

// #899: mocked e2e for the /news overview page shipped in PR #898. All /api/news/* traffic is
// fulfilled locally — no live RSS, model, or worker. reducedMotion disables the hero carousel's
// 7s auto-advance so slide state only changes when the test clicks. Deliberately no assertions
// on window-focus refetch (not provably wired in Playwright) and no screenshots (repo standard).

test.use({ reducedMotion: "reduce" });

test.beforeEach(async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: [],
    notifications: [],
    tasks: []
  });
});

test("renders the loaded front page: masthead chips, hero, mosaic, source rail", async ({
  page
}) => {
  await registerMockNewsRoutes(page, newsOverviewFixture());
  await page.goto("/news");

  // Masthead: functional chips for the two followed topics plus All.
  const mast = page.getByRole("navigation", { name: "Filter by topic" });
  await expect(mast.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  await expect(mast.getByRole("button", { name: "World" })).toBeVisible();
  await expect(mast.getByRole("button", { name: "Technology" })).toBeVisible();

  // Hero carousel: first top story is the active slide; dots reflect 3 slides.
  const carousel = page.getByRole("region", { name: "Top stories" });
  await expect(carousel.locator(".nw-carousel__slide--active")).toContainText(
    "Summit reaches climate accord"
  );
  await expect(carousel.getByRole("button", { name: "Story 3 of 3" })).toBeVisible();

  // Mosaic band renders a non-carousel story exactly once (dedupe against the carousel).
  const band = page.getByRole("region", { name: "Today's stories" });
  await expect(band.getByText("Chipmaker unveils desktop accelerator")).toHaveCount(1);

  // Source rail: one group per source.
  await expect(page.locator(".nw-grid__rail")).toContainText("BBC News");
  await expect(page.locator(".nw-grid__rail")).toContainText("The Verge");

  // Not degraded: no incompleteness note.
  await expect(page.getByText("may be incomplete")).toHaveCount(0);
});

test("carousel dots switch the active slide on click", async ({ page }) => {
  await registerMockNewsRoutes(page, newsOverviewFixture());
  await page.goto("/news");
  const carousel = page.getByRole("region", { name: "Top stories" });
  await carousel.getByRole("button", { name: "Story 2 of 3" }).click();
  await expect(carousel.locator(".nw-carousel__slide--active")).toContainText(
    "Hands-on with the new folding phone"
  );
});

test("topic chip filters the page to matching stories; All restores", async ({ page }) => {
  await registerMockNewsRoutes(page, newsOverviewFixture());
  await page.goto("/news");
  const mast = page.getByRole("navigation", { name: "Filter by topic" });

  await mast.getByRole("button", { name: "Technology" }).click();
  await expect(mast.getByRole("button", { name: "Technology" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  // A world-only story disappears from the page; a technology story stays.
  await expect(page.getByText("Markets steady after rate decision")).toHaveCount(0);
  await expect(page.getByText("Browser ships tab groups sync")).toBeVisible();

  await mast.getByRole("button", { name: "All" }).click();
  await expect(page.getByText("Markets steady after rate decision")).toBeVisible();
});

test("degraded response shows the incompleteness note", async ({ page }) => {
  await registerMockNewsRoutes(page, { ...newsOverviewFixture(), degraded: true });
  await page.goto("/news");
  await expect(page.getByRole("status").filter({ hasText: "may be incomplete" })).toBeVisible();
});

test("no enabled sources: 'Choose your sources' empty state links to news settings", async ({
  page
}) => {
  await registerMockNewsRoutes(page, {
    topStories: [],
    sourceGroups: [],
    activeTopics: [],
    enabledSources: [],
    degraded: false
  });
  await page.goto("/news");
  await expect(page.getByRole("heading", { name: "Choose your sources" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Choose sources" })).toHaveAttribute(
    "href",
    "/settings?section=modules&module=news"
  );
});

test("sources enabled but no stories: 'Nothing on the wire' empty state", async ({ page }) => {
  await registerMockNewsRoutes(page, {
    topStories: [],
    sourceGroups: [],
    activeTopics: [],
    enabledSources: [{ sourceKey: "bbc", label: "BBC News" }],
    degraded: false
  });
  await page.goto("/news");
  await expect(page.getByRole("heading", { name: "Nothing on the wire" })).toBeVisible();
});

test("overview 500 shows the unavailable message, not a crash", async ({ page }) => {
  await registerMockNewsRoutes(page, newsOverviewFixture());
  await page.route("**/api/news/overview", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
  );
  await page.goto("/news");
  await expect(page.getByText("News is unavailable right now.")).toBeVisible();
});

test("News appears in the primary nav and navigates to /news", async ({ page }) => {
  await registerMockNewsRoutes(page, newsOverviewFixture());
  await page.goto("/");
  await page.getByRole("link", { name: "News" }).click();
  await expect(page).toHaveURL(/\/news$/);
  await expect(page.getByRole("region", { name: "Top stories" })).toBeVisible();
});
```

Implementer notes (verify, don't assume):
- **Route layering:** later `page.route` registrations take precedence in Playwright, so the 500 test's re-route of `**/api/news/overview` wins over the one inside `registerMockNewsRoutes`. If the pinned Playwright version behaves otherwise, add an `overviewStatus` option to `registerMockNewsRoutes` instead.
- **Query retries:** if the 500 test times out because TanStack Query retries before surfacing the error, check the app's QueryClient `defaultOptions` (grep under `apps/web/src`). If retries are on, the persistent 500 route already covers every retry — raise only that one test's expect timeout; never add fixed sleeps.
- **Nav test:** if the sidebar link's accessible name isn't exactly "News" (icon + label composition), copy the locator pattern `app-shell.spec.ts` uses to click nav entries.
- **`getByText` strict mode:** if a headline title appears both in the mosaic and the rail's "In brief" tail, scope the assertion to a region (`.nw-grid__main`, the "Today's stories" band) instead of loosening to `.first()` — the "exactly once" assertion is a real dedupe check; keep it meaningful.

- [ ] **Step 2: Run the spec, expect green**

```bash
pnpm test:e2e tests/e2e/news-overview.spec.ts > /tmp/899-e2e.log 2>&1; echo "EXIT=$?"
tail -20 /tmp/899-e2e.log
```

Expected: `EXIT=0`, 8 passed. (First run boots vite on 127.0.0.1:4173 — no DB involved.)

- [ ] **Step 3: Flake check**

```bash
pnpm test:e2e tests/e2e/news-overview.spec.ts --repeat-each=2 > /tmp/899-e2e-repeat.log 2>&1; echo "EXIT=$?"
tail -5 /tmp/899-e2e-repeat.log
```

Expected: `EXIT=0`, 16 passed. If the carousel tests flake here, the reducedMotion setting isn't taking effect — fix that; never add waits.

- [ ] **Step 4: Confirm no live fetch escaped the mock**

```bash
grep -iE "bbc\.com|theverge\.com|rss" /tmp/899-e2e.log || echo NO-LIVE-FETCH
```

Expected: `NO-LIVE-FETCH`. (Fixture `homepageUrl`/`url` values are hrefs only; nothing navigates to them.)

- [ ] **Step 5: Regression sweep of neighboring specs**

```bash
pnpm test:e2e tests/e2e/news-settings.spec.ts tests/e2e/app-shell.spec.ts tests/e2e/settings-shell.spec.ts > /tmp/899-e2e-neighbors.log 2>&1; echo "EXIT=$?"
tail -5 /tmp/899-e2e-neighbors.log
```

Expected: `EXIT=0` — proves the new file changed no shared fixture behavior.

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/news-overview.spec.ts
git commit -m "test(news): mocked e2e coverage for the /news overview page (#899)"
```

### Task 3: PR, release note, issue close-out

**Files:**
- None modified by hand. (Release note: `Category: N/A` — the issue says explicitly this is not user-visible, so `docs/WHATS_NEW.md` is not touched and the append script is not run.)

- [ ] **Step 1: Open the PR against main**

Branch: `899-news-mocked-e2e`. Title: `test(news): mocked e2e coverage for /news overview (#899)`. Body must: link this plan file; state that screenshots are out of scope per the 2026-08-12 audit comment on #899 and the no-screenshot standard; fill the template's Release note section with `Category: N/A`.

- [ ] **Step 2: Evidence on the PR**

Test-only change, so the Live-Path Gate does not apply (nothing user-facing shipped). Paste the bounded tails of the green runs (Task 2 Steps 2, 3, 5) as text evidence — no screenshots.

- [ ] **Step 3: Merge and close**

Use `gh pr merge --squash --auto` (never `--admin` — blocked by ruleset). After merge, comment on #899: coverage bullet done; screenshot bullet closed as removed-from-scope (audit 2026-08-12). Close the issue.

## Acceptance

- `tests/e2e/mock-news-api.ts` and `tests/e2e/news-overview.spec.ts` exist; no changes under `packages/`, `apps/`, `scripts/`, or to `tests/e2e/mock-modules.ts` defaults.
- `pnpm test:e2e tests/e2e/news-overview.spec.ts --repeat-each=2` green locally; CI e2e step green on the PR.
- The 8 tests cover: loaded page composition, carousel interaction, topic filter round-trip, degraded banner, both empty states, error state, and the nav entry — with zero live network fetches and zero screenshots.
- Neighboring specs (news-settings, app-shell, settings-shell) still green.
- Issue #899 closed with the screenshot bullet explicitly recorded as out of scope, not silently dropped.
