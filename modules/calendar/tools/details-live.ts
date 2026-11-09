/** Authored event details on the real installed Rust screen; no response substitution. */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "@playwright/test";

export async function checkDetails(tab: Page, base: string, out: string, event: string) {
  for (const width of [1280, 390]) {
    await tab.setViewportSize({ width, height: 860 });
    await tab.goto(`${base}/calendar`);
    const frame = tab.frameLocator("#calendar");
    await frame.getByRole("button", { name: "Month", exact: true }).click();
    const trigger = frame.getByRole("button", { name: /Held block check/ }).first();
    await trigger.click();
    const dialog = frame.getByRole("dialog");
    await dialog.waitFor();
    await dialog.evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((animation) => animation.finished));
    });
    assert.equal(await dialog.locator(".cal-peek__row").count(), 4);
    await dialog.locator(".cal-peek__dur").getByText("· 1 hr", { exact: true }).waitFor();
    await dialog.locator(".cal-peek__rowsub").getByText("UTC", { exact: true }).waitFor();
    await dialog.locator(".cal-peek__rowmain").getByText("2 people", { exact: true }).waitFor();
    await dialog
      .locator(".cal-peek__held")
      .getByText(/Cedar can move or shorten/)
      .waitFor();
    const layout = await dialog.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const title = el.querySelector(".cal-peek__titlewrap")!;
      const rows = [...el.querySelectorAll(".cal-peek__row")];
      return {
        left: rect.left,
        right: rect.right,
        viewport: innerWidth,
        overflow: el.scrollWidth > el.clientWidth + 1,
        title: getComputedStyle(title).display,
        rows: rows.map((row) => getComputedStyle(row).display)
      };
    });
    assert(layout.left >= 0 && layout.right <= layout.viewport + 1);
    assert.equal(layout.overflow, false, "Long location must wrap inside the dialog");
    assert.equal(layout.title, "flex");
    assert(layout.rows.every((display) => display === "flex"));
    await dialog.screenshot({ path: join(out, `event-details-${width}.png`) });
    await tab.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert(
      await trigger.evaluate((el) => el === el.ownerDocument.activeElement),
      "Escape returns focus to the event"
    );
    await trigger.click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert(
      await trigger.evaluate((el) => el === el.ownerDocument.activeElement),
      "Close returns focus to the event"
    );
    console.log(
      `PASS installed event details at ${width}px: authored rows, wrapping, held note, Escape/Close and focus return`
    );
  }
  await tab.setViewportSize({ width: 1280, height: 860 });
  await tab.frameLocator("#calendar").getByRole("button", { name: "Day", exact: true }).click();
  await tab.goto(`${base}/calendar?event=${event}`);
  await tab.frameLocator("#calendar").getByRole("dialog").waitFor();
}
