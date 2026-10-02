// tests/uat/specs/2889-model-activity-log.uat.spec.ts
//
// Plan 3.6a (#2889) live-path proof. A real briefing synthesis runs one `generateChat` call
// through the HTTP provider adapter against the UAT briefing-writer fixture (a real HTTP origin on
// the stack's network, see tests/uat/fixtures/briefing-writer-fixture-server.ts). That records a
// row through the installed recorder in the worker process. An admin then opens Settings > Model
// activity and sees the row; the log shows the model name and the outcome, never the model's prose.
//
// The HTTP adapter path is deliberate: 3.6a records HTTP chat/structured/transcription calls and
// CLI structured calls. CLI chat turns are 3.6b, so this proof does not depend on the scripted
// chat provider.
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withBriefingWriterFixture: true
} as const;

const WRITER_MODEL_NAME = "uat-briefing-writer-fixture-model";
// A distinctive line from the fixture's fixed prose; it must never reach the activity log.
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
  const menu = page.locator(".jds-usermenu__trigger");
  await expect(skip.or(menu).first()).toBeVisible({ timeout: 30_000 });
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible({ timeout: 30_000 });
}

async function openModelActivity(page: Page): Promise<void> {
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Model activity" }).click();
}

interface ModelActivityEntry {
  readonly occurredAt?: string;
  readonly kind?: string;
  readonly outcome?: string;
  readonly modelName?: string;
}

async function fetchModelActivity(page: Page): Promise<readonly ModelActivityEntry[]> {
  const response = await page.request.get("/api/ai/model-activity?limit=25");
  expect(response.ok(), `model-activity -> ${response.status()}`).toBeTruthy();
  return ((await response.json()) as { entries: readonly ModelActivityEntry[] }).entries;
}

interface BriefingRun {
  readonly id: string;
  readonly status: string;
  readonly summaryText: string;
}

test("a real HTTP model call appears in the admin model activity log, without its prose (#2889)", async ({
  page
}) => {
  test.setTimeout(300_000);

  await test.step("sign in as admin", async () => {
    await signIn(page);
  });

  await test.step("run a real briefing synthesis through the HTTP provider adapter", async () => {
    const created = await page.request.post("/api/briefings/definitions", {
      data: {
        title: "UAT model activity proof",
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

    // A run row lands only on completion. Poll until this run succeeds with real prose.
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

  await test.step("the endpoint records the call with its model name and outcome", async () => {
    await expect
      .poll(
        async () => {
          const entries = await fetchModelActivity(page);
          return entries.find((entry) => entry.modelName === WRITER_MODEL_NAME)?.outcome;
        },
        {
          timeout: 30_000,
          message: `no model-activity row for ${WRITER_MODEL_NAME} appeared`
        }
      )
      .toBe("ok");
  });

  await test.step("the admin screen shows the row, and never the model's prose", async () => {
    await openModelActivity(page);
    const row = page.locator(".aud__row").first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".aud__cat", { hasText: WRITER_MODEL_NAME }).first()).toBeVisible({
      timeout: 15_000
    });
    await expect(page.locator(".aud__row").getByText("Answered").first()).toBeVisible({
      timeout: 15_000
    });
    // The log is action/outcome only: the model's reply must not leak into it.
    await expect(page.locator(".aud").getByText(WRITER_HEADLINE)).toHaveCount(0);
  });
});
