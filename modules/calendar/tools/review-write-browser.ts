/** Real Today review writes: no intercepted routes, real installed packages, fake Google only. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { chromium, expect, type Request } from "@playwright/test";
type Block = {
  id: string;
  kind: string;
  taskId: string | null;
  title: string | null;
  pendingChange: unknown;
};
type Event = { title: string; startsAt: string };
const {
  ORIGIN: origin,
  PUBLIC_ORIGIN: publicOrigin,
  EMAIL: email,
  PASSWORD: password,
  OUT: out
} = process.env;
if (!origin || !publicOrigin || !email || !password || !out)
  throw new Error("Live server environment required");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const context = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await context.newPage();
try {
  const signed = await context.request.post(`${origin}/api/auth/sign-in/email`, {
    headers: { origin },
    data: { email, password }
  });
  assert.equal(signed.status(), 200);
  const remote = await context.request.get(`${publicOrigin}/api/hello`);
  assert.equal(remote.status(), 200, "LAN/tailnet server responds");
  console.log("PASS review write server reachable over LAN/tailnet");
  async function call(module: string, path: string, method = "GET", data?: unknown) {
    const response = await context.request.fetch(`${origin}/api/m/${module}${path}`, {
      method,
      headers: { origin: origin! },
      data
    });
    const body = await response.json();
    assert.ok(
      response.ok(),
      `${method} ${module}${path}: ${response.status()} ${JSON.stringify(body)}`
    );
    return body;
  }
  await call("calendar", "/display-settings", "PATCH", { timezone: "UTC" });
  const display = await call("calendar", "/display-settings");
  const day = (display.now || new Date().toISOString()).slice(0, 10);
  const created = await call("calendar", "/day-plans", "POST", { date: day, timeZone: "UTC" });
  const id = created.plan.id;
  for (const [name, width, height, first, second] of [
    ["desktop", 1440, 900, "05:00", "07:00"],
    ["phone", 390, 844, "18:00", "20:00"]
  ] as const) {
    await page.setViewportSize({ width, height });
    // Setup uses public routes too; each width gets new real tasks and proposals.
    const a = (await call("tasks", "/tasks", "POST", { title: `Prepare ${name} workshop` })).task;
    const b = (await call("tasks", "/tasks", "POST", { title: `Review ${name} checklist` })).task;
    const saved = (await call("calendar", `/day-plan?date=${day}&timeZone=UTC`)).plan;
    const existing = saved.blocks.map((b: Block) => ({
      id: b.id,
      kind: b.kind,
      taskId: b.taskId,
      title: b.title,
      pendingChange: b.pendingChange
    }));
    await call("calendar", `/day-plans/${id}/draft`, "PATCH", {
      date: day,
      timeZone: "UTC",
      expectedRevision: saved.revision,
      blocks: [
        ...existing,
        {
          kind: "focus",
          taskId: a.id,
          title: a.title,
          pendingChange: { kind: "add", startsAt: `${day}T${first}:00Z`, durationMinutes: 30 }
        },
        {
          kind: "focus",
          taskId: b.id,
          title: b.title,
          pendingChange: { kind: "add", startsAt: `${day}T${second}:00Z`, durationMinutes: 30 }
        }
      ]
    });
    const taskCount = (await call("tasks", "/tasks")).tasks.length;
    const writes: string[] = [];
    const watch = (request: Request) => {
      if (request.url().includes("/api/m/calendar/") && request.method() !== "GET")
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    };
    page.on("request", watch);
    await page.goto(`${origin}/`);
    const frame = page.frameLocator('[data-module-section="calendar"] iframe');
    await frame
      .getByRole("button", { name: "Review task blocks", exact: true })
      .click({ timeout: 60_000 });
    const dialog = frame.getByRole("dialog");
    await expect(dialog).toBeVisible();
    assert.equal(writes.length, 0, "opening review does not write");
    const additionTime = name === "desktop" ? "05:30" : "18:30";
    const proposedTime = dialog.getByLabel(`${a.title}: start time`, { exact: true });
    await proposedTime.fill(additionTime);
    await proposedTime.dispatchEvent("change");
    assert.equal(writes.length, 0, "editing a proposal writes only when saved or accepted");
    await dialog.getByRole("button", { name: "Back to Today", exact: true }).click();
    await frame.getByRole("button", { name: "Review task blocks", exact: true }).click();
    await expect(dialog.getByLabel(`${a.title}: start time`, { exact: true })).toHaveValue(
      additionTime
    );
    await dialog.getByRole("button", { name: "Accept all time blocks", exact: true }).click();
    // Dismissing the native dialog must also release its parent modal while a write settles.
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".package-section-host.is-modal")).toHaveCount(0);
    await frame.getByRole("button", { name: "Review task blocks", exact: true }).click();
    await expect(dialog.getByRole("status").filter({ hasText: "Applied 2" })).toBeVisible({
      timeout: 60_000
    });
    assert.equal(
      (await call("tasks", "/tasks")).tasks.length,
      taskCount,
      "Accept all does not create tasks"
    );
    let events = (await call("calendar", "/events")).events;
    assert.ok(events.some((e: Event) => e.title === a.title));
    assert.ok(events.some((e: Event) => e.title === b.title));
    const time = dialog.getByLabel(`${a.title}: start time`, { exact: true });
    await expect(time).toBeEnabled();
    const changed = name === "desktop" ? "06:00" : "19:00";
    await time.fill(changed);
    await time.dispatchEvent("change");
    await expect(dialog.getByRole("button", { name: "Save changes", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Save changes", exact: true }).click();
    const confirm = dialog.getByRole("region", { name: "Confirm calendar changes" });
    await expect(confirm).toBeVisible({ timeout: 60_000 });
    await expect(confirm.getByText(`Move ${a.title} at ${changed}`, { exact: true })).toBeVisible();
    events = (await call("calendar", "/events")).events;
    assert.equal(
      events.find((e: Event) => e.title === a.title).startsAt,
      `${day}T${additionTime}:00.000Z`,
      "move waits for confirmation"
    );
    assert.equal(
      await dialog.evaluate((el) => el.scrollWidth > el.clientWidth),
      false,
      "dialog fits width"
    );
    await confirm.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `review-confirm-${name}.png`) });
    await confirm.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(confirm).toHaveCount(0, { timeout: 60_000 });
    await expect(dialog.getByRole("status").filter({ hasText: "Applied 1" })).toBeVisible();
    events = (await call("calendar", "/events")).events;
    assert.equal(
      events.find((e: Event) => e.title === a.title).startsAt,
      `${day}T${changed}:00.000Z`
    );
    await dialog.getByRole("button", { name: "Back to Today", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      frame.getByRole("button", { name: "Review task blocks", exact: true })
    ).toBeFocused();
    await expect(frame.getByText(a.title, { exact: true }).first()).toBeVisible();
    await page
      .locator('[data-module-section="calendar"]')
      .screenshot({ path: join(out, `review-calendar-${name}.png`) });
    // Calendar screen independently renders the newly written events.
    await page.goto(`${origin}/module-frame?module=calendar&path=/`);
    await expect(
      page.frameLocator("#frame").getByText(a.title, { exact: true }).first()
    ).toBeVisible({ timeout: 60_000 });
    await page
      .frameLocator("#frame")
      .getByText(a.title, { exact: true })
      .first()
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, `review-events-${name}.png`) });
    page.off("request", watch);
    assert.ok(
      writes.some((w) => w.endsWith("/draft")) &&
        writes.some((w) => w.endsWith("/preview")) &&
        writes.some((w) => w.endsWith("/apply")) &&
        writes.some((w) => w.endsWith("/confirm"))
    );
    console.log(
      `PASS Part 10 ${width}x${height}: accept two existing task additions; edit time; save/preview/apply; confirm; real calendar events at saved times; no new tasks`
    );
  }
} finally {
  await browser.close();
}
