import { execFileSync } from "node:child_process";

import { expect, test, type Locator, type Page } from "@playwright/test";
import type { LookupAiCapabilityRouteResponse } from "@moss/shared";

import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1909 live-path proof. The surface check remains credential-free. The full public-source path
// uses real publisher fetches plus the operator-provided real JSON-capable model, matching the
// product boundary rather than replacing discovery or extraction with fixtures.
export const uatLevel = {
  level: "admin+data",
  without: ["sports"],
  withoutNewsJsonBinding: true,
  withSportsPublicSourceFixtures: true
} as const;

test.describe.configure({ mode: "serial" });

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE);
const BBC_FEED_URL = "https://feeds.bbci.co.uk/sport/football/rss.xml";
const RAW_FIXTURE_DOMAIN = "raw.githubusercontent.com";
const DRIFT_FIXTURE_DOMAIN = "raw.githack.com";
const SHARED_STORY_URL = "https://example.com/issue-1909-shared-story";
const MODEL_DISCOVERY_DEADLINE_MS = 60_000;
const SOURCE_DEADLINE_MS = 180_000;
const POLL_INITIAL_INTERVAL_MS = 500;
const POLL_MAX_INTERVAL_MS = 4_000;

interface SourceRow {
  readonly id: string;
  readonly label: string;
  readonly canonicalDomain: string;
  readonly healthState: string;
  readonly healthReasonCode: string | null;
  readonly recipeStatus: string;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly assignments: readonly {
    readonly followId: string;
    readonly targetUrl: string | null;
    readonly previewStatus: string;
    readonly healthState: string;
    readonly healthReasonCode: string | null;
  }[];
}

interface HeadlineRow {
  readonly id: string;
  readonly competitionKey: string;
  readonly title: string;
  readonly url: string;
  readonly publisherLabel: string;
  readonly publisherDomain: string;
}

interface PreviewResult {
  readonly status: string;
  readonly confirmationId?: string;
  readonly authorizationAcknowledgement?: string;
  readonly candidate?: {
    readonly canonicalDomain: string;
    readonly confirmedFetchHosts: readonly string[];
    readonly targets: readonly { readonly target: unknown; readonly targetUrl: string }[];
  };
}

interface RecordedAction {
  readonly id: string;
  readonly toolName?: string;
  readonly status: string;
}

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

async function openSportsSettings(page: Page): Promise<Locator> {
  await page.goto(`${requireBaseURL()}/settings?section=modules&module=sports`);
  const section = page.locator('section[aria-label="Sports news sources"]');
  await expect(section).toBeVisible();
  return section;
}

async function bringUpRealModel(page: Page): Promise<void> {
  const install = await page.request.post("/api/onboarding/provider-install", {
    data: { providerKind: "anthropic" }
  });
  expect(install.ok(), `provider-install -> ${install.status()}`).toBeTruthy();
  expect((await install.json()).installState).toBe("installed");

  const begin = await page.request.post("/api/onboarding/provider-login/begin", {
    data: { providerKind: "anthropic" }
  });
  expect(begin.ok(), `provider-login/begin -> ${begin.status()}`).toBeTruthy();
  expect((await begin.json()).status).toBe("ready");

  await expect
    .poll(
      async () => {
        const routes = await Promise.all(
          ["chat", "json"].map(async (capability) => {
            const response = await page.request.get(`/api/ai/capability-route/${capability}`);
            expect(response.ok(), `${capability} capability -> ${response.status()}`).toBeTruthy();
            return ((await response.json()) as LookupAiCapabilityRouteResponse).route;
          })
        );
        return routes.every(
          (route) =>
            route.available &&
            route.model?.providerKind === "anthropic" &&
            route.model.status === "active"
        );
      },
      { timeout: MODEL_DISCOVERY_DEADLINE_MS }
    )
    .toBe(true);
}

