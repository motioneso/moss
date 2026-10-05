// Live-Path Gate for #2984 R2.6, step one: the connection made before the upgrade.
//
// Run this file against the app built from 4ea503e67, the last commit before any classifier
// code, on a fresh scratch database. It creates the owner through the first-run screen and adds
// a connection to the stand-in tool server through the old Connections screen. The second file,
// classifier-2984-r26-uat.spec.ts, then runs on current main against the same database.
//
// Run with:
//   LIVE_BASE_URL=http://127.0.0.1:<web port> LIVE_OWNER_EMAIL=... LIVE_OWNER_PASSWORD=... \
//   LIVE_R26_TOOL_SERVER=http://127.0.0.1:<tool server port> LIVE_R26_SHOT_DIR=/tmp/... \
//     npx playwright test --config playwright.live.config.ts classifier-2984-r26-before-upgrade
import { expect, test } from "@playwright/test";
import { OLD_HUB, R26, r26ToolList, setToolServerTools } from "./classifier-2984-r26-helpers.js";

test("before the upgrade: owner signs up and connects the tool server on the old screen", async ({
  page
}) => {
  test.setTimeout(180_000);
  await setToolServerTools(r26ToolList());

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create owner account" })).toBeVisible();
  await page.getByLabel("Name").fill("Proof owner");
  await page.getByLabel("Email").fill(R26.ownerEmail);
  await page.getByLabel("Password").fill(R26.ownerPassword);
  await page.locator("form").getByRole("button", { name: "Create account" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  await expect(skipSetup.or(page.getByRole("navigation").first()).first()).toBeVisible({
    timeout: 30_000
  });
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }

  await page.goto("/settings?section=integrations");
  await page.getByRole("button", { name: "Add connection" }).click();
  await page.getByLabel("Name").fill(OLD_HUB);
  await page.getByLabel("URL").fill(`${R26.toolServer}/mcp`);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(/^\d+ tools on$/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Connected").first()).toBeVisible();
  await page.screenshot({ path: `${R26.shotDir}/r26-01-old-screen-connected-desktop.png` });
});
