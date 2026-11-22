/** No intercepted routes: installed Calendar on the Rust Today shell, including the modal bridge. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { expect, type Page, type BrowserContext } from "@playwright/test";

export async function checkToday(page: Page, context: BrowserContext, origin: string, out: string) {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/m/calendar/") && request.method() !== "GET")
      writes.push(request.url());
  });
  const publicOrigin = process.env.PUBLIC_ORIGIN;
  assert.ok(publicOrigin, "LAN or tailnet origin is required");
  const remote = await context.request.get(`${publicOrigin}/api/hello`);
  assert.equal(remote.status(), 200, "server answers through its non-loopback origin");
  console.log("PASS Rust Today server answers on the LAN/tailnet address");
  for (const [name, width, height] of [
    ["desktop", 1440, 900],
    ["phone", 390, 844]
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/`);
    const slot = page.locator('[data-module-section="calendar"]');
    const frame = page.frameLocator('[data-module-section="calendar"] iframe');
    const review = frame.getByRole("button", { name: "Review task blocks", exact: true });
    await expect(review).toBeVisible({ timeout: 60_000 });
    await expect(frame.getByText("Proposed", { exact: true }).first()).toBeVisible();
    await expect(frame.getByText("Flexible", { exact: true })).toBeVisible();
    await expect(frame.getByText("Task no longer visible", { exact: true })).toBeVisible();
    await expect(frame.getByText("Prepare the workshop outline", { exact: true })).toBeVisible();
    await slot.scrollIntoViewIfNeeded();
    await slot.screenshot({ path: join(out, `today-schedule-${name}.png`) });
    await review.click();
    const dialog = frame.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.locator(".package-section-host.is-modal")).toHaveJSProperty("open", true);
    await expect(dialog.getByRole("heading", { name: "Make the plan fit." })).toBeVisible();
    await expect(dialog.getByText("No longer available", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Accept all time blocks", exact: true })
    ).toBeEnabled();
    assert.ok((await dialog.locator("input:not(:disabled), select:not(:disabled)").count()) > 0);
    assert.equal(
      await dialog.evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
      "review fits the viewport"
    );
    if (name === "phone") {
      const toggle = dialog.getByRole("button", { name: /Today's schedule$/ });
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await toggle.click();
    }
    await page.screenshot({ path: join(out, `today-review-${name}.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".package-section-host.is-modal")).toHaveCount(0);
    await expect(review).toBeFocused();
    await review.click();
    await dialog.getByRole("button", { name: "Back to Today", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    console.log(
      `PASS Today ${width}x${height}: real proposed/flexible/unavailable blocks, editable review (no writes until chosen), phone schedule disclosure, Escape and Back to Today`
    );
  }
  assert.deepEqual(writes, [], "viewing and reviewing Today issues no Calendar writes");
}
