import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Park Press check 4 (PR 3348), LN09: the Sports screen carries no preview navigation and no
// invented destination. Every in-app link on the screen must be on a short known list.
export const uatLevel = { level: "admin+data", without: [] } as const;

function baseURL(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

test("Sports screen: no preview navigation, no invented destination (LN09)", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(baseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const menu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skip.or(menu).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible();

  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Sports" })
    .click();
  await expect(page).toHaveURL(/\/sports$/);
  await expect(page.getByRole("button", { name: "Select standings league" })).toBeVisible({
    timeout: 30_000
  });

  const main = page.locator("main");
  const links = await main.evaluate((root) =>
    Array.from(root.querySelectorAll("a[href]")).map((a) => ({
      href: a.getAttribute("href") ?? "",
      text: (a.textContent ?? "").trim().slice(0, 50),
      label: a.getAttribute("aria-label") ?? ""
    }))
  );
  const buttons = await main.evaluate((root) =>
    Array.from(root.querySelectorAll("button")).map((b) =>
      ((b.getAttribute("aria-label") ?? b.textContent) || "").trim().slice(0, 50)
    )
  );
  console.log(`[check4] sports links: ${JSON.stringify(links)}`);
  console.log(`[check4] sports buttons: ${JSON.stringify(buttons)}`);

  // No link or button leads to anything called preview.
  for (const l of links) {
    expect(`${l.href} ${l.text} ${l.label}`.toLowerCase()).not.toContain("preview");
  }
  for (const b of buttons) expect(b.toLowerCase()).not.toContain("preview");

  // Every link is external story content, or the one known Settings destination.
  const inApp = links.filter((l) => !/^https?:\/\//.test(l.href));
  for (const l of inApp) {
    expect(l.href).toMatch(/^\/settings\?section=modules&module=sports$/);
  }
  const external = links.filter((l) => /^https?:\/\//.test(l.href));
  for (const l of external) expect(new URL(l.href).origin).not.toBe(new URL(baseURL()).origin);
});
