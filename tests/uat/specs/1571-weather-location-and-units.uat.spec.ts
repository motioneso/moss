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
  const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
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
  await expect(page.getByRole("group", { name: "Unit" })).toBeVisible();
}

async function searchAndChoose(page: Page, query: string, expectedLabel: string) {
  await page.getByLabel("Search for a weather location").fill(query);
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText(expectedLabel, { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Use this place" }).first().click();
  await expect(page.getByText(`Weather location saved: ${expectedLabel}.`)).toBeVisible();
  await expect(page.getByText(`Using ${expectedLabel}, set by searching.`)).toBeVisible();
}

// Today's weather row names no place (study layout, #2641), so the place is read from the weather
// request Today makes on this navigation. Waiting is armed after the place change, so an earlier
// response cannot satisfy it.
async function gotoTodayWeather(page: Page): Promise<{ location: string; unit: string }> {
  const weatherResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/weather/today") && response.request().method() === "GET"
  );
  await page.goto(`${requireBaseURL()}/today`);
  const body = (await (await weatherResponse).json()) as {
    data: { location: string; unit: string } | null;
  };
  expect(body.data).not.toBeNull();
  return body.data!;
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
  expect((await gotoTodayWeather(page)).location).toBe("San Diego, California, United States");

  await gotoProfileSettings(page);
  await searchAndChoose(page, "London", "London, England, United Kingdom");
  expect((await gotoTodayWeather(page)).location).toBe("London, England, United Kingdom");

  await gotoProfileSettings(page);
  await page.getByLabel("Search for a weather location").fill("Springfield");
  await page.getByRole("button", { name: "Search" }).click();
  const candidates = page.getByRole("button", { name: "Use this place" });
  await expect(candidates.nth(1)).toBeVisible({ timeout: 20_000 });
  expect(await candidates.count()).toBeGreaterThan(1);
  await expect(
    page.getByText("Using London, England, United Kingdom.", { exact: true })
  ).toBeVisible();
  const selectedCandidate = await page
    .getByText(/Springfield, .*United States/, { exact: true })
    .first()
    .innerText();
  await candidates.first().click();
  await expect(page.getByText(`Using ${selectedCandidate}, set by searching.`)).toBeVisible();

  const unitGroup = page.getByRole("group", { name: "Unit" });
  const celsiusButton = unitGroup.getByRole("button", { name: "Celsius" });
  const fahrenheitButton = unitGroup.getByRole("button", { name: "Fahrenheit" });
  if ((await fahrenheitButton.getAttribute("aria-pressed")) === "true") {
    await celsiusButton.click();
    await expect(page.getByText("Temperatures are shown in Celsius.")).toBeVisible();
  }
  await expect(celsiusButton).toHaveAttribute("aria-pressed", "true");
  expect((await gotoTodayWeather(page)).unit).toBe("metric");
  await expect(page.locator(".wx-now small")).toHaveText("C");
  await gotoProfileSettings(page);
  const unitResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/me/weather-unit") && response.request().method() === "PUT"
  );
  await fahrenheitButton.click();
  expect((await (await unitResponse).json()).unit).toBe("imperial");
  await expect(page.getByText("Temperatures are shown in Fahrenheit.")).toBeVisible();
  await expect(fahrenheitButton).toHaveAttribute("aria-pressed", "true");
  await expect(celsiusButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText(`Using ${selectedCandidate}.`, { exact: true })).toBeVisible();

  const imperialWeather = await gotoTodayWeather(page);
  expect(imperialWeather.location).toBe(selectedCandidate);
  expect(imperialWeather.unit).toBe("imperial");
  await expect(page.locator(".wx-now small")).toHaveText("F");
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
