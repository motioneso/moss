import { expect, test, type Page } from "@playwright/test";

// #1452 (part of #1440), see docs/superpowers/plans/2026-08-12-fix-1452-safe-seed.md.
// Drives a real throwaway signup (bare seed level -> zero accounts, needsBootstrap true) through a
// real briefing generation and asserts the rendered Today-page card. No shared-DB seed/reset, no
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

function briefingCard(page: Page) {
  // .jds-brief is reused across >=4 Today-page sections -- scope to the one whose kicker reads
  // "Morning briefing" to avoid Playwright strict-mode ambiguity.
  return page.locator(".jds-brief").filter({ has: page.getByText("Morning briefing") });
}

test("throwaway signup drives a real briefing generation to a rendered Today card, no old product name", async ({
  page
}) => {
  test.setTimeout(180_000);

  await signUp(page);

  // Pre-generation: the placeholder is visible, no briefing run exists yet for this brand-new
  // account.
  await expect(page.getByText("Your morning briefing is not ready yet.")).toBeVisible();

  const created = await page.evaluate(async () => {
    const response = await fetch("/api/briefings/definitions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "UAT morning briefing",
        briefingType: "morning",
        enabled: true,
        selectedToolNames: ["vault"]
      })
    });
    return { status: response.status, json: await response.json() };
  });
  expect(created.status).toBe(201);
  const definitionId = created.json.id as string;
  expect(definitionId).toBeTruthy();

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

  // Fresh query fetch on reload, no client-cache staleness.
  await page.reload();

  const card = briefingCard(page);
  await expect(card).toBeVisible();
  await expect(card.locator(".jds-brief__kicker")).toHaveText("Morning briefing");
  await expect(card.locator(".jds-brief__title")).toHaveText("Your day, in focus");
  await expect(page.getByText("Your morning briefing is not ready yet.")).not.toBeVisible();

  const cardText = await card.innerText();
  expect(cardText).not.toMatch(/Jarvis/i);

  await page.screenshot({ path: test.info().outputPath("briefing-card.png") });
});
