import { expect, test, type Page } from "@playwright/test";

import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "admin+data",
  without: []
} as const;

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

test("saves a curated league set and uses the keyboard picker on Sports", async ({ page }) => {
  test.setTimeout(300_000);
  await signIn(page);

  await page.goto(`${requireBaseURL()}/settings?section=modules&module=sports`);
  const settings = page.getByRole("group", { name: "Standings leagues" });
  await expect(settings).toBeVisible();
  const keptLabels = new Set(["NFL", "Premier League", "MLB"]);
  const labels = await settings.locator("label").allTextContents();
  expect(labels.length).toBeGreaterThan(keptLabels.size);

  for (const label of labels) {
    const name = label.trim();
    const checkbox = settings.getByRole("checkbox", { name, exact: true });
    if (keptLabels.has(name)) {
      await expect(checkbox).toBeChecked();
      continue;
    }
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/sports/standings-preferences" &&
        response.request().method() === "PUT"
    );
    await checkbox.click();
    expect((await saved).ok(), `saving standings after unchecking ${name}`).toBe(true);
    await expect(checkbox).not.toBeChecked();
  }

  await page.reload();
  await expect(settings).toBeVisible();
  await expect(settings.getByRole("checkbox", { checked: true })).toHaveCount(keptLabels.size);
  for (const name of keptLabels) {
    await expect(settings.getByRole("checkbox", { name, exact: true })).toBeChecked();
  }
  console.log("[live proof] Sports Settings persisted NFL, Premier League, and MLB only");

  await page.goto(`${requireBaseURL()}/sports`);
  const trigger = page.getByRole("button", { name: "Select standings league" });
  await expect(trigger).toBeVisible();
  await trigger.press("Enter");
  const picker = page.getByRole("listbox", { name: "Standings leagues" });
  await expect(picker).toBeVisible();
  const following = picker.getByRole("group", { name: "Following" });
  for (const name of ["NBA", "NFL", "Premier League"]) {
    await expect(following.getByRole("option", { name, exact: true })).toHaveCount(1);
    await expect(picker.getByRole("option", { name, exact: true })).toHaveCount(1);
  }
  await expect(picker.getByRole("option", { name: "NHL", exact: true })).toHaveCount(0);

  const standingsResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sports/standings" &&
      new URL(response.url()).searchParams.get("competitionKey") === "mlb"
  );
  const mlb = picker.getByRole("option", { name: "MLB", exact: true });
  await mlb.focus();
  await mlb.press("Enter");
  expect((await standingsResponse).ok(), "lazy MLB standings request").toBe(true);
  await expect(trigger).toHaveText("MLB");
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  console.log(
    "[live proof] Following was deduplicated and keyboard selection loaded MLB standings"
  );
});
