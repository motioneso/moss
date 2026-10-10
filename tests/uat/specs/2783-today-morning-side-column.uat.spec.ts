import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2783: the morning Today side column carries the first-meeting card and, only when a plan block
// moved after the morning report was prepared, a "Since last night" section. "At a glance" and
// "Today's agenda" are gone, and no preparation list appears because no source backs one.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withBriefingWriterFixture: true
} as const;

const TZ = "America/Los_Angeles";

function baseURL(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

function localDay(date = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}

function localIso(day: string, time: string): string {
  const offset =
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
      .formatToParts(new Date(`${day}T12:00:00Z`))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = offset.match(/^GMT([+-])(\d{2}):(\d{2})$/);
  return new Date(
    `${day}T${time}:00${match ? `${match[1]}${match[2]}:${match[3]}` : "Z"}`
  ).toISOString();
}

const SERVER_DAY = localDay();

async function json(page: Page, path: string, init?: RequestInit) {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, init);
      return { status: response.status, body: await response.json() };
    },
    { path, init }
  );
}

function post(body: unknown, method = "POST"): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function signIn(page: Page): Promise<void> {
  await page.goto(baseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible();
}

test("morning side column shows Since last night only after a block moves", async ({ page }) => {
  test.setTimeout(300_000);
  await page.clock.setFixedTime(new Date(localIso(SERVER_DAY, "08:00")));
  await signIn(page);

  const task = await json(page, "/api/tasks", post({ title: "2783 moved block", dueAt: null }));
  expect(task.status).toBe(201);
  const taskId = task.body.task.id as string;

  const created = await json(
    page,
    "/api/calendar/day-plans",
    post({ date: SERVER_DAY, timeZone: TZ })
  );
  expect(created.status).toBe(200);
  const planId = created.body.plan.id as string;
  const draftAt = async (time: string, revision: number, id?: string) =>
    json(
      page,
      `/api/calendar/day-plans/${planId}/draft`,
      post(
        {
          date: SERVER_DAY,
          timeZone: TZ,
          expectedRevision: revision,
          blocks: [
            {
              ...(id ? { id } : {}),
              kind: "focus",
              taskId,
              title: null,
              pendingChange: {
                kind: "add",
                startsAt: localIso(SERVER_DAY, time),
                durationMinutes: 30
              }
            }
          ]
        },
        "PATCH"
      )
    );
  const first = await draftAt("10:00", created.body.plan.revision);
  expect(first.status).toBe(200);
  const blockId = first.body.plan.blocks[0].id as string;

  const definition = await json(
    page,
    "/api/briefings/definitions",
    post({
      title: "2783 morning",
      briefingType: "morning",
      cadence: "manual",
      enabled: true,
      scheduleMetadata: { targetTime: "07:00", timezone: TZ },
      selectedToolNames: ["tasks.list", "calendar.listVisibleEvents"]
    })
  );
  expect(definition.status).toBe(201);
  const definitionId = definition.body.definition.id as string;
  const run = await json(page, `/api/briefings/definitions/${definitionId}/run`, post({}));
  expect(run.status).toBe(202);
  for (let attempt = 0; attempt < 120; attempt++) {
    const runs = await json(page, `/api/briefings/definitions/${definitionId}/runs`);
    const found = (runs.body.runs as Array<{ id: string; status: string }>).find(
      (r) => r.id === run.body.runId
    );
    if (found?.status === "succeeded") break;
    if (found?.status === "failed" || found?.status === "blocked")
      throw new Error(`morning run ${found.status}`);
    await page.waitForTimeout(1000);
  }

  const sideColumn = page.getByRole("complementary", { name: "Today widgets" });

  // Nothing moved yet: no section, and the removed sections stay gone.
  await page.goto("/today");
  await expect(sideColumn).toBeVisible();
  await expect(sideColumn).not.toContainText("Since last night");
  await expect(sideColumn).not.toContainText("At a glance");
  await expect(sideColumn).not.toContainText("Today's agenda");
  await expect(sideColumn).not.toContainText("Your preparation");

  // Move the block after the report was prepared.
  const plan = await json(
    page,
    `/api/calendar/day-plan?date=${SERVER_DAY}&timeZone=${encodeURIComponent(TZ)}`
  );
  const moved = await draftAt("11:30", plan.body.plan.revision, blockId);
  expect(moved.status).toBe(200);

  await page.goto("/today");
  await expect(sideColumn).toContainText("Since last night");
  await expect(sideColumn).toContainText("11:30");
  // The move is an unaccepted draft, so it must read as proposed, not as set.
  await expect(sideColumn).toContainText("proposed");
  await sideColumn.screenshot({ path: "test-results/2783-side-column-moved.png" });
});
