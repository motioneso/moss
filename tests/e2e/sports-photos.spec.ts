import { test, expect, type Page } from "@playwright/test";
import type { Headline, SportsOverviewResponse } from "@moss/shared";

import { mockApi } from "./mock-api.js";
import { registerMockSportsRoutes, sportsOverviewFixture } from "./mock-sports-api.js";

// #2237 — a story from a custom source shows its photo, and that photo is served by Moss from
// its own address rather than fetched from the publisher by the browser.

const NARROW_STORY_ID = "source-a:narrow";
const WIDE_STORY_ID = "source-a:wide";

function customStory(id: string, title: string, width: number): Headline {
  return {
    id,
    sportKey: "football",
    competitionKey: "nfl",
    competitionLabel: "NFL",
    title,
    url: `https://publisher.example/${encodeURIComponent(id)}`,
    publishedAt: "2026-07-06T18:00:00Z",
    imageUrl: `/api/sports/headlines/${encodeURIComponent(id)}/photo`,
    imageWidth: width,
    imageHeight: Math.round((width * 9) / 16),
    summary: "A story from a source this reader added themselves.",
    teamKeys: [],
    publisherLabel: "Publisher",
    publisherDomain: "publisher.example"
  };
}

const overviewWithPhotos: SportsOverviewResponse = {
  ...sportsOverviewFixture,
  // Quiet day: the top-stories carousel owns the lead slot, so the lead slide is assertable.
  hero: { mode: "story", headline: null },
  topStories: [
    customStory(NARROW_STORY_ID, "Narrow photo story", 320),
    customStory(WIDE_STORY_ID, "Wide photo story", 1280)
  ]
};

async function gotoSports(page: Page): Promise<void> {
  await page.goto("/sports");
  await expect(page.getByRole("heading", { name: "Wide photo story" })).toBeVisible();
}

test.describe("Sports custom-source photos (#2237)", () => {
  test("a custom-source story shows a photo served from Moss's own address", async ({ page }) => {
    const requested: string[] = [];
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: [],
      notifications: [],
      tasks: []
    });
    await registerMockSportsRoutes(page, overviewWithPhotos);
    await page.route("**/api/sports/headlines/*/photo", async (route) => {
      requested.push(new URL(route.request().url()).pathname);
      await route.fulfill({
        status: 200,
        contentType: "image/webp",
        headers: { "cache-control": "private, max-age=604800, immutable" },
        body: Buffer.from("RIFF0000WEBPVP8 mock", "latin1")
      });
    });

    await gotoSports(page);

    const photo = page.locator("img.sp-photo--herostory").first();
    await expect(photo).toHaveAttribute(
      "src",
      `/api/sports/headlines/${encodeURIComponent(WIDE_STORY_ID)}/photo`
    );
    // Same origin: the browser asked Moss for the bytes, never the publisher.
    await expect
      .poll(() => requested.length, { message: "the photo route was never called" })
      .toBeGreaterThan(0);
    expect(requested.every((path) => path.startsWith("/api/sports/headlines/"))).toBe(true);
  });

  test("the wide photo leads even though the narrow story ranked first", async ({ page }) => {
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: [],
      notifications: [],
      tasks: []
    });
    await registerMockSportsRoutes(page, overviewWithPhotos);
    await page.route("**/api/sports/headlines/*/photo", (route) =>
      route.fulfill({
        status: 200,
        contentType: "image/webp",
        body: Buffer.from("RIFF0000WEBPVP8 mock", "latin1")
      })
    );

    await gotoSports(page);

    // A preference, not a filter: the narrow story is still on the page, just no longer leading.
    const slides = page.locator(".sp-carousel__slide");
    await expect(slides).toHaveCount(2);
    await expect(slides.first()).toContainText("Wide photo story");
    await expect(slides.nth(1)).toContainText("Narrow photo story");
  });
});
