// Park Press acceptance check 1 (PR 3344, Foundations): shared controls exercised through the
// real screens that use them, at desktop and 390 px. Covers menu keyboard navigation, tooltip
// dismissal, modal focus containment and return, and label/hint associations.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

// A page-code download occasionally fails and shows the whole-app error screen. The screen is
// logged as evidence, then the page is reloaded once so the rest of the check can run.
async function go(page: Page, url: string): Promise<void> {
  await page.goto(url);
  const crash = page.getByRole("heading", { name: "Something went wrong." });
  if (await crash.isVisible({ timeout: 4_000 }).catch(() => false)) {
    console.log(`[CRASH SEEN: whole-app error screen after loading ${url}; reloading once]`);
    await page.reload();
  }
}

async function signIn(page: Page): Promise<void> {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL || !process.env.JARVIS_UAT_PROJECT_NAME?.startsWith("uat-")) {
    throw new Error("Run through the isolated UAT provisioner");
  }
  await page.goto(baseURL);
  await page.getByLabel("Email", { exact: true }).fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip", exact: true });
  const account = page
    .getByRole("button", { name: /^Account menu(?:,|$)/ })
    .or(page.getByRole("button", { name: "Open navigation" }));
  await expect(skip.or(account).first()).toBeVisible({ timeout: 60_000 });
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
}

async function accountTrigger(page: Page): Promise<Locator> {
  // On a phone the account menu lives inside the navigation panel.
  const open = page.getByRole("button", { name: "Open navigation" });
  if (await open.isVisible()) await open.click();
  const trigger = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(trigger).toBeVisible();
  return trigger;
}

async function activeIn(menu: Locator): Promise<boolean> {
  return menu.evaluate((m) => m.contains(document.activeElement));
}

async function exerciseAccountMenu(page: Page, label: string): Promise<void> {
  const trigger = await accountTrigger(page);
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  const count = await items.count();
  expect(count, `${label}: account menu has items`).toBeGreaterThan(1);
  // Focus lands on the first item, arrows rove, Home and End jump.
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.nth(count - 1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.first()).toBeFocused(); // wraps
  await page.keyboard.press("ArrowUp");
  await expect(items.nth(count - 1)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  expect(await activeIn(menu)).toBe(true);
  // Escape closes the menu and returns focus to the trigger.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  // ArrowUp on the closed trigger opens at the last item.
  await page.keyboard.press("ArrowUp");
  await expect(menu).toBeVisible();
  await expect(items.nth(count - 1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
}

async function exerciseTooltip(page: Page, label: string): Promise<void> {
  await go(page, `${process.env.JARVIS_UAT_BASE_URL}/settings`);
  // On a phone the section list is a modal sheet behind a picker button.
  const picker = page.locator("button.set2__picker");
  if (await picker.isVisible()) {
    await picker.click();
    const sheet = page.locator("#settings-sections");
    await expect(sheet).toHaveAttribute("aria-modal", "true");
    await page.keyboard.press("Escape");
    await expect(sheet).not.toHaveAttribute("aria-modal", "true");
    await expect.soft(picker, `${label}: Escape returns focus to the section picker`).toBeFocused();
    await picker.click();
  }
  await page.getByRole("button", { name: "Personal", exact: true }).click();
  await page.waitForTimeout(800);
  const memoryItem = page.getByRole("button", { name: /Memory & context/ });
  if (!(await memoryItem.isVisible()) && (await picker.isVisible())) await picker.click();
  await memoryItem.click();
  await page
    .getByRole("group", { name: "Memory section" })
    .getByText("People", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "Choose folder" })
    .waitFor({ timeout: 15_000 })
    .catch(async () => {
      const text = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 900);
      console.log(`[People page text: ${text}]`);
    });
  await page.getByRole("button", { name: "Choose folder" }).click();
  const tip = page.getByRole("button", { name: "How a folder becomes available" });
  await expect(tip).toBeVisible({ timeout: 30_000 });
  await expect(tip).toHaveAttribute("aria-expanded", "false");
  await tip.focus();
  await page.keyboard.press("Enter");
  await expect(tip).toHaveAttribute("aria-expanded", "true");
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  const describedBy = await tip.getAttribute("aria-describedby");
  expect(describedBy, `${label}: tooltip is linked to its trigger`).toBe(
    await tooltip.getAttribute("id")
  );
  // Escape dismisses and keeps focus on the trigger.
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await expect(tip).toBeFocused();
  // Blur dismisses.
  await page.keyboard.press("Enter");
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Tab");
  // Soft: the tooltip is expected to close when focus leaves it.
  await expect.soft(tooltip, `${label}: tooltip closes on blur`).toBeHidden({ timeout: 3_000 });
  await expect.soft(tip).toHaveAttribute("aria-expanded", "false", { timeout: 1_000 });
}

// Visible label text must equal the accessible name; hints named by aria-describedby must exist.
async function auditFormControls(page: Page, label: string): Promise<void> {
  const problems = await page.evaluate(() => {
    const out: string[] = [];
    const controls = document.querySelectorAll<HTMLElement>(
      "input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea"
    );
    for (const el of controls) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const id = el.id;
      const labelEl = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const aria = el.getAttribute("aria-label");
      const labelledby = el.getAttribute("aria-labelledby");
      const hasName = !!(labelEl?.textContent?.trim() || aria || labelledby);
      if (!hasName) out.push(`no accessible name: ${el.tagName} id=${id}`);
      if (labelEl && aria && labelEl.textContent?.trim() !== aria) {
        out.push(`label "${labelEl.textContent?.trim()}" differs from aria-label "${aria}"`);
      }
      for (const ref of (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)) {
        if (!document.getElementById(ref)) out.push(`dangling aria-describedby ${ref} on ${id}`);
      }
    }
    return out;
  });
  expect(problems, `${label}: form control names and hints`).toEqual([]);
}

for (const [name, viewport] of [
  ["desktop 1280", { width: 1280, height: 900 }],
  ["phone 390", { width: 390, height: 844 }]
] as const) {
  test(`Foundations shared controls at ${name}`, async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize(viewport);
    await signIn(page);

    await test.step("account menu keyboard navigation", async () => {
      await exerciseAccountMenu(page, name);
    });

    await test.step("tooltip opens, links to its trigger, dismisses on Escape and blur", async () => {
      await exerciseTooltip(page, name);
    });

    await test.step("label and hint associations on real settings screens", async () => {
      for (const section of ["people", "memory", "appearance", "profile"]) {
        await go(page, `${process.env.JARVIS_UAT_BASE_URL}/settings?section=${section}`);
        await page.waitForTimeout(2_000);
        await auditFormControls(page, `${name} settings ${section}`);
      }
      await go(page, `${process.env.JARVIS_UAT_BASE_URL}/tasks`);
      await page.waitForTimeout(2_000);
      await auditFormControls(page, `${name} tasks`);
    });
  });
}
