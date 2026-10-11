// tests/uat/specs/2956-activity-history.uat.spec.ts
//
// Slice C (#2956) live proof. A real briefing synthesis runs one `generateChat` call through
// the HTTP provider adapter against the UAT briefing-writer fixture. That records a
// structured.briefings line owned by the admin who triggered the run. The admin then opens
// Settings > Activity and sees the line rendered in fixed words (never the model's prose),
// clicks it, and the detail dialog opens with the recorded steps and facts.
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withBriefingWriterFixture: true
} as const;

const WRITER_MODEL_NAME = "uat-briefing-writer-fixture-model";
// A distinctive line from the fixture's fixed prose; it must never reach the activity page.
const WRITER_HEADLINE = "A steady day with room for deep work.";

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const menu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skip.or(menu).first()).toBeVisible({ timeout: 30_000 });
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible({ timeout: 30_000 });
}

async function openActivity(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
}

interface ActivityLine {
  readonly id?: string;
  readonly actionCode?: string | null;
  readonly modelName?: string;
  readonly detail?: { quote?: string | null; resultLine?: string | null } | null;
}

async function fetchActivityLines(page: Page): Promise<readonly ActivityLine[]> {
  const response = await page.request.get("/api/ai/activity-lines?limit=25");
  expect(response.ok(), `activity-lines -> ${response.status()}`).toBeTruthy();
  return ((await response.json()) as { entries: readonly ActivityLine[] }).entries;
}

interface BriefingRun {
  readonly id: string;
  readonly status: string;
  readonly summaryText: string;
}

test("a real model call appears as an Activity line with a working detail dialog (#2956)", async ({
  page
}) => {
  test.setTimeout(300_000);

  await test.step("sign in as admin", async () => {
    await signIn(page);
  });

  await test.step("run a real briefing synthesis through the HTTP provider adapter", async () => {
    const created = await page.request.post("/api/briefings/definitions", {
      data: {
        title: "UAT activity history proof",
        briefingType: "morning",
        cadence: "manual",
        enabled: true,
        selectedToolNames: ["tasks.list"]
      }
    });
    expect(created.status(), `create definition -> ${created.status()}`).toBe(201);
    const definitionId = ((await created.json()) as { definition: { id: string } }).definition.id;
    expect(definitionId).toBeTruthy();

    const triggered = await page.request.post(`/api/briefings/definitions/${definitionId}/run`, {
      data: {}
    });
    expect(triggered.status(), `trigger run -> ${triggered.status()}`).toBe(202);
    const runId = ((await triggered.json()) as { runId: string }).runId;
    expect(runId).toBeTruthy();

    let run: BriefingRun | undefined;
    for (let attempt = 0; attempt < 120 && !run; attempt++) {
      const runs = await page.request.get(`/api/briefings/definitions/${definitionId}/runs`);
      expect(runs.ok(), `list runs -> ${runs.status()}`).toBeTruthy();
      run = ((await runs.json()) as { runs: BriefingRun[] }).runs.find(
        (candidate) => candidate.id === runId
      );
      if (!run) await page.waitForTimeout(1_000);
    }
    expect(run, "the briefing run should complete").toBeDefined();
    expect(run!.status, "the fixture writer should succeed").toBe("succeeded");
    expect(run!.summaryText).toContain(WRITER_HEADLINE);
  });

  await test.step("the endpoint records the call as the admin's own line", async () => {
    await expect
      .poll(
        async () => {
          const entries = await fetchActivityLines(page);
          return entries.find((entry) => entry.modelName === WRITER_MODEL_NAME)?.actionCode;
        },
        {
          timeout: 30_000,
          message: `no activity-lines row for ${WRITER_MODEL_NAME} appeared`
        }
      )
      .toBe("structured.briefings");
  });

  await test.step("the Activity page shows the line in fixed words, never the prose", async () => {
    await openActivity(page);
    const line = page.locator(".act-line", { hasText: "Prepared a briefing" }).first();
    await expect(line).toBeVisible({ timeout: 15_000 });
    await expect(line.getByText(WRITER_MODEL_NAME).first()).toBeVisible();
    await expect(page.locator(".act-filters")).toBeVisible();
    await expect(page.getByRole("button", { name: "Models: all" })).toBeVisible();
    // The page is titles and recorded facts: the model's reply must not leak into it.
    await expect(page.locator(".act-line").getByText(WRITER_HEADLINE)).toHaveCount(0);
  });

  await test.step("clicking the line opens the detail dialog with steps and facts", async () => {
    await page.locator(".act-line", { hasText: "Prepared a briefing" }).first().click();
    const dialog = page.locator(".act-dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText("Prepared a briefing").first()).toBeVisible();
    await expect(dialog.locator('[role="listbox"]')).toBeVisible();
    await expect(dialog.locator(".act-facts")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  await test.step("unticking a model hides its lines with a note", async () => {
    await page.getByRole("button", { name: /Models:/ }).click();
    const checklist = page.locator(".jds-checklist");
    await expect(checklist).toBeVisible({ timeout: 15_000 });
    await expect(checklist.getByText(WRITER_MODEL_NAME)).toBeVisible();
    await checklist.getByText(WRITER_MODEL_NAME).click();
    await expect(page.locator(".act-line", { hasText: "Prepared a briefing" })).toHaveCount(0);
    await expect(page.getByText("1 entry hidden by the model filter")).toBeVisible();
    await expect(page.getByRole("button", { name: /Models: \d+ of \d+/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset filters" })).toBeVisible();
  });

  await test.step("filter choices survive a reload", async () => {
    await page.reload();
    const menu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
    await expect(menu).toBeVisible({ timeout: 30_000 });
    await openActivity(page);
    await expect(page.locator(".act-line", { hasText: "Prepared a briefing" })).toHaveCount(0);
    await expect(page.getByText("1 entry hidden by the model filter")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset filters" })).toBeVisible();
  });

  await test.step("Reset filters clears the choices", async () => {
    await page.getByRole("button", { name: "Reset filters" }).click();
    const line = page.locator(".act-line", { hasText: "Prepared a briefing" }).first();
    await expect(line).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Models: all" })).toBeVisible();
    await expect(page.getByText(/hidden by the model filter/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reset filters" })).toHaveCount(0);
  });

  await test.step("Settings no longer lists the retired Model activity page", async () => {
    await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Admin / Setup" }).click();
    await expect(page.getByRole("button", { name: "Model activity" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "People & access" })).toBeVisible({
      timeout: 15_000
    });
  });
});
