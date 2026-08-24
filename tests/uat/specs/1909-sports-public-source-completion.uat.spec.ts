import { expect, test, type Locator, type Page } from "@playwright/test";

import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1909 live-path proof. The surface check remains credential-free. The full public-source path
// uses real publisher fetches plus the operator-provided real JSON-capable model, matching the
// product boundary rather than replacing discovery or extraction with fixtures.
export const uatLevel = { level: "solo-admin", without: [] } as const;

test.describe.configure({ mode: "serial" });

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE);
const BBC_FEED_URL = "https://feeds.bbci.co.uk/sport/football/rss.xml";
const FOTMOB_URL = "https://www.fotmob.com";
const MODEL_DISCOVERY_DEADLINE_MS = 60_000;
const SOURCE_DEADLINE_MS = 180_000;
const POLL_INITIAL_INTERVAL_MS = 500;
const POLL_MAX_INTERVAL_MS = 4_000;

interface SourceRow {
  readonly id: string;
  readonly label: string;
  readonly canonicalDomain: string;
  readonly healthState: string;
  readonly lastCheckedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly assignments: readonly {
    readonly targetUrl: string | null;
    readonly healthState: string;
  }[];
}

interface HeadlineRow {
  readonly title: string;
  readonly url: string;
  readonly publisherLabel: string;
  readonly publisherDomain: string;
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
  const section = page.locator('section[aria-label="Custom sports news sources"]');
  await expect(section).toBeVisible();
  return section;
}

async function bringUpRealModel(page: Page): Promise<void> {
  const install = await page.request.post("/api/onboarding/provider-install", {
    data: { providerKind: "anthropic" }
  });
  expect(install.ok(), `provider-install -> ${install.status()}`).toBeTruthy();

  const begin = await page.request.post("/api/onboarding/provider-login/begin", {
    data: { providerKind: "anthropic" }
  });
  expect(begin.ok(), `provider-login/begin -> ${begin.status()}`).toBeTruthy();
  expect((await begin.json()).status).toBe("ready");

  await expect
    .poll(
      async () => {
        const body = (await (await page.request.get("/api/ai/models")).json()) as {
          models: readonly { status: string; capabilities: readonly string[] }[];
        };
        return body.models.some(
          (model) => model.status === "active" && model.capabilities.includes("json")
        );
      },
      { timeout: MODEL_DISCOVERY_DEADLINE_MS }
    )
    .toBe(true);
}

async function createPremierLeagueFollows(page: Page): Promise<readonly string[]> {
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
  return ["All Premier League", arsenal.shortName || arsenal.name];
}

async function addSource(
  section: Locator,
  url: string,
  followLabels: readonly string[]
): Promise<{ readonly domain: string; readonly label: string }> {
  await section.getByLabel("Publication homepage or domain").fill(url);
  for (const label of followLabels) await section.getByLabel(label, { exact: true }).check();
  await section.getByRole("button", { name: "Check", exact: true }).click();

  const candidate = section.locator(".sp-src__candidate").last();
  await expect(candidate, `preview never completed for ${url}`).toBeVisible({
    timeout: SOURCE_DEADLINE_MS
  });
  await expect(candidate.getByText(/^Fetch hosts:/)).toBeVisible();
  for (const label of followLabels) {
    const targetLabel = label.replace(/^All /, "");
    await expect(
      candidate.locator("p.sp-src__hint").filter({ hasText: `${targetLabel}: https://` })
    ).toBeVisible();
  }

  const domain = (await candidate.locator(".sp-src__item-meta").textContent())?.trim();
  const label = (await candidate.locator(".sp-src__candidate-label").textContent())?.trim();
  expect(domain).toBeTruthy();
  expect(label).toBeTruthy();
  await candidate.getByRole("checkbox").check();
  await candidate.getByRole("button", { name: "Add this source" }).click();
  await expect(section.getByText("Source added.")).toBeVisible({ timeout: 30_000 });
  await expect(
    section.locator(".sp-src__item").filter({ hasText: domain as string })
  ).toBeVisible();
  return { domain: domain as string, label: label as string };
}

async function listSources(page: Page): Promise<readonly SourceRow[]> {
  const response = await page.request.get("/api/sports/sources");
  expect(response.ok(), `source list -> ${response.status()}`).toBeTruthy();
  return ((await response.json()) as { sources: readonly SourceRow[] }).sources;
}

