/** Navigation, saved choices and keyboard use on the real installed Calendar screen. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

export async function checkToolbar(tab: Page, base: string, out: string) {
  for (const width of [1280, 390, 320]) {
    await tab.setViewportSize({ width, height: 860 });
    await tab.goto(`${base}/calendar`);
    let frame = tab.frameLocator("#calendar");
    const today = () => frame.getByRole("button", { name: "Today", exact: true });
    const views = () => frame.getByRole("group", { name: "View", exact: true });
    const weeks = () => frame.getByRole("group", { name: "Week type", exact: true });
    const ready = () => expect(today()).toBeEnabled();
    await ready();
    await views().getByRole("button", { name: "Day", exact: true }).click();
    await ready();
    await today().click();
    await ready();
    assert.equal(await weeks().count(), 0);
    const original = await frame.locator(".cal-range").innerText();
    await frame.getByRole("button", { name: "Next", exact: true }).click();
    await ready();
    assert.notEqual(await frame.locator(".cal-range").innerText(), original);
    await frame.getByRole("button", { name: "Previous", exact: true }).click();
    await ready();
    assert.equal(await frame.locator(".cal-range").innerText(), original);
    await frame.getByRole("button", { name: "Next", exact: true }).click();
    await ready();
    const savedDay = await frame.locator(".cal-range").innerText();
    await tab.reload();
    frame = tab.frameLocator("#calendar");
    await ready();
    await expect(views().getByRole("button", { name: "Day", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    assert.equal(await frame.locator(".cal-range").innerText(), savedDay);
    await today().click();
    await ready();
    assert.equal(await frame.locator(".cal-range").innerText(), original);

    await views().getByRole("button", { name: "Week", exact: true }).click();
    await ready();
    await weeks().getByRole("button", { name: "Work week", exact: true }).focus();
    const workSaved = tab.waitForResponse(
      (response) =>
        response.url().endsWith("/api/m/calendar/display-settings") &&
        response.request().method() === "PATCH"
    );
    await tab.keyboard.press("Enter");
    assert.equal((await workSaved).status(), 200);
    await ready();
    await expect(weeks().getByRole("button", { name: "Work week", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(frame.locator(".cal-tg__col")).toHaveCount(5);
    await expect(weeks().getByRole("button", { name: "Work week", exact: true })).toBeFocused();
    await tab.reload();
    frame = tab.frameLocator("#calendar");
    await ready();
    await expect(views().getByRole("button", { name: "Week", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(weeks().getByRole("button", { name: "Work week", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(frame.locator(".cal-tg__col")).toHaveCount(5);
    await weeks().getByRole("button", { name: "Full week", exact: true }).focus();
    const fullSaved = tab.waitForResponse(
      (response) =>
        response.url().endsWith("/api/m/calendar/display-settings") &&
        response.request().method() === "PATCH"
    );
    await tab.keyboard.press("Space");
    assert.equal((await fullSaved).status(), 200);
    await ready();
    await expect(frame.locator(".cal-tg__col")).toHaveCount(7);
    await expect(weeks().getByRole("button", { name: "Full week", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(weeks().getByRole("button", { name: "Full week", exact: true })).toBeFocused();
    await frame.locator("body").evaluate(() => document.fonts.ready);
    const geometry = await frame.locator(".cal-toolbar").evaluate((toolbar) => {
      const buttons = [...toolbar.querySelectorAll("button")].map((button) => {
        const box = button.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width, height: box.height };
      });
      return { width: document.documentElement.clientWidth, buttons };
    });
    assert(
      geometry.buttons.every(
        (button) =>
          button.left >= 0 &&
          button.right <= geometry.width + 1 &&
          button.width >= 28 &&
          button.height >= 28
      ),
      JSON.stringify(geometry)
    );
    await tab.screenshot({ path: join(out, `toolbar-week-${width}.png`) });
    await views().getByRole("button", { name: "Month", exact: true }).focus();
    await tab.keyboard.press("Enter");
    await ready();
    await expect(frame.locator(".cal-month")).toBeVisible();
    assert.equal(await weeks().count(), 0);
    await expect(views().getByRole("button", { name: "Month", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await tab.reload();
    frame = tab.frameLocator("#calendar");
    await ready();
    await expect(views().getByRole("button", { name: "Month", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(frame.locator(".cal-month")).toBeVisible();
    console.log(
      `PASS installed toolbar ${width}px: navigation, saved Day cursor, saved Work week and Month, five/seven columns, Enter/Space, selected states and controls inside viewport`
    );
  }
  await tab.setViewportSize({ width: 1280, height: 860 });
}
