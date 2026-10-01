import { expect, test } from "@playwright/test";
import {
  bringUpRealChatModel,
  MODEL_DISCOVERY_DEADLINE_MS,
  signInUatAdmin
} from "./real-chat-signin.js";

// #1452 (part of #1440), see docs/superpowers/plans/2026-08-12-fix-1452-safe-seed.md.
// Signs in as the seeded admin, drives a real briefing generation with a real model, and asserts
// the rendered Today hero. The whole run lives in the UAT harness's own ephemeral Docker stack
// (tests/uat/provisioner.ts), torn down via its usual `down -v` + assertNoLeakedResources().
export const uatLevel = { level: "solo-admin", without: [] } as const;

// A briefing summary only exists when a real model wrote it (a run with no model is a hidden
// fallback by design), so this spec needs the operator's Codex login the harness copies into the
// seeded admin's slot (real-chat-env.ts). Without that login the spec skips.
const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED);

test("an admin with a sports follow drives a real briefing to Today", async ({ page }) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "JARVIS_UAT_REAL_CHAT_TOKEN_FILE is required for a real briefing model (#1452)"
  );
  test.setTimeout(300_000);

  await signInUatAdmin(page);
  await bringUpRealChatModel(page, MODEL_DISCOVERY_DEADLINE_MS);

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
