import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD, UAT_ADMIN_ID } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";
export const uatLevel = { level: "solo-admin", without: [] } as const;

test("3773 real Settings Connections at desktop and phone widths", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const project = process.env.JARVIS_UAT_PROJECT_NAME!;
  const account = "37730000-0000-4000-8000-000000000001";
  // Disposable persisted cached-calendar state. No browser binding or external sync is claimed.
  execUatSql(
    project,
    `
    INSERT INTO app.connector_accounts(id, provider_id, owner_user_id, scopes, status, encrypted_secret)
    VALUES ('${account}', 'outlook-browser-calendar', '${UAT_ADMIN_ID}', ARRAY['calendar.readonly'], 'active', '{}');
    INSERT INTO app.preferences(owner_user_id, key, value_json)
    VALUES ('${UAT_ADMIN_ID}', 'connector.${account}.outlook_calendar_health',
      jsonb_build_object('state','current','lastCompleteAt',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'windowStart','2026-10-27','windowEnd','2026-11-03','unconfirmed',1));
  `
  );
  const responses: Record<string, number> = {};
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (
      [
        "/api/connectors/outlook-calendar",
        "/api/connectors/accounts",
        "/api/me/notes-source",
        "/api/integrations"
      ].includes(path)
    )
      responses[path] = response.status();
  });
  await page.setViewportSize({ width: 1280, height: 1800 });
  await page.goto(process.env.JARVIS_UAT_BASE_URL!);
  await page.getByLabel("Email", { exact: true }).fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(UAT_ADMIN_PASSWORD);
  await page.locator("form").getByRole("button", { name: "Sign in", exact: true }).click();
  const skip = page.getByRole("button", { name: "Skip setup", exact: true });
  const menu = page.getByRole("button", { name: "Account menu", exact: false });
  await expect(skip.or(menu).first()).toBeVisible({ timeout: 30000 });
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway", exact: true }).click();
  }
  await expect(menu).toBeVisible({ timeout: 30000 });
  await menu.click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const outlook = page.getByLabel("Outlook calendar connection", { exact: true });
  await expect(outlook).toBeVisible();
  const folder = page.locator(".pane__card").filter({ has: page.locator(".vault") });
  await expect(folder.getByText("No folder linked", { exact: true })).toBeVisible();
  await expect(
    folder.getByText("Choose a folder on the server to include your notes as context.", {
      exact: true
    })
  ).toBeVisible();
  expect((await folder.innerText()).match(/Choose a folder/g)?.length).toBe(1);
  await expect(outlook).toContainText("Read only");
  await expect(outlook).toContainText("Up to date within covered dates");
  await expect(outlook).toContainText("2026-10-27 through 2026-11-03");
  await expect(outlook).toContainText("1 previously seen meeting needs verification");
  await expect(outlook.locator(".jds-indicator__dot")).toHaveCount(1);
  await expect(outlook.locator(".jds-note")).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain(
    "Everything Moss can reach outside itself"
  );
  const output =
    process.env.MOSS_SETTINGS_TRIM_EVIDENCE_DIR ?? testInfo.outputPath("settings-trim");
  mkdirSync(output, { recursive: true });
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1280 ? 1800 : 844 });
    await outlook.scrollIntoViewIfNeeded();
    await expect(outlook).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `overflow ${width}`
    ).toBe(true);
    await outlook.screenshot({ path: `${output}/outlook-${width}.png` });
    await folder.scrollIntoViewIfNeeded();
    await expect(folder.getByText("No folder linked", { exact: true })).toBeInViewport();
    await folder.screenshot({ path: `${output}/notes-${width}.png` });
    console.log(
      `SETTINGS_TRIM_LIVE width=${width} compactOutlook=true readOnly=true coverage=true warning=true notesExplanationCount=1 horizontalOverflow=false`
    );
  }
  for (const path of [
    "/api/connectors/outlook-calendar",
    "/api/connectors/accounts",
    "/api/me/notes-source",
    "/api/integrations"
  ])
    expect(responses[path], path).toBe(200);
  console.log(
    `SETTINGS_TRIM_LIVE realLogin=true realSettingsNavigation=true network=${JSON.stringify(responses)} seededCachedCalendar=true externalSync=unexercised`
  );
});
