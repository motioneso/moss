import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

let originalLocation: { lat: number; lon: number; label: string } | null | undefined;
let originalUnit: "metric" | "imperial" | undefined;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

async function signIn(page: Page) {
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

async function gotoProfileSettings(page: Page) {
  await page.goto(`${requireBaseURL()}/settings?section=profile`);
  const search = page.getByLabel("Search for a weather location");
  await expect(search).toBeEnabled();
  await expect(page.getByLabel(/Temperature units:/)).toBeEnabled();
}

async function searchAndChoose(page: Page, query: string, expectedLabel: string) {
  await page.getByLabel("Search for a weather location").fill(query);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText(expectedLabel, { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Use this place" }).first().click();
  await expect(page.getByText(`Weather location saved: ${expectedLabel}.`)).toBeVisible();
  await expect(page.getByText(`Currently using ${expectedLabel}.`)).toBeVisible();
}

test("place search, ambiguity handling, and temperature units work through the UI", async ({
  page
}) => {
  await signIn(page);
  const baseURL = requireBaseURL();
  originalLocation = (await (await page.request.get(`${baseURL}/api/me/weather-location`)).json())
    .location;
  originalUnit = (await (await page.request.get(`${baseURL}/api/me/weather-unit`)).json()).unit;

  await gotoProfileSettings(page);
  await searchAndChoose(page, "San Diego", "San Diego, California, United States");
  await page.goto(`${baseURL}/today`);
  await expect(page.locator(".jds-weather-chip__city")).toHaveText(
    "San Diego, California, United States",
    { timeout: 20_000 }
  );

  await gotoProfileSettings(page);
  await searchAndChoose(page, "London", "London, England, United Kingdom");
  await page.goto(`${baseURL}/today`);
  await expect(page.locator(".jds-weather-chip__city")).toHaveText(
    "London, England, United Kingdom",
    { timeout: 20_000 }
  );

  await gotoProfileSettings(page);
  await page.getByLabel("Search for a weather location").fill("Springfield");
  await page.getByRole("button", { name: "Search" }).click();
  const candidates = page.getByRole("button", { name: "Use this place" });
  await expect(candidates.nth(1)).toBeVisible({ timeout: 20_000 });
  expect(await candidates.count()).toBeGreaterThan(1);
  await expect(page.getByText("Currently using London, England, United Kingdom.")).toBeVisible();
  const selectedCandidate = await page
    .getByText(/Springfield, .*United States/, { exact: true })
    .first()
    .innerText();
  await candidates.first().click();
  await expect(page.getByText(`Currently using ${selectedCandidate}.`)).toBeVisible();

  const unitToggle = page.getByLabel(/Temperature units:/);
  if (await unitToggle.isChecked()) {
    await unitToggle.locator("..").click();
    await expect(page.getByText("Weather temperatures are shown in Celsius.")).toBeVisible();
  }
  await expect(page.getByLabel("Temperature units: Celsius")).toBeVisible();
  await expect(page.getByLabel("Temperature units: Celsius").locator("..")).toContainText("C");
  await page.goto(`${baseURL}/today`);
  const metricTemp = await page.locator(".jds-weather-chip__temp").innerText();
  await gotoProfileSettings(page);
  const unitResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/me/weather-unit") && response.request().method() === "PUT"
  );
  await page.getByLabel("Temperature units: Celsius").locator("..").click();
  expect((await (await unitResponse).json()).unit).toBe("imperial");
  await expect(page.getByText("Weather temperatures are shown in Fahrenheit.")).toBeVisible();
  await expect(page.getByLabel("Temperature units: Fahrenheit")).toBeVisible();
  await expect(page.getByLabel("Temperature units: Fahrenheit").locator("..")).toContainText("F");
  await expect(page.getByText(`Currently using ${selectedCandidate}.`)).toBeVisible();

  await page.goto(`${baseURL}/today`);
  await expect(page.locator(".jds-weather-chip__city")).toHaveText(selectedCandidate, {
    timeout: 20_000
  });
  await expect(page.locator(".jds-weather-chip__temp")).not.toHaveText(metricTemp);
});

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  try {
    if (originalLocation === undefined || originalUnit === undefined) return;
    await signIn(page);
    const baseURL = requireBaseURL();
    await page.request.put(`${baseURL}/api/me/weather-location`, { data: originalLocation });
    await page.request.put(`${baseURL}/api/me/weather-unit`, { data: { unit: originalUnit } });
  } finally {
    await page.close();
  }
});
