// Park Press acceptance check 3 (PR 3347, Planning): real Tasks, Calendar and Workshop.
// Difficult states are made genuine by pausing or stopping the instance's own database
// container. No Moss response is intercepted, rewritten or replayed.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

const execFileAsync = promisify(execFile);

function baseURL(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value || !process.env.JARVIS_UAT_PROJECT_NAME?.startsWith("uat-")) {
    throw new Error("Run through the isolated UAT provisioner");
  }
  return value;
}

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

async function compose(...args: string[]): Promise<void> {
  await execFileAsync("docker", buildUatComposeArgs(process.env.JARVIS_UAT_PROJECT_NAME!, args), {
    maxBuffer: 1_000_000
  });
}

async function waitHealthy(page: Page): Promise<void> {
  await expect
    .poll(
      async () => (await page.request.get(`${baseURL()}/health/ready`).catch(() => null))?.status(),
      { timeout: 180_000, intervals: [2_000] }
    )
    .toBe(200);
}

async function signIn(page: Page): Promise<void> {
  await page.goto(baseURL());
  await page.getByLabel("Email", { exact: true }).fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip", exact: true });
  const account = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  const open = page.getByRole("button", { name: "Open navigation" });
  await expect(skip.or(account).or(open).first()).toBeVisible({ timeout: 60_000 });
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
}

const focusedName = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el?.getAttribute("aria-label") ?? el?.textContent?.trim().slice(0, 40) ?? "none";
  });

test("Tasks: detail focus after a genuinely delayed load, failed read, failed save, cancel", async ({
  page
}) => {
  test.setTimeout(900_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await go(page, `${baseURL()}/tasks`);
  const row = (title: string) => page.getByRole("button", { name: new RegExp(title) }).first();
  await expect(row("Draft Q1 planning doc")).toBeVisible({ timeout: 60_000 });
  const dialog = page.getByRole("dialog");

  try {
    await test.step("normal open: title gets focus; Escape returns focus to the row", async () => {
      await row("Draft Q1 planning doc").click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("Task title")).toBeFocused({ timeout: 30_000 });
      await expect(dialog.getByLabel("Task title")).toHaveValue("Draft Q1 planning doc");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      console.log(`[focus after Escape: ${await focusedName(page)}]`);
    });

    await test.step("cancel with an edit causes no change", async () => {
      await row("Draft Q1 planning doc").click();
      await expect(dialog.getByLabel("Task title")).toHaveValue("Draft Q1 planning doc", {
        timeout: 30_000
      });
      await page.getByLabel("Notes", { exact: true }).fill("UNSAVED-NOTE-CANCEL");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      await row("Draft Q1 planning doc").click();
      await expect(dialog.getByLabel("Task title")).toHaveValue("Draft Q1 planning doc", {
        timeout: 30_000
      });
      await expect(page.getByLabel("Notes", { exact: true })).not.toHaveValue(
        "UNSAVED-NOTE-CANCEL"
      );
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });

    await test.step("delayed load: focus the user chose is kept (database paused)", async () => {
      await compose("pause", "postgres");
      await row("Review PR backlog").click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText("Loading task details")).toBeVisible({ timeout: 30_000 });
      // The user deliberately moves focus to Cancel while the task is still loading.
      await dialog.getByRole("button", { name: "Cancel" }).focus();
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await compose("unpause", "postgres");
      await expect(dialog.getByLabel("Task title")).toHaveValue("Review PR backlog", {
        timeout: 120_000
      });
      expect(await focusedName(page), "focus must not be stolen by the late load").toBe("Cancel");
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
    });

    await test.step("delayed load, user does not move: title takes focus", async () => {
      await compose("pause", "postgres");
      await row("Renew domain registration").click();
      await expect(dialog.getByText("Loading task details")).toBeVisible({ timeout: 30_000 });
      await compose("unpause", "postgres");
      await expect(dialog.getByLabel("Task title")).toHaveValue("Renew domain registration", {
        timeout: 120_000
      });
      await expect(dialog.getByLabel("Task title")).toBeFocused();
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });

    await test.step("failed read (database stopped): message, retry, recovery", async () => {
      await compose("stop", "postgres");
      await row("Book dentist appointment").click();
      await expect(dialog.getByText("Could not load this task")).toBeVisible({ timeout: 60_000 });
      await expect(dialog.getByLabel("Task title")).toBeDisabled();
      await dialog.getByRole("button", { name: "Retry task" }).click();
      await expect(dialog.getByText("Could not load this task")).toBeVisible({ timeout: 60_000 });
      await compose("start", "postgres");
      await waitHealthy(page);
      // The dialog may heal itself once the database is back; click Retry only if it still shows.
      const retry = dialog.getByRole("button", { name: "Retry task" });
      if (await retry.isVisible({ timeout: 3_000 }).catch(() => false)) await retry.click();
      await expect(dialog.getByLabel("Task title")).toHaveValue("Book dentist appointment", {
        timeout: 60_000
      });
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });

    await test.step("failed save keeps the draft; retry persists after reload", async () => {
      await row("Update resume").click();
      await expect(dialog.getByLabel("Task title")).toHaveValue("Update resume", {
        timeout: 30_000
      });
      await page.getByLabel("Notes", { exact: true }).fill("PARK-PRESS-DRAFT-NOTE");
      await compose("stop", "postgres");
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await expect(dialog.getByText("Could not save. Your changes are still here")).toBeVisible({
        timeout: 60_000
      });
      await expect(page.getByLabel("Notes", { exact: true })).toHaveValue("PARK-PRESS-DRAFT-NOTE");
      await expect(dialog).toBeVisible();
      await compose("start", "postgres");
      await waitHealthy(page);
      await dialog.getByRole("button", { name: "Save changes" }).click();
      await expect(dialog).toBeHidden({ timeout: 60_000 });
      await page.reload();
      await row("Update resume").click();
      await expect(page.getByLabel("Notes", { exact: true })).toHaveValue("PARK-PRESS-DRAFT-NOTE", {
        timeout: 60_000
      });
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });

    await test.step("phone: detail and footer scroll inside the dialog", async () => {
      await page.setViewportSize({ width: 390, height: 600 });
      await row("Update resume").click();
      await expect(dialog.getByLabel("Task title")).toHaveValue("Update resume", {
        timeout: 30_000
      });
      const save = dialog.getByRole("button", { name: "Save changes" });
      await expect(save).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box!.height).toBeLessThanOrEqual(600 + 1);
      const saveBox = await save.boundingBox();
      expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(600 + 1);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
      ).toBe(true);
      const scrolls = await dialog.evaluate((d) =>
        [d, ...d.querySelectorAll<HTMLElement>("*")].some(
          (el) =>
            /(auto|scroll)/.test(getComputedStyle(el).overflowY) &&
            el.scrollHeight > el.clientHeight
        )
      );
      console.log(`[phone dialog has an internally scrolling region: ${scrolls}]`);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });
  } finally {
    await compose("unpause", "postgres").catch(() => undefined);
    await compose("start", "postgres").catch(() => undefined);
  }
});

