// TEMPORARY live proof for #2745 - deleted before the PR. Disposable UAT stack
// only: provisions via run-uat.ts, never the shared dev database.
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import {
  armCalendar,
  closeDialogs,
  createBriefingRun,
  createDayPlan,
  createTask,
  localDay,
  localIso,
  localeTz,
  manifest,
  openToday,
  resolveStamp,
  seedCachedEvents,
  type ParityEvent,
  type ParityManifest
} from "../visual-parity/seed.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  withJobSearchFixture: true,
  withSportsPublicSourceFixtures: true,
  chatScript: "phase1-smoke",
  withEspnFixture: true,
  withBriefingWriterFixture: true
} as const;

async function signIn(page: Page): Promise<void> {
  await page.goto(process.env.JARVIS_UAT_BASE_URL!);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();
}

test("report sources name time and contribution at both widths", async ({ page }) => {
  const m = manifest() as unknown as ParityManifest;
  const day = localDay();
  await signIn(page);
  const timeZone = await localeTz(page);
  const accountId = await armCalendar(page);
  await seedCachedEvents(
    page,
    accountId,
    [...m.meetings, ...m.events].map((e: ParityEvent, i: number) => ({
      title: e.title,
      startsAt: resolveStamp(day, e.startsAt),
      endsAt: resolveStamp(day, e.endsAt),
      externalId: `src2745-${i}`
    }))
  );
  const taskId = await createTask(page, m.tasks[0]!.title, null);
  await createDayPlan(page, day, timeZone, [taskId]);
  await createBriefingRun(
    page,
    "morning",
    "Sources proof morning",
    ["tasks.list", "calendar.listVisibleEvents", "news.topHeadlinesToday", "goals.list"],
    localIso(day, "08:00")
  );

  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    await openToday(page, new Date(localIso(day, "08:00")));
    await page.getByRole("button", { name: "Read the full morning briefing" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const disclosure = dialog.locator("details.brief-reader__sources");
    await expect(disclosure).toBeVisible();
    await disclosure.locator("summary").click();
    await expect(disclosure).toContainText("What informed this briefing?");
    await expect(disclosure).toContainText(/on today's schedule/);
    await expect(disclosure).toContainText(/open tasks/);
    await expect(disclosure).toContainText("Day plan");
    await expect(disclosure).toContainText(/time blocks? from last evening/);
    await disclosure.screenshot({ path: `/tmp/2745-sources-${width}.png` });
    await closeDialogs(page);
  }
});
