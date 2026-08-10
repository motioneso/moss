import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1402 lane C, Stage 1 (docs/superpowers/plans/2026-08-09-w6c1-secure-context.md, Task 6): proves
// the manual weather-location override end to end against the real server —
//   1. Settings -> Personal -> "Weather location" group persists a manual override
//      (apps/web/src/settings/settings-personal-panes.tsx) across a reload.
//   2. The override is actually consumed by weather resolution
//      (packages/weather/src/weather-service.ts's resolveLocation: stored preference takes
//      priority over ip-geo/timezone fallback) — the shell's header weather chip
//      (apps/web/src/today/header-weather.tsx, mounted in apps/web/src/shell/app-shell.tsx) shows
//      the override's label as its city text.
//   3. Clearing the override reverts to fallback behavior with no crash and no stale value.
export const uatLevel = { level: "solo-admin", without: [] } as const;

const OVERRIDE_LABEL = "UAT Weather Override";
const OVERRIDE_LAT = "51.5074";
const OVERRIDE_LON = "-0.1278";

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

// Mirrors runtime-context.uat.spec.ts's signIn(): `solo-admin` returns before the onboarding
// chunk, so the seeded owner still has first-run onboarding pending. Skip it only when shown.
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

// apps/web/src/settings/settings-page.tsx: the "profile" section id maps to ProfilePane, which
// renders the Weather location group directly — no nav click needed, a direct route with the
// section query param is the house pattern (moss-assistant-name.uat.spec.ts,
// app-map-grounding.uat.spec.ts).
async function gotoProfileSettings(page: Page) {
  await page.goto(`${requireBaseURL()}/settings?section=profile`);
  await expect(page.getByLabel("Weather location label")).toBeVisible();
}

test.describe.serial("weather location manual override (#1402)", () => {
  let hadOriginalOverride = false;
  let originalLabel = "";
  let originalLat = "";
  let originalLon = "";

  test("manual override persists across reload and flows into /today's weather chip", async ({
    page
  }) => {
    await signIn(page);
    await gotoProfileSettings(page);

    // Capture the pre-test values (shared UAT DB) so afterAll can restore exactly what was there,
    // mirroring moss-assistant-name.uat.spec.ts's originalAssistantName capture.
    originalLabel = await page.getByLabel("Weather location label").inputValue();
    originalLat = await page.getByLabel("Weather location latitude").inputValue();
    originalLon = await page.getByLabel("Weather location longitude").inputValue();
    hadOriginalOverride = originalLabel !== "";

    await page.getByLabel("Weather location label").fill(OVERRIDE_LABEL);
    await page.getByLabel("Weather location latitude").fill(OVERRIDE_LAT);
    await page.getByLabel("Weather location longitude").fill(OVERRIDE_LON);
    await page.getByRole("button", { name: "Save" }).click();

    await expect(page.getByText(`Currently using ${OVERRIDE_LABEL}.`)).toBeVisible();

    // Reload: confirm the fields still reflect the saved override (persistence, not just local
    // React state).
    await page.reload();
    await expect(page.getByLabel("Weather location label")).toHaveValue(OVERRIDE_LABEL);
    await expect(page.getByLabel("Weather location latitude")).toHaveValue(OVERRIDE_LAT);
    await expect(page.getByLabel("Weather location longitude")).toHaveValue(OVERRIDE_LON);
    await expect(page.getByText(`Currently using ${OVERRIDE_LABEL}.`)).toBeVisible();

    // /today's shell header weather chip resolves via the same stored preference
    // (packages/weather/src/weather-service.ts resolveLocation) — its city text should now read
    // the override's label, proving the override actually feeds weather resolution and not just
    // the settings form.
    await page.goto(`${requireBaseURL()}/today`);
    await expect(page.locator(".jds-weather-chip__city")).toHaveText(OVERRIDE_LABEL, {
      timeout: 15_000
    });
  });

  test("clearing the override reverts to fallback with no crash and no stale value", async ({
    page
  }) => {
    await signIn(page);
    await gotoProfileSettings(page);

    await expect(page.getByText(`Currently using ${OVERRIDE_LABEL}.`)).toBeVisible();
    await page.getByRole("button", { name: "Clear override" }).click();

    await expect(page.getByText("Using automatic timezone-based location.")).toBeVisible();
    await expect(page.getByLabel("Weather location label")).toHaveValue("");
    await expect(page.getByLabel("Weather location latitude")).toHaveValue("");
    await expect(page.getByLabel("Weather location longitude")).toHaveValue("");

    // /today must still render without crashing and without showing the cleared override's
    // stale label.
    await page.goto(`${requireBaseURL()}/today`);
    await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();
    const cityChip = page.locator(".jds-weather-chip__city");
    if (await cityChip.isVisible()) {
      await expect(cityChip).not.toHaveText(OVERRIDE_LABEL);
    }
  });

  test.afterAll(async ({ browser }) => {
    // Restore original override state so this spec leaves no residue on the shared UAT DB. The
    // "clearing" test above already leaves the override cleared, which is correct when the seeded
    // admin had none to begin with; only re-save when one was actually present.
    if (!hadOriginalOverride) return;
    const page = await browser.newPage();
    try {
      await signIn(page);
      await gotoProfileSettings(page);
      await page.getByLabel("Weather location label").fill(originalLabel);
      await page.getByLabel("Weather location latitude").fill(originalLat);
      await page.getByLabel("Weather location longitude").fill(originalLon);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(page.getByText(`Currently using ${originalLabel}.`)).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
