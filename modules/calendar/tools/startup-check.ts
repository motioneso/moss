/** Real installed-screen startup faults. No account or API response is substituted. */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "@playwright/test";

export async function checkStartup(tab: Page, base: string, out: string, event: string) {
  const returnUrl = tab.url();
  for (const [page, asset] of [
    ["/calendar", "calendar_bg.wasm"],
    ["/calendar", "calendar.js"],
    ["/calendar", "boot.mjs"],
    ["/settings/calendar", "bridge.mjs"]
  ] as const) {
    await tab.setViewportSize(
      page === "/calendar" ? { width: 1280, height: 860 } : { width: 390, height: 844 }
    );
    const pattern = `**/module-ui/calendar/**/${asset}`;
    let intercepted = 0;
    await tab.route(pattern, async (route) => {
      intercepted++;
      await route.abort("failed");
    });
    try {
      await tab.goto(`${base}${page}?event=${encodeURIComponent(event)}`);
      const frame = tab.frameLocator("#calendar");
      try {
        await frame
          .getByRole(asset === "boot.mjs" ? "status" : "alert")
          .filter({
            hasText: asset === "boot.mjs" ? "Opening Calendar" : "Calendar could not start"
          })
          .waitFor({ timeout: 10000 });
      } catch (error) {
        await tab.screenshot({ path: join(out, "startup-missing-fallback.png") });
        assert(
          intercepted > 0,
          `The actual ${asset} request must fail before checking its fallback`
        );
        console.log(`REPRO ${page}: ${asset} request failed, but no startup fallback appeared`);
        throw error;
      }
      assert(intercepted > 0, `The actual ${asset} request must fail`);
      assert.equal(await frame.locator(".cal-wrap, .calendar-settings").count(), 0);
      if (asset === "calendar_bg.wasm") {
        await tab.screenshot({ path: join(out, "startup-failure.png") });
      }
      if (page === "/settings/calendar") {
        await tab.screenshot({ path: join(out, "startup-failure-phone-width.png") });
      }
    } finally {
      await tab.unroute(pattern);
    }
    await tab.getByRole("link", { name: "Reload page", exact: true }).click();
    assert.equal(new URL(tab.url()).pathname, page, "Reload retains the current screen");
    assert.equal(
      new URL(tab.url()).searchParams.get("event"),
      event,
      "Reload retains the event link"
    );
    const frame = tab.frameLocator("#calendar");
    if (page === "/calendar") {
      await frame.getByRole("dialog").filter({ hasText: "Calendar package check" }).waitFor();
      await frame.getByRole("button", { name: "Close", exact: true }).click();
      await frame.locator(".cal-wrap").waitFor();
    } else {
      await frame.locator(".calendar-settings").waitFor();
      await frame.getByLabel("Look ahead").waitFor();
    }
    assert.equal(await frame.locator("#calendar-startup").count(), 0);
    console.log(`PASS installed ${page} startup failure and reload after ${asset} request failed`);
  }
  await tab.screenshot({ path: join(out, "startup-recovered-settings.png") });
  await tab.setViewportSize({ width: 1280, height: 860 });
  await tab.goto(returnUrl);
}
