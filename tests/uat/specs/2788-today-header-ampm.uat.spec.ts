import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2788: the Today hero draws its contour-line layer behind the text (#3016), and both "Prepared at" times (the
// hero line and the full reader) show the 12-hour clock with am/pm. Signs in as the seeded admin
// and generates a real morning briefing whose prose comes from the writer fixture.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withBriefingWriterFixture: true
} as const;

const PREPARED_AT = /^Prepared at (1[0-2]|[1-9]):[0-5]\d (am|pm)$/;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible();
}

test("hero draws the contour layer and Prepared at shows am/pm in the hero and the reader", async ({
  page
}) => {
  test.setTimeout(180_000);

  await signIn(page);

  const created = await page.evaluate(async () => {
    const response = await fetch("/api/briefings/definitions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "UAT morning briefing",
        briefingType: "morning",
        enabled: true,
        selectedToolNames: ["vault", "sports.followedFactsToday"]
      })
    });
    return { status: response.status, json: await response.json() };
  });
  expect(created.status).toBe(201);
  // POST /api/briefings/definitions wraps the row: { definition: { id, ... } }.
  const definitionId = created.json.definition.id as string;
  expect(definitionId).toBeTruthy();

  // The definition was created through fetch, bypassing React Query's cache.
  await page.reload();
  await expect(page.getByText("Briefing not ready yet")).toBeVisible();

  const triggered = await page.evaluate(async (id: string) => {
    const response = await fetch(`/api/briefings/definitions/${id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    return { status: response.status, json: await response.json() };
  }, definitionId);
  expect(triggered.status).toBe(202);
  const runId = triggered.json.runId as string;
  expect(runId).toBeTruthy();

  // Run rows have no "pending" state (BriefingRunStatus = "succeeded" | "blocked" | "failed") --
  // a row is inserted only on completion. Poll until it appears, fixed 2s interval, 60s ceiling.
  let matchedRun: { id: string; status: string; summaryText: string } | undefined;
  for (let attempt = 0; attempt < 30 && !matchedRun; attempt++) {
    const polled = await page.evaluate(async (id: string) => {
      const response = await fetch(`/api/briefings/definitions/${id}/runs`);
      return { status: response.status, json: await response.json() };
    }, definitionId);
    expect(polled.status).toBe(200);
    matchedRun = (
      polled.json.runs as Array<{ id: string; status: string; summaryText: string }>
    ).find((run) => run.id === runId);
    if (!matchedRun) {
      await page.waitForTimeout(2_000);
    }
  }

  expect(matchedRun).toBeDefined();
  expect(matchedRun?.status).toBe("succeeded");
  expect(matchedRun?.summaryText.trim()).not.toHaveLength(0);
  console.log("[live proof] morning briefing persisted with writer-fixture prose");

  await page.reload();
  const hero = page.locator(".today-hero");
  await expect(hero).toBeVisible();

  const heroPrepared = hero.locator(".today-hero__prepared-time");
  await expect(heroPrepared).toHaveText(PREPARED_AT);

  // The hero's ::before paints the contour texture.
  const beforeImage = await hero.evaluate((el) => getComputedStyle(el, "::before").backgroundImage);
  expect(beforeImage).toContain("/textures/hero-contours.svg");

  const shotDir = process.env.JARVIS_UAT_SHOT_DIR;
  if (shotDir) await hero.screenshot({ path: `${shotDir}/2788-hero.png` });

  await hero.getByRole("button", { name: "Read the full morning briefing" }).click();
  const readerPrepared = page.locator(".brief-reader__prepared");
  await expect(readerPrepared).toHaveText(PREPARED_AT);
  if (shotDir) await readerPrepared.screenshot({ path: `${shotDir}/2788-reader-prepared.png` });

  console.log(
    "[live proof] hero and reader both show Prepared at with am/pm, contour layer present"
  );
});
