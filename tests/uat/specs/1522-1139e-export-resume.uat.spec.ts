import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1522 (1139-E) live-path proof: Settings -> Account & preferences -> "Your data" export
// (apps/web/src/settings/settings-profile-subviews.tsx's DataExport) persists its in-progress
// job id to sessionStorage so navigating away and back (full unmount/remount of DataExport per
// settings-page.tsx:346's component-identity Pane swap) resumes tracking the same job instead of
// starting a duplicate. Mirrors tests/e2e/settings-shell.spec.ts's mocked "data export resumes
// across remount" test, but against the real server/worker.
export const uatLevel = { level: "solo-admin", without: [] } as const;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

// Mirrors 1402-weather-location-settings.uat.spec.ts's signIn(): `solo-admin` still has first-run
// onboarding pending, skip it only when shown.
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
  const nav = page.getByRole("navigation", { name: "Settings categories" });
  await expect(nav).toBeVisible();
}

test("data export resumes across a real Settings remount, no duplicate job (#1522)", async ({
  page
}) => {
  let exportPostCount = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/me/export")) {
      exportPostCount += 1;
    }
  });

  await signIn(page);
  await gotoProfileSettings(page);
  const nav = page.getByRole("navigation", { name: "Settings categories" });

  // Clean slate: a prior run's export may still be tracked in this browser's sessionStorage
  // origin, but sessionStorage is per-tab/per-test-run here, so the idle "Prepare export" state is
  // expected on a fresh page.
  const prepareBtn = page.getByRole("button", { name: "Prepare export" });
  await expect(prepareBtn).toBeVisible();

  await prepareBtn.click();

  // Real server: either "Queued…" or "Building your archive…" — do not pin one, small seeded
  // data may race straight through "pending".
  const inProgress = page.getByText("Building your archive…").or(page.getByText("Queued…"));
  const ready = page.getByRole("link", { name: "Download" });
  await expect(inProgress.or(ready).first()).toBeVisible({ timeout: 15_000 });
  expect(exportPostCount).toBe(1);

  const jobIdBefore = await page.evaluate(() =>
    window.sessionStorage.getItem("moss.settings.export-job-id")
  );
  expect(jobIdBefore).not.toBeNull();

  // Remount DataExport: navigate away to a different settings section and back. Full
  // unmount/remount of the ProfilePane per settings-page.tsx:346's component-identity Pane swap.
  await nav.getByRole("button", { name: "Modules" }).click();
  await nav.getByRole("button", { name: "Account & preferences" }).click();

  // The resumed job must still be tracked (in-progress or already ready) and must NOT have
  // started a second export job.
  await expect(inProgress.or(ready).first()).toBeVisible({ timeout: 15_000 });
  expect(exportPostCount).toBe(1);

  const jobIdAfter = await page.evaluate(() =>
    window.sessionStorage.getItem("moss.settings.export-job-id")
  );
  expect(jobIdAfter).toBe(jobIdBefore);

  // Wait for completion and confirm the download link targets the resumed job id.
  await expect(ready).toBeVisible({ timeout: 60_000 });
  await expect(ready).toHaveAttribute(
    "href",
    new RegExp(`/api/me/export/download/${jobIdBefore}$`)
  );
  await page.screenshot({
    path: test.info().outputPath("export-resumed-ready.png"),
    fullPage: true
  });

  // Cleanup: return to idle state so this run leaves no lingering job pointer for the next one.
  await page.getByRole("button", { name: "Prepare a new export" }).click();
  await nav.getByRole("button", { name: "Modules" }).click();
  await nav.getByRole("button", { name: "Account & preferences" }).click();
  await expect(page.getByRole("button", { name: "Prepare export" })).toBeVisible();
  expect(
    await page.evaluate(() => window.sessionStorage.getItem("moss.settings.export-job-id"))
  ).toBeNull();
});
