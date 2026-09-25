import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Dedicated live UI proof for #2521. This has its own fresh UAT stack and is not
// part of the 32 populated visual-parity captures.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withBriefingWriterFixture: true
} as const;

test.use({ viewport: { width: 1280, height: 1800 } });

const WRITER_HEADLINE = "A steady day with room for deep work.";
const NO_PLAN_STATUS = "There is no saved plan to review today.";

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
  const menu = page.locator(".jds-usermenu__trigger");
  await expect(skip.or(menu).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible();
}

async function createMorningRun(
  page: Page,
  timeZone: string
): Promise<{ definitionId: string; runId: string; summaryText: string }> {
  const definition = await json(page, "/api/briefings/definitions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "No-plan Review proof",
      briefingType: "morning",
      cadence: "manual",
      enabled: true,
      scheduleMetadata: { targetTime: "07:00", timezone: timeZone },
      selectedToolNames: [
        "tasks.list",
        "calendar.listVisibleEvents",
        "news.topHeadlinesToday"
      ]
    })
  });
  expect(definition.status).toBe(201);
  const definitionId = definition.body.definition.id as string;

  const started = await json(page, `/api/briefings/definitions/${definitionId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  expect(started.status).toBe(202);
  const runId = started.body.runId as string;

  for (let attempt = 0; attempt < 90; attempt++) {
    const listed = await json(page, `/api/briefings/definitions/${definitionId}/runs`);
    expect(listed.status).toBe(200);
    const run = (
      listed.body.runs as Array<{ id: string; status: string; summaryText: string }>
    ).find((candidate) => candidate.id === runId);
    if (run?.summaryText.trim()) {
      expect(run.status).toBe("succeeded");
      return { definitionId, runId, summaryText: run.summaryText };
    }
    if (run && ["blocked", "failed"].includes(run.status)) {
      throw new Error(`UAT morning briefing run did not succeed: ${JSON.stringify(run)}`);
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error("UAT morning briefing run did not reach a populated terminal state");
}

test("Review keeps the real morning reader open when no plan is saved", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  expect(page.context().browser()?.browserType().name()).toBe("firefox");
  expect(page.viewportSize()).toEqual({ width: 1280, height: 1800 });

  await signIn(page);
  const locale = await json(page, "/api/me/locale");
  expect(locale.status).toBe(200);
  const timeZone = locale.body.locale.timezone as string;
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  const planPath = `/api/calendar/day-plan?date=${day}&timeZone=${encodeURIComponent(timeZone)}`;
  const beforeRun = await json(page, planPath);
  expect(beforeRun.status).toBe(200);
  expect(beforeRun.body.plan).toBeNull();
  console.log(`[no-plan proof] head=${commit} date=${day} timeZone=${timeZone} plan=null`);

  const run = await createMorningRun(page, timeZone);
  expect(run.summaryText).toContain(WRITER_HEADLINE);
  const afterRun = await json(page, planPath);
  expect(afterRun.status).toBe(200);
  expect(afterRun.body.plan).toBeNull();
  console.log(`[no-plan proof] briefingRun=${run.runId} succeeded with no saved plan`);

  await page.goto("/today");
  const opener = page.getByRole("button", { name: "Read the full morning briefing" });
  await expect(opener).toBeVisible();
  await opener.click();

  const reader = page.getByRole("dialog");
  await expect(reader).toBeVisible();
  await expect(reader.getByRole("heading", { name: "Your day, prepared." })).toBeVisible();
  await expect(reader).toContainText(WRITER_HEADLINE);
  const review = reader.getByRole("tab", { name: "Review task blocks" });
  await expect(review).toBeVisible();

  await review.click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(reader).toBeVisible();
  await expect(reader.getByRole("heading", { name: "Your day, prepared." })).toBeVisible();
  await expect(reader.getByRole("status")).toBeVisible();
  await expect(reader.getByRole("status")).toContainText(NO_PLAN_STATUS);

  const screenshot = testInfo.outputPath("review-no-plan.png");
  await mkdir(dirname(screenshot), { recursive: true });
  await reader.screenshot({ path: screenshot });
  await testInfo.attach("review-no-plan-reader", { path: screenshot, contentType: "image/png" });
  const afterClick = await json(page, planPath);
  expect(afterClick.status).toBe(200);
  expect(afterClick.body.plan).toBeNull();
  expect(pageErrors).toEqual([]);

  console.log(`[no-plan proof] screenshot=${screenshot}`);
  console.log(`[no-plan proof] pageErrors=${JSON.stringify(pageErrors)}`);
  console.log(`[no-plan proof] result=${NO_PLAN_STATUS}; reader dialog remains visible`);
});
