import { expect, test, type Page } from "@playwright/test";

// #1452 (part of #1440), see docs/superpowers/plans/2026-08-12-fix-1452-safe-seed.md.
// Drives a real throwaway signup (bare seed level -> zero accounts, needsBootstrap true) through a
// real briefing generation and asserts the rendered Today hero. No shared-DB seed/reset, no
// insert-by-recorded-id fixture -- the whole run lives in the UAT harness's own ephemeral Docker
// stack (tests/uat/provisioner.ts), torn down via its usual `down -v` + assertNoLeakedResources().
export const uatLevel = { level: "bare", without: [] } as const;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

// `bare` has zero owner accounts, so needsBootstrap is true and auth-screen.tsx forces
// mode="sign-up" with the segmented control omitted (no duplicate-accessible-name collision with
// the submit button). A fresh sign-up lands on the onboarding wizard, not the Today page directly
// -- skip it, mirroring the established pattern (real-chat-onboarding.uat.spec.ts,
// 1311-install-grant.uat.spec.ts).
async function signUp(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Name").fill("UAT Throwaway Owner");
  await page.getByLabel("Email").fill("uat-1452-throwaway@example.com");
  await page.getByLabel("Password").fill("uat-1452-password");
  await page.getByRole("button", { name: "Create account" }).click();

  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

test("throwaway signup and a sports follow drive a real briefing to Today", async ({ page }) => {
  test.setTimeout(180_000);

  await signUp(page);

  const followed = await page.request.post("/api/sports/follows", {
    data: { competitionKey: "eng.1" }
  });
  expect(followed.ok(), `competition follow -> ${followed.status()}`).toBe(true);
  console.log("[live proof] owner follows the Premier League through the live Sports API");

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
  console.log("[live proof] morning briefing with a sports follow persisted successfully");

  // Fresh query fetch on reload, no client-cache staleness.
  await page.reload();
  const hero = page.locator(".today-hero");
  await expect(hero).toBeVisible();
  await expect(hero.getByRole("button", { name: "Read the full morning briefing" })).toBeVisible();
  await expect(hero.getByText("Briefing not ready yet")).not.toBeVisible();
  expect(await hero.innerText()).not.toMatch(/Jarvis/i);

  console.log("[live proof] Today rendered the saved morning briefing");
});
