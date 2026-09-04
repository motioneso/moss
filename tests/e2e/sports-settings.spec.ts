import { test, expect, type Page, type Route } from "@playwright/test";
import type {
  CompetitionRef,
  CreateSportsFollowRequest,
  SportsFollowDto,
  TeamRef,
  UpdateSportsEspnCoverageRequest
} from "@moss/shared";

import { mockApi } from "./mock-api.js";
import { registerMockSportsRoutes } from "./mock-sports-api.js";

const NFL: CompetitionRef = {
  competitionKey: "nfl",
  label: "NFL",
  sportLabel: "Football",
  regionLabel: null,
  kind: "league",
  marquee: true,
  standingsShape: "record",
  confederation: "INTL"
};
const EPL: CompetitionRef = {
  competitionKey: "eng.1",
  label: "Premier League",
  sportLabel: "Soccer",
  regionLabel: "England",
  kind: "league",
  marquee: true,
  standingsShape: "table",
  confederation: "UEFA"
};
const NBA: CompetitionRef = {
  competitionKey: "nba",
  label: "NBA",
  sportLabel: "Basketball",
  regionLabel: null,
  kind: "league",
  marquee: false,
  standingsShape: "record",
  confederation: "INTL"
};
const MLB: CompetitionRef = {
  competitionKey: "mlb",
  label: "MLB",
  sportLabel: "Baseball",
  regionLabel: null,
  kind: "league",
  marquee: false,
  standingsShape: "record",
  confederation: "INTL"
};
const COWBOYS: TeamRef = {
  teamKey: "dal",
  competitionKey: "nfl",
  name: "Dallas Cowboys",
  shortName: "DAL",
  crestUrl: null
};
const ARSENAL: TeamRef = {
  teamKey: "team.ars",
  competitionKey: "eng.1",
  name: "Arsenal",
  shortName: "ARS",
  crestUrl: null
};
const LAKERS: TeamRef = {
  teamKey: "lal",
  competitionKey: "nba",
  name: "Los Angeles Lakers",
  shortName: "LAL",
  crestUrl: null
};

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

type MutationScenario = {
  postGate?: Promise<void>;
  failPost?: boolean;
  deleteGate?: Promise<void>;
  failDelete?: boolean;
};

/** Stateful mock local to this spec (spec Slice 3) — catalog, follows, search, roster, and
    create/delete follow, all in-memory. No ESPN call, no real account. */
