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
  await page.getByRole("button", { name: /Standings leagues/ }).click();
  const settings = page.getByRole("group", { name: "Standings leagues" });
  await expect(settings).toBeVisible();
  const keptLabels = new Set(["NFL", "Premier League", "MLB"]);
  const selectedLeagues = settings.getByRole("listbox", { name: "Selected leagues" });
  const selectedOptions = await selectedLeagues.locator("option").evaluateAll((options) =>
    options.map((option) => ({
      label: option.textContent?.trim() ?? "",
      value: (option as HTMLOptionElement).value
    }))
  );
  const removedValues = selectedOptions
    .filter((option) => !keptLabels.has(option.label))
    .map((option) => option.value);
  expect(removedValues.length).toBeGreaterThan(0);
  await selectedLeagues.selectOption(removedValues);
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sports/standings-preferences" &&
      response.request().method() === "PUT"
  );
  await settings.getByRole("button", { name: "Remove selected leagues" }).click();
  expect((await saved).ok(), "saving curated standings leagues").toBe(true);

  await page.reload();
  await expect(settings).toBeVisible();
  await expect(selectedLeagues.getByRole("option")).toHaveCount(keptLabels.size);
  for (const name of keptLabels) {
    await expect(selectedLeagues.getByRole("option", { name, exact: true })).toHaveCount(1);
  }
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
