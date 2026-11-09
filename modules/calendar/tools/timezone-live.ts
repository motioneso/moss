/** Saved account timezone changes through the installed screen's ordinary refresh. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

export async function checkTimezoneScroll(
  tab: Page,
  base: string,
  out: string,
  changeZone: (zone: string, changeEvents: boolean) => Promise<string | undefined>
) {
  const targetZone = new Date().getUTCHours() >= 12 ? "Etc/GMT+6" : "Etc/GMT-6";
  try {
    for (const width of [1280, 390]) {
      await tab.setViewportSize({ width, height: 860 });
      for (const view of ["Day", "Week"]) {
        await changeZone("UTC", false);
        await tab.goto(`${base}/calendar`);
        const frame = tab.frameLocator("#calendar");
        await frame.getByRole("button", { name: view, exact: true }).click();
        await expect(frame.getByRole("button", { name: "Today", exact: true })).toBeEnabled();
        await frame.getByRole("button", { name: "Today", exact: true }).click();
        if (view === "Week") {
          const fullWeek = frame.getByRole("button", { name: "Show full week", exact: true });
          if (await fullWeek.count()) await fullWeek.click();
        }
        const scroll = frame.locator(".cal-tg__scroll");
        await frame.locator(".cal-now").waitFor({ state: "attached" });
        // Move far from the expected center; zero is also a real saved position.
        const top = width === 1280 ? 0 : 173;
        await scroll.evaluate((el, value) => {
          el.scrollTop = value;
        }, top);
        await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(top);
        const oldMarker = await frame
          .locator(".cal-now")
          .first()
          .evaluate((el) => parseFloat((el as HTMLElement).style.top));
        // The server preference is changed, never the response or the Wasm state.
        // Exercise unchanged event data and a simultaneous cache update.
        await changeZone(targetZone, view === "Week");
        await expect
          .poll(
            async () =>
              Math.abs(
                (await frame
                  .locator(".cal-now")
                  .first()
                  .evaluate((el) => parseFloat((el as HTMLElement).style.top))) - oldMarker
              ),
            { timeout: 45000 }
          )
          .toBeGreaterThan(300);
        await expect
          .poll(() =>
            scroll.evaluate((el) => {
              const marker = el.querySelector<HTMLElement>(".cal-now")!;
              const center = parseFloat(marker.style.top) - el.clientHeight / 2;
              const expected = Math.max(0, Math.min(center, el.scrollHeight - el.clientHeight));
              return Math.abs(el.scrollTop - expected);
            })
          )
          .toBeLessThanOrEqual(1);
        assert((await scroll.evaluate((el) => el.clientHeight)) > 0);
        const bounds = await scroll.boundingBox();
        assert(bounds);
        await tab.screenshot({
          path: join(out, `timezone-${view.toLowerCase()}-${width}.png`),
          clip: bounds
        });
        // A later refresh in that same timezone must preserve deliberate scrolling.
        await scroll.evaluate((el, value) => {
          el.scrollTop = value;
        }, top);
        const title = await changeZone(targetZone, true);
        assert(title);
        // Wait for the real changed title, so retaining the old DOM cannot pass.
        await frame
          .locator(".cal-ev__titletext")
          .filter({ hasText: title })
          .waitFor({ state: "attached", timeout: 45000 });
        const settled = await scroll.evaluate(
          (el) =>
            new Promise<number>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve(el.scrollTop)));
            })
        );
        assert.equal(settled, top);
        console.log(
          `PASS installed ${view} ${width}px: saved timezone change recenters; same-zone changed-data refresh retains scroll`
        );
      }
    }
  } finally {
    await changeZone("UTC", false);
    await tab.setViewportSize({ width: 1280, height: 860 });
  }
}