async function createPremierLeagueFollows(page: Page): Promise<{
  readonly leagueId: string;
  readonly teamId: string;
}> {
  const league = await page.request.post("/api/sports/follows", {
    data: { competitionKey: "eng.1" }
  });
  expect(league.ok(), `league follow -> ${league.status()}`).toBeTruthy();

  const search = await page.request.get("/api/sports/teams/search?q=Arsenal");
  expect(search.ok(), `team search -> ${search.status()}`).toBeTruthy();
  const teams = (await search.json()) as {
    teams: readonly {
      competitionKey: string;
      teamKey: string;
      name: string;
      shortName: string;
    }[];
  };
  const arsenal = teams.teams.find(
    (team) => team.competitionKey === "eng.1" && /arsenal/i.test(`${team.name} ${team.shortName}`)
  );
  expect(arsenal, "Arsenal must resolve from the real Sports catalog").toBeDefined();
  if (!arsenal) throw new Error("Arsenal was absent from the Sports catalog");

  const team = await page.request.post("/api/sports/follows", {
    data: { competitionKey: arsenal.competitionKey, teamKey: arsenal.teamKey }
  });
  expect(team.ok(), `team follow -> ${team.status()}`).toBeTruthy();
  const leagueRow = (await league.json()) as { follow: { id: string } };
  const teamRow = (await team.json()) as { follow: { id: string } };
  return {
    leagueId: leagueRow.follow.id,
    teamId: teamRow.follow.id
  };
}

async function listSources(page: Page): Promise<readonly SourceRow[]> {
  const response = await page.request.get("/api/sports/sources");
  expect(response.ok(), `source list -> ${response.status()}`).toBeTruthy();
  return ((await response.json()) as { sources: readonly SourceRow[] }).sources;
}