async function mockSportsSettings(
  page: Page,
  scenario: MutationScenario = {}
): Promise<{ sourceReads: () => number }> {
  let follows: SportsFollowDto[] = [];
  let nextId = 1;
  let sourceReads = 0;
  let selectedCompetitionKeys: readonly string[] | null = null;
  let espn = {
    kind: "builtin" as const,
    id: "espn" as const,
    label: "ESPN" as const,
    enabled: true,
    usesDefaultCoverage: true,
    assignments: [] as UpdateSportsEspnCoverageRequest["assignments"]
  };

  await page.route("**/api/me/modules", (route) =>
    fulfillJson(route, {
      modules: [
        {
          id: "sports",
          name: "Sports",
          version: "0.1.0",
          lifecycle: "user-toggleable",
          required: false,
          supportsUserDisable: true,
          instanceDisabled: false,
          userDisabled: false,
          active: true
        }
      ]
    })
  );

  await registerMockSportsRoutes(page);

  await page.route("**/api/sports/catalog", (route) =>
    fulfillJson(route, { competitions: [NFL, NBA, MLB, EPL], degraded: false })
  );

  await page.route("**/api/sports/standings-preferences", (route) => {
    if (route.request().method() === "PUT") {
      selectedCompetitionKeys = (
        route.request().postDataJSON() as { selectedCompetitionKeys: readonly string[] }
      ).selectedCompetitionKeys;
    }
    return fulfillJson(route, { selectedCompetitionKeys });
  });

  await page.route("**/api/sports/standings?*", (route) => {
    const competitionKey = new URL(route.request().url()).searchParams.get("competitionKey") ?? "";
    const competition = [NFL, NBA, MLB, EPL].find(
      (entry) => entry.competitionKey === competitionKey
    );
    return fulfillJson(route, {
      group: {
        competitionKey,
        competitionLabel: competition?.label ?? competitionKey,
        standingsShape: competition?.standingsShape ?? "record",
        sections: [
          {
            label: null,
            rows: [
              {
                teamKey: `${competitionKey}-leader`,
                name: `${competition?.label ?? competitionKey} leader`,
                rank: 1,
                points: 10,
                wins: 10,
                losses: 0,
                draws: 0,
                winPercent: null,
                qualifies: false,
                qualificationNote: null,
                qualificationColor: null
              }
            ]
          }
        ]
      },
      fixtures: []
    });
  });

  // #2211 custom sources added through the two-phase preview/confirm flow, kept in memory.
  const customSources: Array<Record<string, unknown>> = [];
  await page.route("**/api/sports/sources", (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { canonicalDomain: string };
      const source = {
        kind: "custom",
        id: `source-${customSources.length + 1}`,
        label: body.canonicalDomain === "reddit.com" ? "r/nfl" : body.canonicalDomain,
        canonicalDomain: body.canonicalDomain,
        homepageUrl: `https://${body.canonicalDomain}/`,
        feedUrl: null,
        retrievalMethod: body.canonicalDomain === "reddit.com" ? "reddit" : "feed",
        enabled: true,
        healthState: "healthy",
        healthReasonCode: null,
        healthMessage: null,
        lastCheckedAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        recipeStatus: "feed",
        assignedFollowIds: [],
        assignments: [],
        createdAt: new Date().toISOString()
      };
      customSources.push(source);
      return fulfillJson(route, { source });
    }
    sourceReads += 1;
    return fulfillJson(route, { sources: [espn, ...customSources] });
  });

  await page.route("**/api/sports/sources/preview", (route) => {
    const body = route.request().postDataJSON() as { url: string };
    if (!/^\/?r\/nfl$/i.test(body.url.trim())) {
      return fulfillJson(route, { status: "rejected", reason: "invalid_input" });
    }
    return fulfillJson(route, {
      status: "ok",
      confirmationId: "confirmation-nfl",
      authorizationAcknowledgement: "I confirm this public source.",
      candidate: {
        label: "r/nfl",
        canonicalDomain: "reddit.com",
        homepageUrl: "https://www.reddit.com/r/nfl/",
        retrievalMethod: "reddit",
        sampleCount: 2,
        confirmedFetchHosts: ["www.reddit.com"],
        sampleHeadlines: ["Chiefs sign a new kicker", "Bills extend their coach"],
        targets: []
      }
    });
  });

  await page.route("**/api/sports/sources/*/icon", (route) => route.fulfill({ status: 404 }));

  await page.route("**/api/sports/sources/espn/coverage", (route) => {
    const body = route.request().postDataJSON() as UpdateSportsEspnCoverageRequest;
    espn = {
      ...espn,
      enabled: body.assignments.length > 0,
      usesDefaultCoverage: false,
      assignments: body.assignments
    };
    return fulfillJson(route, { source: espn });
  });

  await page.route("**/api/sports/follows", async (route) => {
    if (route.request().method() === "GET") return fulfillJson(route, { follows });
    if (route.request().method() === "POST") {
      await scenario.postGate;
      if (scenario.failPost) return fulfillJson(route, { message: "Follow failed" }, 500);
      const body = route.request().postDataJSON() as CreateSportsFollowRequest;
      const follow: SportsFollowDto = {
        id: `f${nextId++}`,
        competitionKey: body.competitionKey,
        teamKey: body.teamKey ?? null,
        createdAt: "2026-07-12T00:00:00.000Z"
      };
      follows = [...follows, follow];
      return fulfillJson(route, { follow });
    }
    return route.continue();
  });

  await page.route("**/api/sports/follows/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await scenario.deleteGate;
    if (scenario.failDelete) return fulfillJson(route, { message: "Unfollow failed" }, 500);
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop() ?? "");
    follows = follows.filter((f) => f.id !== id);
    return fulfillJson(route, { ok: true });
  });

  await page.route("**/api/sports/teams/search*", (route) => {
    const q = new URL(route.request().url()).searchParams.get("q")?.toLowerCase() ?? "";
    const teams = [COWBOYS, ARSENAL, LAKERS].filter((t) => t.name.toLowerCase().includes(q));
    return fulfillJson(route, { teams, partial: false, degraded: false });
  });

  await page.route("**/api/sports/leagues/*/teams", (route) => {
    const key = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[4] ?? "");
    const teams =
      key === "nfl" ? [COWBOYS] : key === "eng.1" ? [ARSENAL] : key === "nba" ? [LAKERS] : [];
    return fulfillJson(route, { teams, degraded: false });
  });

  return { sourceReads: () => sourceReads };
}

