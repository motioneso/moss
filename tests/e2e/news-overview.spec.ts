import { expect, test } from "@playwright/test";

import { mockApi } from "./mock-api.js";
import { newsOverviewFixture, registerMockNewsRoutes } from "./mock-news-api.js";

// #899: mocked e2e for the /news overview page shipped in PR #898. All /api/news/* traffic is
// fulfilled locally — no live RSS, model, or worker. reducedMotion disables the hero carousel's
// 7s auto-advance so slide state only changes when the test clicks. Deliberately no assertions
// on window-focus refetch (not provably wired in Playwright) and no screenshots (repo standard).

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
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
  await expect(
    page.getByRole("region", { name: "Today's stories" }).getByText("Browser ships tab groups sync")
  ).toBeVisible();

  await mast.getByRole("button", { name: "All" }).click();
  await expect(page.locator(".nw-grid__rail")).toContainText("Markets steady after rate decision");
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
