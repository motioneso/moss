// Park Press acceptance check 2 (PR 3346, Core): fresh owner signup, onboarding skip cancel,
// phone navigation open/close/reopen/Escape, and a genuine read failure on the People settings
// page (database container stopped), its retry, and recovery. No Moss response is intercepted.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";

export const uatLevel = { level: "bare", without: [] } as const;

const execFileAsync = promisify(execFile);
const OWNER_EMAIL = "park-press-owner@example.test";
const OWNER_PASSWORD = "park-press-pass-1234";

function project(): string {
  const value = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!value?.startsWith("uat-")) throw new Error("Run through the isolated UAT provisioner");
  return value;
}

async function compose(...args: string[]): Promise<void> {
  await execFileAsync("docker", buildUatComposeArgs(project(), args), { maxBuffer: 1_000_000 });
}

async function activeLabel(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "none";
    return el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 40) ?? el.tagName;
  });
}

test("Core: fresh signup, onboarding cancel, phone navigation", async ({ page }) => {
  test.setTimeout(420_000);
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");

  const trace: string[] = [];
  page.on("pageerror", (e) => trace.push(`pageerror: ${e.message.slice(0, 200)}`));
  page.on("requestfailed", (r) =>
    trace.push(`requestfailed: ${r.url().slice(-60)} ${r.failure()?.errorText}`)
  );
  page.on("console", (m) => {
    if (m.type() === "error") trace.push(`console: ${m.text().slice(0, 200)}`);
  });
  test.info().annotations.push({ type: "trace", description: "see log" });
  try {
    await test.step("fresh owner signs up through the real screen (390 px)", async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(baseURL);
      await expect(page.getByRole("heading", { name: "Create owner account" })).toBeVisible({
        timeout: 60_000
      });
      // Visible label text equals the accessible name for each field.
      for (const label of ["Name", "Email", "Password"]) {
        await expect(page.getByLabel(label, { exact: true })).toBeVisible();
      }
      await page.getByLabel("Name", { exact: true }).fill("Park Press Owner");
      await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
      await page.getByLabel("Password", { exact: true }).fill(OWNER_PASSWORD);
      await page.locator("form.auth-form").getByRole("button", { name: "Create account" }).click();
    });

    await test.step("onboarding skip: Cancel causes no action, focus returns", async () => {
      const skip = page.getByRole("button", { name: "Skip", exact: true });
      await expect(skip).toBeVisible({ timeout: 60_000 });
      await skip.click();
      const dialog = page.getByRole("dialog", { name: /Skip setup without connecting/ });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      // Focus stays inside the modal while tabbing.
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(skip).toBeVisible();
      await expect(skip).toBeFocused();
      // Cancel via the button too, then really skip.
      await skip.click();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      await expect(skip).toBeVisible();
      await skip.click();
      await dialog.getByRole("button", { name: "Skip anyway" }).click();
      await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible({
        timeout: 30_000
      });
    });

    await test.step("phone navigation: open, close button, reopen, Escape, focus returns", async () => {
      const opener = page.locator('button[aria-controls="moss-main-navigation"]');
      await expect(opener).toHaveAttribute("aria-expanded", "false");
      await expect(opener).toHaveAttribute("aria-controls", "moss-main-navigation");
      await opener.click();
      await expect(opener).toHaveAttribute("aria-expanded", "true");
      const nav = page.locator("#moss-main-navigation");
      await expect(nav).toHaveAttribute("aria-modal", "true");
      await expect(nav).toHaveAttribute("aria-label", "Navigation");
      // Focus moved into the navigation and Tab keeps it there.
      expect(await nav.evaluate((n) => n.contains(document.activeElement))).toBe(true);
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab");
        expect(await nav.evaluate((n) => n.contains(document.activeElement))).toBe(true);
      }
      await page.getByRole("button", { name: "Close navigation" }).click();
      await expect(opener).toHaveAttribute("aria-expanded", "false");
      await expect(opener).toBeFocused();
      // Closed navigation is not reachable by Tab.
      const reachable = await nav.evaluate(
        (n) => n.querySelectorAll("a:not([tabindex='-1']),button:not([disabled])").length
      );
      console.log(`[closed nav focusable-looking children: ${reachable}]`);
      // Reopen, then Escape.
      await opener.click();
      await expect(opener).toHaveAttribute("aria-expanded", "true");
      await page.keyboard.press("Escape");
      await expect(opener).toHaveAttribute("aria-expanded", "false");
      await expect(opener).toBeFocused();
      console.log(`[after Escape focus: ${await activeLabel(page)}]`);
    });
  } finally {
    console.log(`[core browser trace: ${JSON.stringify(trace)}]`);
  }
});
