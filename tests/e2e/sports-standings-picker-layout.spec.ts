import { expect, test, type Locator, type Page } from "@playwright/test";
import type { CompetitionRef, StandingsGroup } from "@moss/shared";
import { createMockConnectorProviders, mockApi } from "./mock-api.js";
import { registerMockSportsRoutes, sportsOverviewFixture } from "./mock-sports-api.js";

const LONG_VIEW = "American Football Conference · Northern Division";
const catalog: readonly CompetitionRef[] = [
  {
    competitionKey: "nfl",
    label: "NFL",
    sportLabel: "Football",
    regionLabel: null,
    kind: "league",
    marquee: false,
    standingsShape: "record",
    confederation: "INTL"
  },
  {
    competitionKey: "eng.1",
    label: "Premier League",
    sportLabel: "Soccer",
    regionLabel: "England",
    kind: "league",
    marquee: false,
    standingsShape: "table",
    confederation: "UEFA"
  }
];
const standings: StandingsGroup = {
  competitionKey: "nfl",
  competitionLabel: "NFL",
  standingsShape: "record",
  sections: [LONG_VIEW, "Southern Division"].map((label, index) => ({
    label,
    rows: [
      {
        teamKey: index ? "dal" : "min",
        sourceTeamId: null,
        name: index ? "Dallas Cowboys" : "Minnesota Vikings",
        rank: index + 1,
        points: null,
        wins: 12,
        losses: 3,
        draws: 0,
        winPercent: 0.8,
        qualifies: false,
        qualificationNote: null,
        qualificationColor: null
      }
    ]
  }))
};

async function seed(page: Page) {
  await mockApi(page, {
    authenticated: true,
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  await registerMockSportsRoutes(page, { ...sportsOverviewFixture, standings: [standings] });
  await page.route("**/api/sports/catalog", (route) =>
    route.fulfill({ json: { competitions: catalog, degraded: false } })
  );
  await page.route("**/api/sports/follows", (route) => route.fulfill({ json: { follows: [] } }));
  await page.route("**/api/sports/standings?*", (route) =>
    route.fulfill({ json: { group: standings, fixtures: [], degraded: false } })
  );
  await page.route("**/api/sports/standings-preferences", (route) =>
    route.fulfill({
      json: {
        selectedCompetitionKeys: ["nfl", "eng.1"],
        lastViewed:
          route.request().method() === "PUT"
            ? route.request().postDataJSON().lastViewed
            : { competitionKey: "nfl", viewKey: "sec:0", viewLabel: LONG_VIEW }
      }
    })
  );
}

async function expectUsableMenu(page: Page, menu: Locator, width: number) {
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.width).toBeGreaterThan(100);
  const choices = menu.locator('[role="menuitem"], [role="menuitemradio"]');
  expect(await choices.count()).toBeGreaterThan(0);
  for (const choice of await choices.all()) {
    await expect(choice).toBeVisible();
    const rect = (await choice.boundingBox())!;
    expect(rect.x).toBeGreaterThanOrEqual(box.x);
    expect(rect.x + rect.width).toBeLessThanOrEqual(box.x + box.width + 1);
    const hit = await choice.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return top !== null && element.contains(top);
    });
    expect(hit).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width
  );
}

for (const width of [320, 390, 1440]) {
  for (const edge of ["start", "end"] as const) {
    test(`standings picker stays visible at ${width}px with the trigger at the ${edge} edge`, async ({
      page
    }) => {
      await page.setViewportSize({ width, height: 1100 });
      await seed(page);
      await page.goto("/sports");
      const trigger = page.getByRole("button", { name: "Select standings league" });
      await expect(trigger).toHaveText("NFL");
      const view = page.getByLabel("Select standings view");
      await expect(view).toHaveValue("sec:0");
      // Stress both header edges while retaining the actual long view selector and short trigger.
      // The popup must stay bounded regardless of which side the trigger occupies after wrapping.
      await page.addStyleTag({
        content: `.sp-standings__nav { flex-basis: 100%; width: 100%; justify-content: ${edge === "start" ? "flex-start" : "flex-end"}; flex-direction: ${edge === "start" ? "row" : "row-reverse"}; }`
      });
      await trigger.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await trigger.press("Enter");
      const menu = page.getByRole("menu", { name: "Standings leagues" });
      await expectUsableMenu(page, menu, width);
      await menu.getByRole("menuitem", { name: "Football", exact: true }).press("ArrowRight");
      await expectUsableMenu(page, menu, width);
      await menu.getByRole("menuitemradio", { name: "NFL", exact: true }).press("Enter");
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
      await trigger.press("Enter");
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
    });
  }
}