async function gotoSportsSettings(page: Page): Promise<void> {
  await page.goto("/settings?section=modules&module=sports");
  await expect(page.getByRole("heading", { name: "Sports" })).toBeVisible();
}

test.describe("Sports settings follow picker (#989)", () => {
  test("only the initiating target shows pending and target-local errors for failed POST/DELETE", async ({
    page
  }) => {
    const scenario: MutationScenario = {};
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: [],
      notifications: [],
      tasks: []
    });
    await mockSportsSettings(page, scenario);
    await gotoSportsSettings(page);

    await page.getByRole("searchbox", { name: "Find a team or league" }).fill("cowboys");
    let releasePost!: () => void;
    scenario.postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    scenario.failPost = true;

    await page.getByRole("button", { name: "Follow Dallas Cowboys" }).click();
    const pendingFollow = page.getByRole("button", { name: "Following…" });
    await expect(pendingFollow).toBeDisabled();
    await expect(page.getByRole("button", { name: "Follow all of NFL" })).toBeEnabled();
    releasePost();

    const failedFollow = page.getByRole("button", { name: "Follow Dallas Cowboys" });
    await expect(failedFollow).toBeVisible();
    await expect(failedFollow.locator("..").getByRole("alert")).toHaveText(
      "Couldn’t follow Dallas Cowboys. Try again."
    );

    scenario.postGate = undefined;
    scenario.failPost = false;
    await failedFollow.click();
    const unfollow = page.getByRole("button", { name: "Unfollow Dallas Cowboys" });
    await expect(unfollow).toBeVisible();

    let releaseDelete!: () => void;
    scenario.deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    scenario.failDelete = true;
    await unfollow.click();
    const pendingUnfollow = page.getByRole("button", { name: "Unfollowing…" });
    await expect(pendingUnfollow).toBeDisabled();
    await expect(page.getByRole("button", { name: "Follow all of NFL" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Unfollow DAL" })).toBeEnabled();
    releaseDelete();

    const retainedUnfollow = page.getByRole("button", { name: "Unfollow Dallas Cowboys" });
    await expect(retainedUnfollow).toBeVisible();
    await expect(retainedUnfollow.locator("..").getByRole("alert")).toHaveText(
      "Couldn’t unfollow Dallas Cowboys. Try again."
    );
    await expect(page.getByRole("alert")).toHaveCount(1);
  });

  test("search → follow → Following → unfollow a team; follow-all → unfollow-all a league", async ({
    page
  }) => {
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: [],
      notifications: [],
      tasks: []
    });
    await mockSportsSettings(page);
    await gotoSportsSettings(page);

    // Browse leagues starts collapsed on desktop too.
    const browseToggle = page.getByRole("button", { name: "Browse leagues" });
    await expect(browseToggle).toHaveAttribute("aria-expanded", "false");

    // Search → follow an individual team.
    await page.getByRole("searchbox", { name: "Find a team or league" }).fill("cowboys");
    const followBtn = page.getByRole("button", { name: "Follow Dallas Cowboys" });
    await expect(followBtn).toBeVisible();
    await followBtn.click();
    await expect(page.getByRole("button", { name: "Unfollow Dallas Cowboys" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Unfollow Dallas Cowboys" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    // Unfollow via the same control.
    await page.getByRole("button", { name: "Unfollow Dallas Cowboys" }).click();
    await expect(page.getByRole("button", { name: "Follow Dallas Cowboys" })).toBeVisible();

    // Follow-all a league from search results.
    await page.getByRole("searchbox", { name: "Find a team or league" }).fill("nfl");
    const followAllBtn = page.getByRole("button", { name: "Follow all of NFL" });
    await followAllBtn.click();
    await expect(page.getByRole("button", { name: "Unfollow all of NFL" })).toBeVisible();

    await page.getByRole("button", { name: "Unfollow all of NFL" }).click();
    await expect(page.getByRole("button", { name: "Follow all of NFL" })).toBeVisible();
  });

  test("browse leagues disclosure opens only the selected league's roster and preserves loading/retry states", async ({
    page
  }) => {
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: [],
      notifications: [],
      tasks: []
    });
    await mockSportsSettings(page);
    await gotoSportsSettings(page);

    const browseToggle = page.getByRole("button", { name: "Browse leagues" });
    await browseToggle.click();
    await expect(browseToggle).toHaveAttribute("aria-expanded", "true");
    const leagueToggle = page.getByRole("button", { name: "Premier League", exact: true });
    await expect(leagueToggle).toBeVisible();

    await leagueToggle.click();
    await expect(page.getByRole("button", { name: "Follow Arsenal" })).toBeVisible();
    // Only the expanded league's roster fetched — NFL's roster button never appears unexpanded.
  });

  test("narrow viewport: browse starts collapsed, keyboard-openable, no horizontal overflow", async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: [],
      notifications: [],
      tasks: []
    });
    await mockSportsSettings(page);
    await gotoSportsSettings(page);

    const browseToggle = page.getByRole("button", { name: "Browse leagues" });
    await expect(browseToggle).toHaveAttribute("aria-expanded", "false");
    await browseToggle.focus();
    await page.keyboard.press("Enter");
    await expect(browseToggle).toHaveAttribute("aria-expanded", "true");

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    // Search → follow round-trip still works at narrow width.
    await page.getByRole("searchbox", { name: "Find a team or league" }).fill("arsenal");
    await page.getByRole("button", { name: "Follow Arsenal" }).click();
    await expect(page.getByRole("button", { name: "Unfollow Arsenal" })).toBeVisible();
    await page.getByRole("button", { name: "Unfollow Arsenal" }).click();
    await expect(page.getByRole("button", { name: "Follow Arsenal" })).toBeVisible();
  });

  test("clearing ESPN coverage refetches the normalized source list", async ({ page }) => {
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: [],
      notifications: [],
      tasks: []
    });
    const sportsApi = await mockSportsSettings(page);
    await gotoSportsSettings(page);

    await expect(page.getByText("Coverage: All sports")).toBeVisible();
    await page.getByRole("button", { name: "Edit coverage for ESPN" }).click();
    const sports = page.getByRole("group", { name: "Sports" }).first();
    for (const label of ["Football", "Hockey", "Soccer", "Baseball", "Basketball"]) {
      await sports.getByText(label, { exact: true }).click();
    }
    await page.getByRole("button", { name: "Save coverage" }).click();

    await expect(page.getByText("Inactive for headlines.")).toBeVisible();
    expect(sportsApi.sourceReads()).toBeGreaterThan(1);
  });

  test("adding a subreddit previews its linked articles, confirms, and shows the row (#2211)", async ({
    page
  }) => {
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: [],
      notifications: [],
      tasks: []
    });
    await mockSportsSettings(page);
    await gotoSportsSettings(page);

    await page.getByRole("button", { name: "Add a source" }).click();
    const input = page.getByPlaceholder("theathletic.com or r/nfl");
    await input.fill("r/nfl");
    await page.getByRole("button", { name: "Check" }).click();

    await expect(page.getByText("Chiefs sign a new kicker")).toBeVisible();
    await expect(page.getByText("Bills extend their coach")).toBeVisible();
    await page.getByText("I confirm this public source.").click();
    await page.getByRole("button", { name: "Add this source" }).click();

    await expect(page.getByText("Source added.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove r/nfl" })).toBeVisible();
  });

  test("saved leagues and follows assemble into one keyboard-accessible standings picker", async ({
    page
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page, {
      authenticated: true,
      connectorAccounts: [],
      connectorProviders: [],
      notifications: [],
      tasks: []
    });
    await mockSportsSettings(page);
    await gotoSportsSettings(page);

    const standingsSettings = page.getByRole("region", { name: "Configure standings" });
    // The section starts collapsed (Ben, 2026-09-03); open it before measuring the picker.
    await standingsSettings.getByRole("button", { name: /Configure standings/ }).click();
    // The design system hides the real checkbox input, so visibility and clicks go by label text.
    await expect(standingsSettings.getByText("NFL", { exact: true })).toBeVisible();
    for (const width of [320, 375, 414, 768]) {
      await page.setViewportSize({ width, height: 844 });
      const geometry = await standingsSettings.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          viewport: document.documentElement.clientWidth,
          scroll: element.scrollWidth,
          client: element.clientWidth
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    // Every league is a checkbox that saves as soon as it changes.
    await standingsSettings.getByText("NBA", { exact: true }).click();
    await expect(standingsSettings.getByRole("checkbox", { name: "NBA" })).not.toBeChecked();
    await standingsSettings.getByText("MLB", { exact: true }).click();
    await expect(standingsSettings.getByRole("checkbox", { name: "MLB" })).not.toBeChecked();
    await page.getByRole("searchbox", { name: "Find a team or league" }).fill("lakers");
    await page.getByRole("button", { name: "Follow Los Angeles Lakers" }).click();

    await page.reload();
    await standingsSettings.getByRole("button", { name: /Configure standings/ }).click();
    await expect(standingsSettings.getByRole("checkbox", { name: "NFL" })).toBeChecked();
    await expect(standingsSettings.getByRole("checkbox", { name: "NBA" })).not.toBeChecked();
    await expect(standingsSettings.getByRole("checkbox", { name: "MLB" })).not.toBeChecked();
    // Soccer leagues sit under their country; the country row opens on click (Ben, 2026-09-03).
    await expect(standingsSettings.getByText("Premier League", { exact: true })).toBeHidden();
    await standingsSettings.getByRole("button", { name: /England/ }).click();
    await expect(standingsSettings.getByText("Premier League", { exact: true })).toBeVisible();
    await expect(standingsSettings.getByRole("checkbox", { name: "Premier League" })).toBeChecked();
    await expect(
      standingsSettings.getByRole("checkbox", { name: "All England leagues" })
    ).toBeChecked();

    await page.goto("/sports");
    const picker = page.getByRole("button", { name: "Select standings league" });
    await expect(picker).toBeVisible();
    await picker.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("group", { name: "Following" })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: "NBA" })).toHaveCount(1);
    await expect(page.getByRole("menuitemradio", { name: "MLB" })).toHaveCount(0);

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menuitemradio", { name: "NFL" })).toBeFocused();
    const standingsResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/sports/standings?competitionKey=nfl") &&
        response.status() === 200
    );
    await page.keyboard.press("Enter");
    await standingsResponse;
    await expect(picker).toHaveText("NFL");
    await expect(page.getByText("NFL leader")).toBeVisible();

    await picker.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(picker).toBeFocused();
    await expect(picker).toHaveAttribute("aria-expanded", "false");

    const geometry = await picker.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, viewport: document.documentElement.clientWidth };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
    const railWidth = await picker.evaluate((element) => {
      const rail = element.closest<HTMLElement>(".sp-standings")!;
      return { scroll: rail.scrollWidth, client: rail.clientWidth };
    });
    expect(railWidth.scroll).toBeLessThanOrEqual(railWidth.client + 1);

    await picker.click();
    const pickerMenu = page.getByRole("menu", { name: "Standings leagues" });
    await expect(pickerMenu.getByRole("group", { name: "Following" })).toBeVisible();
    await expect(pickerMenu.getByRole("group", { name: "Sports" })).toBeVisible();
    await page.getByRole("menuitem", { name: "Soccer" }).click();
    await expect(pickerMenu.getByText("Countries and regions")).toBeVisible();
    await page.getByRole("menuitem", { name: "England" }).click();
    await expect(pickerMenu.getByRole("menuitemradio", { name: "Premier League" })).toBeVisible();
  });
});
