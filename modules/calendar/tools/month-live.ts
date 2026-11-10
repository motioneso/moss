/** Real installed Month screen checks; events come from the disposable server cache. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

export async function checkMonth(tab: Page, out: string) {
  const frame = tab.frameLocator("#calendar");
  for (const width of [1280, 390]) {
    await tab.setViewportSize({ width, height: 860 });
    await frame.getByRole("button", { name: "Month", exact: true }).click();
    await frame.getByRole("button", { name: "Today", exact: true }).click();
    await expect(frame.getByRole("button", { name: "Today", exact: true })).toBeEnabled();
    await frame.locator("body").evaluate(() => document.fonts.ready);
    const month = frame.locator(".cal-month");
    await month.waitFor();
    const rows = await month.evaluate((el) => {
      const cells = [...el.querySelectorAll(".cal-mcell")];
      const grid = el.querySelector(".cal-month__grid")!;
      return {
        count: cells.length / 7,
        minimum: parseFloat(getComputedStyle(el).minHeight),
        heights: cells.map((cell) => cell.getBoundingClientRect().height),
        tracks: getComputedStyle(grid).gridTemplateRows.split(" ").length,
        fits: grid.scrollHeight <= grid.clientHeight + 1
      };
    });
    assert([5, 6].includes(rows.count));
    assert(rows.minimum >= 42 + rows.count * 112);
    assert.equal(rows.tracks, rows.count);
    assert(rows.heights.every((height) => Math.abs(height - rows.heights[0]!) < 1));
    assert(rows.fits, "Month rows must fit their scrollable calendar content");
    assert((await month.locator(".mo").count()) >= 1);
    const today = month.locator(".cal-mcell.is-today");
    const pill = today.locator(".n");
    await pill.waitFor();
    const highlight = await pill.evaluate((el) => ({
      radius: getComputedStyle(el).borderRadius,
      background: getComputedStyle(el).backgroundColor,
      width: el.getBoundingClientRect().width,
      height: el.getBoundingClientRect().height
    }));
    assert.equal(highlight.radius, "50%");
    assert.notEqual(highlight.background, "rgba(0, 0, 0, 0)");
    assert.equal(highlight.width, 22);
    assert.equal(highlight.height, 22);
    assert.equal(await today.locator(".cal-mchip").count(), 3);
    const more = today.locator(".cal-mmore");
    await more.waitFor();
    // A visible label can still have its hit target clipped by the event list.
    await expect
      .poll(() =>
        more.evaluate((button) => {
          const target = button.getBoundingClientRect();
          const clip = button.parentElement!.getBoundingClientRect();
          return target.top >= clip.top - 1 && target.bottom <= clip.bottom + 1;
        })
      )
      .toBe(true);
    // A clipped capture shifted delivered pointer coordinates by the clip origin
    // in the task browser. Capture the viewport; crop evidence off-browser later.
    await tab.screenshot({ path: join(out, `month-${width}.png`) });
    await expect(frame.getByRole("button", { name: "Today", exact: true })).toBeEnabled();
    await more.click();
    await frame.locator(".cal-tg__col").waitFor();
    const picked = await frame.locator(".cal-range").innerText();
    assert.equal(await frame.locator(".cal-tg__col").count(), 1);
    await frame.getByRole("button", { name: "Month", exact: true }).click();
    await expect(frame.getByRole("button", { name: "Today", exact: true })).toBeEnabled();
    await today.locator(".cal-mcell__date").click();
    await frame.locator(".cal-tg__col").waitFor();
    assert.equal(await frame.locator(".cal-range").innerText(), picked);
    await frame.getByRole("button", { name: "Month", exact: true }).click();
    await expect(frame.getByRole("button", { name: "Today", exact: true })).toBeEnabled();
    await today.locator(".cal-mchip").first().click();
    const dialog = frame.getByRole("dialog");
    await dialog.waitFor();
    await frame.getByRole("button", { name: "Close", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    console.log(
      `PASS installed Month at ${width}px: equal rows, date labels, today's highlight, overflow-to-Day, date-to-Day and event details`
    );
  }
  await tab.setViewportSize({ width: 1280, height: 860 });
}