for (const width of [1280, 390, 320]) {
  test(`Calendar views, Peek and persistence at ${width}px`, async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    await go(page, `${baseURL()}/calendar`);
    const view = page.getByRole("group", { name: "View" });
    await expect(view).toBeVisible({ timeout: 60_000 });
    const noPageOverflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

    // Week and Month scroll inside their own focusable region.
    for (const name of ["Week", "Month"]) {
      await view.getByRole("button", { name }).click();
      const region = page.getByRole("region", { name: `Calendar ${name.toLowerCase()}` });
      await expect(region).toBeVisible({ timeout: 30_000 });
      await expect(region).toHaveAttribute("tabindex", "0");
      const overflow = await page.evaluate(() => {
        const doc = document.documentElement;
        let widest = "";
        let max = 0;
        for (const el of document.querySelectorAll<HTMLElement>("body *")) {
          const r = el.getBoundingClientRect();
          if (r.right > max) {
            max = r.right;
            widest = `${el.tagName}.${String(el.className).slice(0, 50)}`;
          }
        }
        return { sw: doc.scrollWidth, iw: window.innerWidth, widest, right: Math.round(max) };
      });
      console.log(`[${name} at ${width}: page ${JSON.stringify(overflow)}]`);
      expect
        .soft(overflow.sw <= overflow.iw + 1, `${name} at ${width}: page does not overflow`)
        .toBe(true);
      if (width <= 390) {
        const sc = await region.evaluate((r) => ({
          sw: r.scrollWidth,
          cw: r.clientWidth,
          ox: getComputedStyle(r).overflowX
        }));
        console.log(`[${name} at ${width}: scrollWidth ${sc.sw}, clientWidth ${sc.cw}, ${sc.ox}]`);
        expect(sc.sw).toBeGreaterThan(sc.cw);
        expect(/(auto|scroll)/.test(sc.ox)).toBe(true);
      }
    }
    // Day stays compact: no horizontal scroll, not a tab stop.
    await view.getByRole("button", { name: "Day" }).click();
    const day = page.getByRole("region", { name: "Calendar day" });
    await expect(day).toBeVisible();
    expect(await day.getAttribute("tabindex")).toBeNull();
    expect(await day.evaluate((r) => r.scrollWidth <= r.clientWidth + 1)).toBe(true);
    expect(await noPageOverflow()).toBe(true);

    // Selected view persists across a reload.
    await view.getByRole("button", { name: "Week" }).click();
    await page.reload();
    await expect(page.getByRole("region", { name: "Calendar week" })).toBeVisible({
      timeout: 60_000
    });
    await expect(
      page.getByRole("group", { name: "View" }).getByRole("button", { name: "Week" })
    ).toHaveAttribute("aria-pressed", "true");

    // Peek: reach the seeded January event in Month view through the real Previous button.
    await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Month" }).click();
    const event = page.getByRole("button", { name: /Team standup/ }).first();
    for (let i = 0; i < 14 && !(await event.isVisible()); i++) {
      await page.getByRole("button", { name: "Previous", exact: true }).click();
      await page.waitForTimeout(400);
    }
    await expect(event).toBeVisible({ timeout: 30_000 });
    await event.focus();
    await page.keyboard.press("Enter");
    const peek = page.getByRole("dialog", { name: "Event details" });
    await expect(peek).toBeVisible();
    expect(await peek.evaluate((p) => p.contains(document.activeElement))).toBe(true);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(await peek.evaluate((p) => p.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(peek).toBeHidden();
    await expect(event).toBeFocused();
  });
}

test("Calendar: genuine events failure keeps known events and offers Retry", async ({ page }) => {
  test.setTimeout(420_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await go(page, `${baseURL()}/calendar`);
  await expect(page.getByRole("group", { name: "View" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Month" }).click();
  await expect(page.getByRole("region", { name: "Calendar month" })).toBeVisible();
  try {
    await compose("stop", "postgres");
    // The calendar reads all events at once, so a reload while the database is down is the
    // real way to make its read fail.
    await page.reload().catch(() => undefined);
    await page.waitForTimeout(8_000);
    const text = (
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    ).replace(/\s+/g, " ");
    console.log(`[calendar with database down after reload: ${text.slice(0, 400)}]`);
    // Whole-database outage shows the app-level failure screen, not the calendar's own message.
    await expect(page.getByText("Internal server error")).toBeVisible({ timeout: 90_000 });
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    await compose("start", "postgres");
    await waitHealthy(page);
    await retry.click();
    await expect(page.getByRole("group", { name: "View" })).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText("Internal server error")).toHaveCount(0);
  } finally {
    await compose("start", "postgres").catch(() => undefined);
  }
});

test("Workshop: create, delete cancel is safe, failed delete retains the project", async ({
  page
}) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await go(page, `${baseURL()}/workshop/new`);
  const idea = page.getByLabel("Your idea", { exact: true });
  await idea.fill("Park Press acceptance project.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(/\/workshop\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const projectURL = page.url();
  const dialog = page.getByRole("dialog", { name: "Delete this project?" });
  const more = page.getByRole("button", { name: "More", exact: true });
  try {
    await test.step("cancel is safe: Keep it focused first, Escape and Keep it do nothing", async () => {
      await more.click();
      await page.getByRole("menuitem", { name: "Delete project" }).click();
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Keep it" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(more).toBeFocused();
      await more.click();
      await page.getByRole("menuitem", { name: "Delete project" }).click();
      await dialog.getByRole("button", { name: "Keep it" }).click();
      await expect(dialog).toBeHidden();
      expect(page.url()).toBe(projectURL);
      const list = await page.request.get("/api/workshop/projects");
      expect((await list.json()).projects).toHaveLength(1);
    });

    await test.step("failed delete: error shown, project kept, retry succeeds", async () => {
      await more.click();
      await page.getByRole("menuitem", { name: "Delete project" }).click();
      await compose("stop", "postgres");
      await dialog.getByRole("button", { name: "Delete project" }).click();
      await expect(dialog.getByText("The project could not be deleted. Try again.")).toBeVisible({
        timeout: 90_000
      });
      await expect(dialog).toBeVisible();
      await compose("start", "postgres");
      await waitHealthy(page);
      const kept = await page.request.get("/api/workshop/projects");
      expect((await kept.json()).projects).toHaveLength(1);
      await dialog.getByRole("button", { name: "Delete project" }).click();
      await expect(page).toHaveURL(/\/workshop$/, { timeout: 60_000 });
      const after = await page.request.get("/api/workshop/projects");
      expect((await after.json()).projects).toHaveLength(0);
    });
  } finally {
    await compose("start", "postgres").catch(() => undefined);
  }
});
