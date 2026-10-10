import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2782: evening open loops show a due-date reason and three working choices. Each choice is
// clicked in the real UI and the saved task is read back through the API. A rejected save shows
// an error and keeps the choices.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withBriefingWriterFixture: true
} as const;

const TZ = "America/Los_Angeles";

function localDay(date: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localIso(day: string, time: string): string {
  const offset =
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
      .formatToParts(new Date(`${day}T12:00:00Z`))
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = offset.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  return new Date(
    `${day}T${time}:00${match ? `${match[1]}${match[2]}:${match[3]}` : "Z"}`
  ).toISOString();
}

function shiftDay(day: string, by: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
}

const TODAY = localDay(new Date());
const EVENING_NOW = new Date(localIso(TODAY, "20:30"));

async function json(page: Page, path: string, init?: RequestInit) {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, init);
      return { status: response.status, body: await response.json() };
    },
    { path, init }
  );
}

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const menu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skip.or(menu).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible();
}

async function createTask(page: Page, title: string): Promise<string> {
  const result = await json(page, "/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, dueAt: localIso(shiftDay(TODAY, -1), "19:00") })
  });
  expect(result.status).toBe(201);
  return result.body.task.id as string;
}

async function readTask(page: Page, id: string) {
  const result = await json(page, `/api/tasks/${id}`);
  expect(result.status).toBe(200);
  return result.body.task as { status: string; dueAt: string | null };
}

test("evening open loops: reasons, three working choices, and a failed save keeps the choices", async ({
  page
}) => {
  test.setTimeout(180_000);
  await page.clock.setFixedTime(EVENING_NOW);
  await signIn(page);

  const definition = await json(page, "/api/briefings/definitions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "#2782 evening",
      briefingType: "evening",
      cadence: "manual",
      enabled: true,
      scheduleMetadata: { targetTime: "18:00", timezone: TZ },
      selectedToolNames: ["tasks.list"]
    })
  });
  expect(definition.status).toBe(201);

  const tomorrowId = await createTask(page, "#2782 first loop");
  const dayId = await createTask(page, "#2782 choose day");
  const dropId = await createTask(page, "#2782 let go");

  await page.goto("/today");
  const loops = page.locator("#evening-open-loops");
  await expect(loops).toContainText("Close the open loops");
  const row = (title: string) => loops.locator(".ev-loop", { hasText: title });

  // Reason line comes from the real due date.
  await expect(row("#2782 first loop")).toContainText(/Was due .+ and is still open\./);
  const choices = row("#2782 first loop").locator(".ev-loop__actions button");
  await expect(choices).toHaveText(["Tomorrow", "Choose a day", "Let it go"]);

  // Failed save on the first task: force the update to 500. The error shows, the choices stay,
  // no success note appears, and the task is unchanged.
  const overdue = localIso(shiftDay(TODAY, -1), "19:00");
  await page.route(`**/api/tasks/${tomorrowId}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 500, contentType: "application/json", body: "{}" })
      : route.continue()
  );
  await row("#2782 first loop").getByRole("button", { name: "Tomorrow", exact: true }).click();
  await expect(row("#2782 first loop").locator(".ev-loop__error")).toContainText(
    "Could not save that"
  );
  await expect(row("#2782 first loop").locator(".ev-loop__actions button")).toHaveCount(3);
  await expect(row("#2782 first loop").locator(".ev-loop__moved")).toHaveCount(0);
  expect((await readTask(page, tomorrowId)).dueAt).toBe(overdue);
  await page.unroute(`**/api/tasks/${tomorrowId}`);

  // Retry on the same task now succeeds.
  await row("#2782 first loop").getByRole("button", { name: "Tomorrow", exact: true }).click();
  await expect(row("#2782 first loop").locator(".ev-loop__moved")).toHaveText("Moved to tomorrow.");
  expect((await readTask(page, tomorrowId)).dueAt).toBe(localIso(shiftDay(TODAY, 1), "00:00"));

  // Choose a day.
  const picked = shiftDay(TODAY, 4);
  await row("#2782 choose day").getByRole("button", { name: "Choose a day" }).click();
  await row("#2782 choose day").locator('input[type="date"]').fill(picked);
  await row("#2782 choose day").getByRole("button", { name: "Save day" }).click();
  // The saved day is read back from the server. Once saved, the row may leave the list because
  // the task is no longer at risk, so the on-screen note is not asserted here.
  await expect
    .poll(async () => (await readTask(page, dayId)).dueAt)
    .toBe(localIso(picked, "00:00"));
  await expect(row("#2782 choose day").locator(".ev-loop__actions button")).toHaveCount(0);

  // Let it go.
  await row("#2782 let go").getByRole("button", { name: "Let it go" }).click();
  await expect.poll(async () => (await readTask(page, dropId)).status).toBe("archived");
  await expect(row("#2782 let go").locator(".ev-loop__actions button")).toHaveCount(0);
});
