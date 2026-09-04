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
  // The section starts collapsed; open it from its heading first.
  await page.getByRole("button", { name: /Configure standings/ }).click();
  const settings = page.getByRole("group", { name: "Configure standings" });
  await expect(settings).toBeVisible();
  const keptLabels = new Set(["NFL", "Premier League", "MLB"]);
  // Soccer leagues sit under collapsed country rows; open every country so each league checkbox
  // is reachable, then untick everything outside the kept set. Each change saves on its own.
  const countryRows = settings.getByRole("button", { expanded: false });
  while ((await countryRows.count()) > 0) await countryRows.first().click();
  const leagueNames = await settings
    .locator("label.sp-standings-tree__check:has(input:not([aria-label])) > span:last-child")
    .allTextContents();
  expect(leagueNames.length).toBeGreaterThan(keptLabels.size);
  let removed = 0;
  for (const name of leagueNames) {
    if (keptLabels.has(name)) continue;
    const box = settings.getByRole("checkbox", { name, exact: true });
    if (!(await box.isChecked())) continue;
    const saved = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/sports/standings-preferences" &&
        response.request().method() === "PUT"
    );
    // The real input is visually hidden by the design system, so click the label text.
    await settings.getByText(name, { exact: true }).click();
    await expect(box).not.toBeChecked();
    expect((await saved).ok(), `saving after unticking ${name}`).toBe(true);
    removed += 1;
  }
  expect(removed).toBeGreaterThan(0);

  await page.reload();
  await page.getByRole("button", { name: /Configure standings/ }).click();
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: /^Soccer/ }).click();
  await settings.getByRole("button", { name: /England/ }).click();
  for (const name of keptLabels) {
    await expect(settings.getByRole("checkbox", { name, exact: true })).toBeChecked();
  }
  await expect(settings.getByRole("checkbox", { name: "NBA", exact: true })).not.toBeChecked();
  console.log("[live proof] Sports Settings persisted NFL, Premier League, and MLB only");

  await page.goto(`${requireBaseURL()}/sports`);
  const trigger = page.getByRole("button", { name: "Select standings league" });
  await expect(trigger).toBeVisible();
  await trigger.press("Enter");
  const picker = page.getByRole("menu", { name: "Standings leagues" });
  await expect(picker).toBeVisible();
  const following = picker.getByRole("group", { name: "Following" });
  for (const name of ["NBA", "NFL", "Premier League"]) {
    await expect(following.getByRole("menuitemradio", { name, exact: true })).toHaveCount(1);
    await expect(picker.getByRole("menuitemradio", { name, exact: true })).toHaveCount(1);
  }
  await expect(picker.getByRole("menuitemradio", { name: "NHL", exact: true })).toHaveCount(0);

  const baseball = picker.getByRole("menuitem", { name: "Baseball", exact: true });
  await baseball.focus();
  await baseball.press("Enter");

  const standingsResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sports/standings" &&
      new URL(response.url()).searchParams.get("competitionKey") === "mlb"
  );
  const mlb = picker.getByRole("menuitemradio", { name: "MLB", exact: true });
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
