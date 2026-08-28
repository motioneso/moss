import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2006 live-path proof. The real key is supplied only through the environment and is never
// included in an assertion message, URL, screenshot, or log.
export const uatLevel = { level: "admin+data", without: [] } as const;

test.setTimeout(360_000);

const CONNECTION_HOST = "newsapi.org";
const WRONG_KEY = "obviously-wrong-newsapi-key";

function baseUrl(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

function realKey(): string {
  const value = process.env.JARVIS_UAT_NEWSAPI_KEY?.trim();
  if (!value) {
    throw new Error("JARVIS_UAT_NEWSAPI_KEY is required for the credentialed News live path");
  }
  return value;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(baseUrl());
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

async function openNewsSettings(page: Page): Promise<void> {
  await page.goto(`${baseUrl()}/settings?section=modules&module=news`);
  await expect(page.getByRole("heading", { name: "News" })).toBeVisible();
}

async function overviewArticles(page: Page): Promise<readonly { canonicalDomain?: unknown }[]> {
  const response = await page.request.get("/api/news/overview");
  expect(response.ok(), `news overview -> ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as {
    topStories?: readonly { canonicalDomain?: unknown }[];
    rankedStories?: readonly { canonicalDomain?: unknown }[];
  };
  return body.rankedStories ?? body.topStories ?? [];
}

test("connects, rotates, and revokes a real credentialed News source", async ({ page }) => {
  const key = realKey();
  await signIn(page);
  await openNewsSettings(page);

  const sourceInput = page.getByLabel("Publication homepage or domain");
  await sourceInput.fill(CONNECTION_HOST);
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByLabel("Access key")).toBeVisible();

  const urls: string[] = [];
  page.on("request", (request) => urls.push(request.url()));
  await page.getByLabel("Access key").fill(key);
  await page.getByLabel("I have permission to use this key here.").check();
  const connectRequest = page.waitForRequest(
    (request) =>
      request.url().includes("/api/news/sources/credentialed") && request.method() === "POST"
  );
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const request = await connectRequest;
  const body = request.postDataJSON() as { apiKey?: unknown };
  if (body.apiKey !== key) throw new Error("the connect request did not contain the supplied key");
  for (const url of urls) expect(url).not.toContain(key);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(
      async () => {
        const articles = await overviewArticles(page);
        return articles.some((article) => article.canonicalDomain === CONNECTION_HOST);
      },
      { timeout: 180_000, intervals: [1_000, 2_000, 4_000, 8_000] }
    )
    .toBe(true);

  await openNewsSettings(page);
  await page.getByRole("button", { name: "Replace key for NewsAPI" }).click();
  await page.getByLabel("Access key").fill(WRONG_KEY);
  await page.getByLabel("I have permission to use this key here.").check();
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("Your previous key is still active.")).toBeVisible({
    timeout: 30_000
  });

  await page.getByLabel("Access key").fill(key);
  await page.getByLabel("I have permission to use this key here.").check();
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Revoke access for NewsAPI" }).click();
  await page.getByRole("button", { name: "Yes, revoke" }).click();
  await expect(page.getByText("Access revoked", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Add a new key to reconnect this source.")).toBeVisible();

  await expect
    .poll(
      async () => {
        const articles = await overviewArticles(page);
        return articles.some((article) => article.canonicalDomain === CONNECTION_HOST);
      },
      { timeout: 60_000, intervals: [1_000, 2_000, 4_000] }
    )
    .toBe(false);
});
