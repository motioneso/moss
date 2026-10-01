import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

// #2533: a Today jump link scrolled its target flush under the sticky .topbar. Proof: after
// following the link on a real instance, the target's top edge sits below the topbar's bottom edge.
test("Today jump-link targets land below the sticky topbar", async ({ page }) => {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".topbar")).toBeVisible();
  await expect(page.locator("#widgets")).toBeAttached();

  const gapBelowTopbar = (id: string) =>
    page.evaluate((targetId) => {
      const bar = document.querySelector(".topbar")!.getBoundingClientRect();
      const target = document.getElementById(targetId)!.getBoundingClientRect();
      return Math.round(target.top - bar.bottom);
    }, id);

  await page.setViewportSize({ width: 1280, height: 400 });
  const present = await page.evaluate(() =>
    ["start-here", "needs-you", "widgets", "goals", "news", "sports"].filter((id) =>
      document.getElementById(id)
    )
  );
  console.log(`jump targets present: ${present.join(", ")}`);
  console.log(
    `page scrollable px: ${await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)}`
  );

  // Follow the real section link when one exists, otherwise navigate by hash.
  for (const id of present) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const link = page.locator(`nav[aria-label="Sections"] a[href="#${id}"]`);
    if (await link.count()) {
      await link.first().click();
    } else {
      await page.evaluate((hash) => {
        window.location.hash = "";
        window.location.hash = hash;
      }, `#${id}`);
    }
    await page.waitForTimeout(400);
    console.log(`${id} gap below topbar: ${await gapBelowTopbar(id)}px`);
  }
  expect(present.length).toBeGreaterThan(0);
  for (const id of present) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate((hash) => {
      window.location.hash = "";
      window.location.hash = hash;
    }, `#${id}`);
    await page.waitForTimeout(400);
    const scrolled = await page.evaluate(() => window.scrollY);
    if (scrolled > 0) {
      expect(await gapBelowTopbar(id), `#${id} gap`).toBeGreaterThanOrEqual(8);
    }
  }
});
