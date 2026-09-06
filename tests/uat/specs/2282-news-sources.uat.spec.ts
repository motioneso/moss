import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2282 live-path proof. r/technology is a real, public subreddit — no key or credential is
// needed, unlike the #2006 credentialed-source path this test is modelled on.
export const uatLevel = { level: "admin+data", without: [] } as const;

test.setTimeout(360_000);

const SUBREDDIT_INPUT = "r/technology";
const SUBREDDIT_LABEL = "r/technology";

function baseUrl(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
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

async function overviewStories(page: Page): Promise<readonly { sourceLabel?: unknown }[]> {
  const response = await page.request.get("/api/news/overview");
  expect(response.ok(), `news overview -> ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as {
    topStories?: readonly { sourceLabel?: unknown }[];
    rankedStories?: readonly { sourceLabel?: unknown }[];
  };
  return body.rankedStories ?? body.topStories ?? [];
}

test("adding r/technology as a source shows its articles in News", async ({ page }) => {
  await signIn(page);
  await openNewsSettings(page);

  await page.getByRole("button", { name: "Add a source" }).click();
  const sourceInput = page.getByLabel("Source homepage or domain");
  await sourceInput.fill(SUBREDDIT_INPUT);
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByText(SUBREDDIT_LABEL, { exact: true }).first()).toBeVisible({
    timeout: 30_000
  });

  await page.getByRole("button", { name: "Add this source" }).click();
  await expect(page.getByText("Source added", { exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: `Remove ${SUBREDDIT_LABEL}` })).toBeVisible();

  await expect
    .poll(
      async () => {
        const stories = await overviewStories(page);
        return stories.some((story) => story.sourceLabel === SUBREDDIT_LABEL);
      },
      { timeout: 180_000, intervals: [1_000, 2_000, 4_000, 8_000] }
    )
    .toBe(true);

  await openNewsSettings(page);
  await page.getByRole("button", { name: `Remove ${SUBREDDIT_LABEL}` }).click();
  await expect(page.getByRole("button", { name: `Remove ${SUBREDDIT_LABEL}` })).toHaveCount(0, {
    timeout: 30_000
  });
});
