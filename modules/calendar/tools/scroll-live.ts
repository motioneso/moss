/** Real installed grid positioning and scroll retention after changed server data. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

export async function checkGridScroll(
  tab: Page,
  base: string,
  out: string,
  changeTitle: (title: string) => Promise<void>
) {
  for (const width of [1280, 390]) {
    await tab.setViewportSize({ width, height: 860 });
    for (const view of ["Day", "Week"]) {
      await tab.goto(`${base}/calendar`);
      let frame = tab.frameLocator("#calendar");
      await frame.getByRole("button", { name: view, exact: true }).click();
      await expect(frame.getByRole("button", { name: "Today", exact: true })).toBeEnabled();
      if (view === "Week") {
        const fullWeek = frame.getByRole("button", { name: "Show full week", exact: true });
        if (await fullWeek.count()) await fullWeek.click();
        await expect(frame.getByRole("button", { name: "Today", exact: true })).toBeEnabled();
      }
      // A reload opens a new grid with no in-memory user scroll position.
      await tab.reload();
      frame = tab.frameLocator("#calendar");
      const scroll = frame.locator(".cal-tg__scroll");
      await frame.locator(".cal-now").waitFor({ state: "attached" });
      await expect
        .poll(async () =>
          scroll.evaluate((el) => {
            const marker = el.querySelector<HTMLElement>(".cal-now")!;
            const centered = parseFloat(marker.style.top) - el.clientHeight / 2;
            const expected = Math.max(0, Math.min(centered, el.scrollHeight - el.clientHeight));
            return Math.abs(el.scrollTop - expected);
          })
        )
        .toBeLessThanOrEqual(1);
      assert((await scroll.evaluate((el) => el.clientHeight)) > 0);
      // Keep screenshot clipping outside the browser so later pointer input stays aligned.
      await tab.screenshot({ path: join(out, `grid-scroll-${view.toLowerCase()}-${width}.png`) });
      // Exercise both a deliberate scroll to midnight and a nonzero position.
      if ((width === 1280 && view === "Day") || (width === 390 && view === "Week")) {
        const top = width === 1280 ? 0 : 173;
        await scroll.evaluate((el, value) => {
          el.scrollTop = value;
        }, top);
        await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(top);
        const title = `Scroll retention ${width}`;
        await changeTitle(title);
        await frame
          .locator(".cal-ev__titletext")
          .filter({ hasText: title })
          .waitFor({ state: "attached", timeout: 45000 });
        // A new node starts at zero before its positioning effect. Sample after
        // layout and two paint opportunities so midnight cannot pass on that default.
        const settled = await scroll.evaluate(
          (el) =>
            new Promise<number>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve(el.scrollTop)));
            })
        );
        assert.equal(settled, top);
        await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(top);
      }
      console.log(
        `PASS installed ${view} ${width}px: initial scroll centers current time in the measured viewport; changed-data refresh retains user scroll where exercised`
      );
    }
  }
  await tab.setViewportSize({ width: 1280, height: 860 });
}