async function invokeReadTool<T>(
  page: Page,
  name: string,
  input: Record<string, unknown>
): Promise<T> {
  const response = await page.request.post(`/api/ai/assistant-tools/${name}/invoke`, {
    data: { input }
  });
  expect(response.ok(), `${name} -> ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as {
    invocation?: { status?: string; result?: T | { data?: T } };
  };
  expect(body.invocation?.status, `${name} did not succeed`).toBe("succeeded");
  const result = body.invocation?.result;
  if (!result) throw new Error(`${name} returned no result`);
  return ((result as { data?: T }).data ?? result) as T;
}

async function listActions(page: Page): Promise<readonly RecordedAction[]> {
  const response = await page.request.get("/api/ai/assistant-actions");
  expect(response.ok(), `assistant-actions -> ${response.status()}`).toBeTruthy();
  return ((await response.json()) as { actions: readonly RecordedAction[] }).actions;
}

// #2164 diagnostic: prove the live actor's own tool list carries the retry tool before the chat
// turn starts, so a later "Approve button never appeared" failure can't be a missing-declaration
// question — narrows the failure to the model's decision or the SSE delivery path instead.
async function requireToolInLiveActorList(page: Page, toolName: string): Promise<void> {
  const response = await page.request.get("/api/ai/assistant-tools");
  expect(response.ok(), `assistant-tools -> ${response.status()}`).toBeTruthy();
  const names = ((await response.json()) as { tools: readonly { name: string }[] }).tools.map(
    (tool) => tool.name
  );
  expect(names, "live actor tool list must carry the retry tool before the chat turn").toContain(
    toolName
  );
}

// #2164 root cause: a dotted internal tool id paired with an imperative "call it exactly
// once, do not call another tool" instruction and a raw JSON payload reads as an injected
// command to a healthy model, which then refuses it. The message here must read as an
// ordinary user request in plain English instead — see the static guard in
// tests/unit/1909-sports-uat-natural-request.test.ts.
async function confirmThroughMoss(
  page: Page,
  toolName: string,
  requestText: string,
  summaryText: RegExp
): Promise<void> {
  const before = new Set((await listActions(page)).map((action) => action.id));
  const open = page.getByRole("button", { name: /^(Chat with |Open chat$)/ });
  if ((await open.getAttribute("aria-pressed")) !== "true") await open.click();
  const turnSettled = page.waitForResponse(
    (response) =>
      response.url().includes("/api/chat/turn") && response.request().method() === "POST",
    { timeout: 300_000 }
  );
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await composer.fill(requestText);
  await composer.press("Enter");

  const card = page
    .locator('[role="region"][aria-label="Action request"]')
    .filter({ hasText: summaryText })
    .last();
  await expect(card.getByRole("button", { name: "Approve" })).toBeVisible({
    timeout: SOURCE_DEADLINE_MS
  });
  await card.getByRole("button", { name: "Approve" }).click();
  const response = await turnSettled;
  expect(response.ok(), `${toolName} chat turn -> ${response.status()}`).toBeTruthy();
  await expect
    .poll(
      async () =>
        (await listActions(page)).find(
          (action) => !before.has(action.id) && action.toolName === toolName
        )?.status,
      { timeout: 60_000 }
    )
    .toBe("confirmed");
}

function confirmationInput(preview: PreviewResult, extra: Record<string, unknown> = {}) {
  expect(preview.status).toBe("ok");
  expect(preview.confirmationId).toBeTruthy();
  expect(preview.authorizationAcknowledgement).toBeTruthy();
  expect(preview.candidate).toBeTruthy();
  if (!preview.confirmationId || !preview.authorizationAcknowledgement || !preview.candidate) {
    throw new Error("Sports source preview omitted confirmation authority");
  }
  return {
    ...extra,
    confirmationId: preview.confirmationId,
    authorizationAcknowledgement: preview.authorizationAcknowledgement,
    canonicalDomain: preview.candidate.canonicalDomain,
    confirmedFetchHosts: preview.candidate.confirmedFetchHosts,
    targets: preview.candidate.targets.map(({ target, targetUrl }) => ({ target, targetUrl }))
  };
}

// Spells out the two values the two confirmation steps care about — the confirmation id
// and the authorization acknowledgement — as ordinary prose, then lists the remaining
// exact-match fields the schema still requires so the live model can reproduce them.
function describeConfirmation(preview: PreviewResult, extra: Record<string, unknown> = {}): string {
  const { confirmationId, authorizationAcknowledgement, ...rest } = confirmationInput(
    preview,
    extra
  );
  return (
    `confirmation id ${confirmationId} and authorization acknowledgement ` +
    `"${authorizationAcknowledgement}", matching these exact preview details: ${JSON.stringify(rest)}`
  );
}

test("public publishers reach Sports, Today, recovery, and Moss status (#1909)", async ({
  page
}) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "JARVIS_UAT_REAL_CHAT_TOKEN_FILE is required for real public-source discovery (#1909)"
  );
  test.setTimeout(1_500_000);

  const seededSignIn = await page.request.post("/api/auth/sign-in/email", {
    data: { email: UAT_ADMIN_EMAIL, password: UAT_ADMIN_PASSWORD }
  });
  expect(seededSignIn.ok(), `seeded sign-in -> ${seededSignIn.status()}`).toBeTruthy();
  let sources = await listSources(page);
  const bbc = sources.find((source) => source.canonicalDomain === new URL(BBC_FEED_URL).hostname);
  const failing = sources.find((source) => source.canonicalDomain === RAW_FIXTURE_DOMAIN);
  const fotmob = sources.find((source) => source.canonicalDomain === "fotmob.com");
  const drift = sources.find((source) => source.canonicalDomain === DRIFT_FIXTURE_DOMAIN);
  expect(bbc, "grandfathered feed fixture must persist").toBeDefined();
  expect(failing, "controlled target-failure fixture must persist").toBeDefined();
  expect(fotmob, "grandfathered scrape fixture must persist").toBeDefined();
  expect(drift, "recipe-drift fixture must persist").toBeDefined();
  if (!bbc || !failing || !fotmob || !drift) {
    throw new Error("#1909 source fixtures were not seeded");
  }

  expect(bbc.healthState).toBe("pending");
  expect(bbc.lastCheckedAt).toBeNull();
  expect(bbc.lastSuccessAt).toBeNull();
  expect(bbc.assignments.every((assignment) => assignment.previewStatus === "verified")).toBe(true);
  expect(failing.healthState).toBe("failing");
  expect(failing.healthReasonCode).toBe("partial_target_failure");
  expect(failing.assignments.map((assignment) => assignment.healthState).sort()).toEqual([
    "failing",
    "healthy"
  ]);
  expect(fotmob.healthReasonCode).toBe("recipe_missing");
  expect(
    fotmob.assignments.every((assignment) => assignment.previewStatus === "recipe_missing")
  ).toBe(true);
  expect(drift.recipeStatus).toBe("drift");
  expect(drift.healthReasonCode).toBe("recipe_drift");

  await page.context().clearCookies();
  await signIn(page);
  await bringUpRealModel(page);
  const follows = await createPremierLeagueFollows(page);
  const section = await openSportsSettings(page);
  await expect(section.getByLabel("Publication homepage or domain")).toBeVisible();
  await expect(section.getByRole("button", { name: "Check", exact: true })).toBeVisible();
  await expect(
    section.getByRole("button", { name: /Retry Issue 1909 fixture feed/ })
  ).toBeVisible();
  await expect(section.getByRole("button", { name: /Rebuild FotMob legacy scrape/ })).toBeVisible();

  await requireToolInLiveActorList(page, "sports.retrySource");

  await test.step("Moss Retry recovers a controlled partial target failure", async () => {
    await confirmThroughMoss(
      page,
      "sports.retrySource",
      `One of my sports sources (id ${failing.id}) is showing a partial target failure — please retry it.`,
      new RegExp(`Retry sports source ${failing.id}`)
    );
    const recovered = (await listSources(page)).find((source) => source.id === failing.id);
    expect(recovered?.healthState).toBe("healthy");
    expect(recovered?.assignments.every((assignment) => assignment.healthState === "healthy")).toBe(
      true
    );
  });

  await test.step("the grandfathered verified feed performs its first application refresh", async () => {
    const response = await page.request.get("/api/sports/overview");
    expect(response.ok(), `overview -> ${response.status()}`).toBeTruthy();
    const refreshed = (await listSources(page)).find((source) => source.id === bbc.id);
    expect(refreshed?.healthState).toBe("healthy");
    expect(refreshed?.lastCheckedAt).toBeTruthy();
    expect(refreshed?.lastSuccessAt).toBeTruthy();
  });

  await test.step("Moss previews and confirms a legacy scrape recipe rebuild", async () => {
    const preview = await invokeReadTool<PreviewResult>(page, "sports.rebuildSourceRecipe", {
      sourceId: fotmob.id
    });
    expect(preview).toMatchObject({
      status: "ok",
      candidate: { confirmedFetchHosts: expect.arrayContaining(["www.fotmob.com"]) }
    });
    await confirmThroughMoss(
      page,
      "sports.confirmSourceRecipe",
      `Please go ahead and rebuild the recipe for sports source ${fotmob.id} exactly as you just previewed it, using ${describeConfirmation(preview, { sourceId: fotmob.id })}.`,
      new RegExp(`Replace the recipe for sports source ${fotmob.id}`)
    );
    const rebuilt = (await listSources(page)).find((source) => source.id === fotmob.id);
    expect(["feed", "ready"]).toContain(rebuilt?.recipeStatus);
    expect(rebuilt?.healthReasonCode).toBeNull();
    expect(
      rebuilt?.assignments.every((assignment) => assignment.previewStatus === "verified")
    ).toBe(true);
  });

  await test.step("Moss rebuilds and confirms a drifted recipe", async () => {
    const preview = await invokeReadTool<PreviewResult>(page, "sports.rebuildSourceRecipe", {
      sourceId: drift.id
    });
    expect(preview.candidate?.confirmedFetchHosts).toContain(DRIFT_FIXTURE_DOMAIN);
    await confirmThroughMoss(
      page,
      "sports.confirmSourceRecipe",
      `Please go ahead and rebuild the recipe for sports source ${drift.id} exactly as you just previewed it, using ${describeConfirmation(preview, { sourceId: drift.id })}.`,
      new RegExp(`Replace the recipe for sports source ${drift.id}`)
    );
    const rebuilt = (await listSources(page)).find((source) => source.id === drift.id);
    expect(rebuilt?.recipeStatus).toBe("feed");
    expect(rebuilt?.healthReasonCode).toBeNull();
    expect(
      rebuilt?.assignments.every((assignment) => assignment.previewStatus === "verified")
    ).toBe(true);
  });

  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const mirroredFeedUrl = `https://cdn.jsdelivr.net/gh/motioneso/moss@${head}/tests/fixtures/sports/1909-shared-feed.xml`;
  let mirroredSourceId = "";
  await test.step("Moss previews and confirms a new public source", async () => {
    const preview = await invokeReadTool<PreviewResult>(page, "sports.previewSource", {
      url: mirroredFeedUrl,
      assignments: [{ followId: follows.leagueId }, { followId: follows.teamId }]
    });
    expect(preview.candidate?.confirmedFetchHosts).toContain("cdn.jsdelivr.net");
    await confirmThroughMoss(
      page,
      "sports.confirmSource",
      `Please go ahead and add the sports source you just previewed, using ${describeConfirmation(preview)}.`,
      /Add sports source/
    );
    const created = (await listSources(page)).find(
      (source) => source.canonicalDomain === "cdn.jsdelivr.net"
    );
    expect(created?.assignments).toHaveLength(2);
    mirroredSourceId = created?.id ?? "";
    expect(mirroredSourceId).toBeTruthy();
  });

  await test.step("Moss previews and confirms an exact assignment replacement", async () => {
    const preview = await invokeReadTool<PreviewResult>(page, "sports.previewSourceAssignments", {
      sourceId: mirroredSourceId,
      assignments: [{ followId: follows.leagueId }]
    });
    await confirmThroughMoss(
      page,
      "sports.confirmSourceAssignments",
      `Please go ahead and replace the assignments for sports source ${mirroredSourceId} exactly as you just previewed it, using ${describeConfirmation(preview, { sourceId: mirroredSourceId })}.`,
      new RegExp(`Replace assignments for sports source ${mirroredSourceId}`)
    );
    const replaced = (await listSources(page)).find((source) => source.id === mirroredSourceId);
    expect(replaced?.assignments.map((assignment) => assignment.followId)).toEqual([
      follows.leagueId
    ]);
  });

  let customHeadlines: readonly HeadlineRow[] = [];
  await expect
    .poll(
      async () => {
        const response = await page.request.get("/api/sports/overview");
        expect(response.ok(), `overview -> ${response.status()}`).toBeTruthy();
        const overview = (await response.json()) as {
          topStories: readonly HeadlineRow[];
          leagueNews: readonly { headlines: readonly HeadlineRow[] }[];
        };
        customHeadlines = [
          ...overview.topStories,
          ...overview.leagueNews.flatMap((g) => g.headlines)
        ];
        return (
          customHeadlines.some((headline) => headline.publisherDomain === "espn.com") &&
          customHeadlines.some((headline) => headline.url === SHARED_STORY_URL)
        );
      },
      { timeout: SOURCE_DEADLINE_MS, intervals: [POLL_INITIAL_INTERVAL_MS, POLL_MAX_INTERVAL_MS] }
    )
    .toBe(true);

  const shared = customHeadlines.filter((headline) => headline.url === SHARED_STORY_URL);
  expect(shared, "the same URL from two distinct sources must compose exactly once").toHaveLength(
    1
  );
  expect([RAW_FIXTURE_DOMAIN, "cdn.jsdelivr.net"]).toContain(shared[0]?.publisherDomain);
  expect(shared[0]?.publisherLabel).toBeTruthy();

  await page.goto(`${requireBaseURL()}/sports`);
  await expect(
    page
      .getByText(
        /FotMob - Football Live Scores|Issue 1909 fixture feed|Issue 1909 shared sports feed/i
      )
      .and(page.locator(":visible"))
      .first()
  ).toBeVisible({
    timeout: SOURCE_DEADLINE_MS
  });
  await page.goto(`${requireBaseURL()}/today`);
  await expect(
    page
      .getByText(
        /BBC Sport|BBC legacy feed|FotMob - Football Live Scores|FotMob legacy scrape|Issue 1909 fixture feed/i
      )
      .and(page.locator(":visible"))
      .first()
  ).toBeVisible({ timeout: SOURCE_DEADLINE_MS });

  const mossSources = (
    await invokeReadTool<{ sources: readonly SourceRow[] }>(page, "sports.listSources", {})
  ).sources;
  expect(mossSources.some((source) => source.id === mirroredSourceId)).toBe(true);

  sources = await listSources(page);
  for (const source of sources) {
    expect(source?.healthState).toBe("healthy");
    expect(source?.lastCheckedAt).toBeTruthy();
    expect(source?.lastSuccessAt).toBeTruthy();
    expect(source?.assignments.every((assignment) => assignment.healthState === "healthy")).toBe(
      true
    );
  }

  const finalSection = await openSportsSettings(page);
  for (const source of sources) {
    const row = finalSection.locator(".sp-src__item").filter({ hasText: source.label });
    await row.getByRole("button", { name: `Remove ${source.label}` }).click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });
  }
});
