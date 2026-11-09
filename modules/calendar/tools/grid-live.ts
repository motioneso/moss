/** Exercise real installed event chips with synthetic cache rows, without network substitution. */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "@playwright/test";

export async function checkGrid(tab: Page, base: string, out: string, linkedEvent: string) {
  for (const width of [1280, 390]) {
    await tab.setViewportSize({ width, height: 860 });
    await tab.goto(`${base}/calendar`);
    const frame = tab.frameLocator("#calendar");
    await frame.getByRole("button", { name: "Day", exact: true }).click();
    await frame.getByRole("button", { name: "Today", exact: true }).click();
    const short = frame.locator(".cal-ev").filter({ hasText: "Short grid check" });
    const medium = frame.locator(".cal-ev").filter({ hasText: "Medium grid check" });
    const held = frame.locator(".cal-ev").filter({ hasText: "Held block check" });
    await held.waitFor();
    assert.equal(await short.locator(".cal-ev__meta").count(), 0);
    assert.equal(await medium.locator(".cal-ev__meta").count(), 1);
    assert.equal(await medium.locator(".cal-ev__where").count(), 0);
    assert.equal(await held.locator(".cal-ev__where").count(), 1);
    assert.equal(await held.locator(".cal-ev__hold svg[aria-hidden=true]").count(), 1);
    const heldDay = frame.locator(".cal-allchip").filter({ hasText: "Held all-day grid check" });
    const ordinaryDay = frame.locator(".cal-allchip").filter({ hasText: "All-day date check" });
    const colour = (el: Element) =>
      getComputedStyle(el.querySelector(".cal-allchip__dot")!).backgroundColor;
    assert.notEqual(await heldDay.evaluate(colour), await ordinaryDay.evaluate(colour));
    const location = held.locator(".cal-ev__where");
    const clipped = await location.evaluate((el) => ({
      overflow: getComputedStyle(el).overflow,
      ellipsis: getComputedStyle(el).textOverflow,
      clipped: el.scrollWidth > el.clientWidth
    }));
    assert.deepEqual(clipped, { overflow: "hidden", ellipsis: "ellipsis", clipped: true });
    await frame.locator(".cal-tg__scroll").evaluate((el) => {
      el.scrollTop = 8 * 58;
    });
    await tab.screenshot({ path: join(out, `event-grid-day-${width}.png`) });
    await held.click();
    const dialog = frame.getByRole("dialog");
    await dialog.waitFor();
    await dialog.locator(".cal-peek__rowmain").filter({ hasText: "Room-LongLocation" }).waitFor();
    await tab.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    await frame.getByRole("button", { name: "Week", exact: true }).click();
    // The saved account may use a work week which excludes the fixture's Sunday.
    const fullWeek = frame.getByRole("button", { name: "Show full week", exact: true });
    if (await fullWeek.count()) await fullWeek.click();
    await held.waitFor();
    assert.equal(await held.locator(".cal-ev__where").count(), 0);
    assert.equal(await held.locator(".cal-ev__meta").count(), 1);
    await frame.locator(".cal-tg__scroll").evaluate((el) => {
      el.scrollTop = 8 * 58;
    });
    await tab.screenshot({ path: join(out, `event-grid-week-${width}.png`) });
    console.log(
      `PASS installed event grid at ${width}px: short/title-only, medium/time, Day/location, Week/dense labels, held markers, all-day colour, clipped location and working details`
    );
  }
  await tab.setViewportSize({ width: 1280, height: 860 });
  await tab.frameLocator("#calendar").getByRole("button", { name: "Day", exact: true }).click();
  await tab.goto(`${base}/calendar?event=${linkedEvent}`);
  await tab.frameLocator("#calendar").getByRole("dialog").waitFor();
}