async function retrySource(section: Locator, source: SourceRow): Promise<void> {
  const row = section.locator(".sp-src__item").filter({ hasText: source.canonicalDomain });
  await row.getByRole("button", { name: `Retry ${source.label}` }).click();
  await expect(row.getByText("Last checked: Never", { exact: false })).toHaveCount(0, {
    timeout: SOURCE_DEADLINE_MS
  });
}

test("Sports settings exposes truthful public-source controls (#1909)", async ({ page }) => {
  await signIn(page);
  const section = await openSportsSettings(page);
  await expect(section.getByLabel("Publication homepage or domain")).toBeVisible();
  await expect(section.getByRole("button", { name: "Check", exact: true })).toBeVisible();
  await expect(section.getByText("No custom sources yet.")).toBeVisible();
});

test("public publishers reach Sports, Today, recovery, and Moss status (#1909)", async ({
  page
}) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "JARVIS_UAT_REAL_CHAT_TOKEN_FILE is required for real public-source discovery (#1909)"
  );
  test.setTimeout(900_000);

  await signIn(page);
  await bringUpRealModel(page);
  const followLabels = await createPremierLeagueFollows(page);
  const section = await openSportsSettings(page);

  const fotmob = await addSource(section, FOTMOB_URL, followLabels);
  const bbc = await addSource(section, BBC_FEED_URL, followLabels);
  const customDomains = [fotmob.domain, bbc.domain];

  let sources = await listSources(page);
  for (const domain of customDomains) {
    const source = sources.find((candidate) => candidate.canonicalDomain === domain);
    expect(source, `${domain} must persist`).toBeDefined();
    if (source) await retrySource(section, source);
  }

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
        return customDomains.every((domain) =>
          customHeadlines.some((headline) => headline.publisherDomain === domain)
        );
      },
      { timeout: SOURCE_DEADLINE_MS, intervals: [POLL_INITIAL_INTERVAL_MS, POLL_MAX_INTERVAL_MS] }
    )
    .toBe(true);

  for (const domain of customDomains) {
    const urls = customHeadlines
      .filter((headline) => headline.publisherDomain === domain)
      .map((headline) => headline.url);
    expect(new Set(urls).size, `${domain} headlines must dedupe overlapping assignments`).toBe(
      urls.length
    );
  }

  await page.goto(`${requireBaseURL()}/sports`);
  await expect(page.getByText(new RegExp(`${fotmob.label}|${bbc.label}`, "i")).first()).toBeVisible(
    {
      timeout: SOURCE_DEADLINE_MS
    }
  );
  await page.goto(`${requireBaseURL()}/today`);
  await expect(page.getByText(new RegExp(`${fotmob.label}|${bbc.label}`, "i")).first()).toBeVisible(
    {
      timeout: SOURCE_DEADLINE_MS
    }
  );

  const toolResponse = await page.request.post(
    "/api/ai/assistant-tools/sports.listSources/invoke",
    { data: { input: {} } }
  );
  expect(toolResponse.ok(), `sports.listSources -> ${toolResponse.status()}`).toBeTruthy();
  const invocation = (await toolResponse.json()) as {
    invocation?: {
      status?: string;
      result?: { sources?: readonly SourceRow[]; data?: { sources?: readonly SourceRow[] } };
    };
  };
  expect(invocation.invocation?.status).toBe("succeeded");
  const mossSources =
    invocation.invocation?.result?.sources ?? invocation.invocation?.result?.data?.sources ?? [];
  expect(
    customDomains.every((domain) => mossSources.some((source) => source.canonicalDomain === domain))
  ).toBe(true);

  sources = await listSources(page);
  for (const domain of customDomains) {
    const source = sources.find((candidate) => candidate.canonicalDomain === domain);
    expect(source?.healthState).toBe("healthy");
    expect(source?.lastCheckedAt).toBeTruthy();
    expect(source?.lastSuccessAt).toBeTruthy();
    expect(source?.assignments).toHaveLength(2);
    expect(source?.assignments.every((assignment) => assignment.healthState === "healthy")).toBe(
      true
    );
  }

  const finalSection = await openSportsSettings(page);
  for (const source of sources.filter((candidate) =>
    customDomains.includes(candidate.canonicalDomain)
  )) {
    const row = finalSection.locator(".sp-src__item").filter({ hasText: source.canonicalDomain });
    await row.getByRole("button", { name: `Remove ${source.label}` }).click();
    await expect(row).toHaveCount(0, { timeout: 30_000 });
  }
});
