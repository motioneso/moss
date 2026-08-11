// tests/uat/specs/1533-chat-surface-live-path.uat.spec.ts
//
// #1533 live-path proof (docs/superpowers/specs/2026-08-10-1533-chat-surface-send-routing.md,
// "## Live-path proof: action request without reload"). Proves, against the real browser-driven
// chat surface with no reload, that a module-mounted action request (a) shares one wire surface
// across the EventSource and the /api/chat/turn POST, (b) renders its approval card promptly, and
// (c) settles on Reject without ever falling back to REST rehydration.
//
// Structural precedent is tests/uat/specs/job-search-board.uat.spec.ts — same install/enable
// recipe, same execUatSql/shot helpers (copied, not imported, per that file's own convention).
// This spec seeds its profile directly to `state: 'active'` (not `in_conversation`) via SQL,
// before the module is first opened, so the profile-bootstrap job never fires (use-profiles.ts
// only bootstraps when the profile list comes back empty) and the board/crawl machinery that
// spec exercises stays entirely out of scope here.
import { execFileSync } from "node:child_process";
import { expect, test, type Page, type Response } from "@playwright/test";

import { moduleChatSurface } from "../../../apps/web/src/shell/chat-surface-key.js";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";

// withoutNewsJsonBinding: true is load-bearing, not cosmetic. admin+data's default
// seedAiProviderChunk (tests/uat/seed/chunks/ai.ts) creates a second active "assistant"-purpose
// provider for the module.news JSON binding; combined with chatScript's own
// seedScriptedChatProviderChunk that leaves TWO active admin-owned assistant providers and no
// is_instance_default flag on either, so AiRepository.resolveDefaultProviderId (packages/ai/src/
// repository.ts) hits its "zero or many active ⇒ null" branch and chat has no usable default
// model — the composer shows "No AI provider is connected yet" and Send stays disabled, so Enter
// never fires a turn POST. withoutNewsJsonBinding: true makes seedAiProviderChunk a no-op (see
// its own early-return comment), leaving the scripted provider as the sole active admin-owned
// assistant provider so it resolves as the implicit default. Discovered via a real failed run of
// this spec on 2026-08-11 (Phase 3 timed out waiting for /api/chat/stream); see
// docs/superpowers/handoffs/2026-08-11-1533-chat-surface-build-relay16.md for the full trace.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "1533-surface-probe"
} as const;

// Fixed, not gen_random_uuid()'d — the fixture's chat-script JSON (tests/uat/fixtures/chat-scripts/
// 1533-surface-probe.json) hardcodes this exact profileId in the job-search.criteria.set call it
// scripts, so seed and script must agree on the literal value.
const PROFILE_ID = "11111111-1111-4111-8111-111111111533";
const PROFILE_NAME = "UAT-1533-Surface-Probe";

const SCREENSHOT_DIR = "test-results/1533-chat-surface-live-path-screens";

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

function requireProjectName(): string {
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!projectName) throw new Error("JARVIS_UAT_PROJECT_NAME must be set by run-uat.ts");
  return projectName;
}

// Copied from job-search-board.uat.spec.ts — admin+data lands directly on AppShell, no wizard.
async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();
}

async function openInstanceModules(page: Page): Promise<void> {
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings & permissions" }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Instance modules" }).click();
}

async function openJobSearch(page: Page): Promise<void> {
  await page.locator('nav[aria-label="Modules"]').getByRole("link", { name: "Job Search" }).click();
}

async function shot(page: Page, name: string): Promise<void> {
  const file = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  await test.info().attach(name, { path: file, contentType: "image/png" });
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixtures arg
test.afterEach(async ({}, testInfo) => {
  const seededProfileId = testInfo.annotations.find(
    (annotation) => annotation.type === "1533-fixture-profile"
  )?.description;
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  if (seededProfileId && projectName) {
    try {
      const deletedId = execUatSql(
        projectName,
        `delete from app.job_search_profiles where id = '${seededProfileId}' returning id;`
      ).trim();
      expect(deletedId, "exact seeded profile must be removed").toBe(seededProfileId);
    } catch (error) {
      if (testInfo.status === testInfo.expectedStatus) throw error;
      console.error(`fixture cleanup failed after the test's original failure: ${error}`);
    }
  }
  try {
    const projectName2 = requireProjectName();
    const logs = execFileSync(
      "docker",
      buildUatComposeArgs(projectName2, ["logs", "--tail", "5000", "jarv1s"]),
      { encoding: "utf8" }
    );
    const actionRequestId = testInfo.annotations.find(
      (annotation) => annotation.type === "1533-action-request-id"
    )?.description;
    const bounded = actionRequestId
      ? logs
          .split("\n")
          .filter((line) => line.includes(actionRequestId))
          .slice(0, 50)
          .join("\n")
      : "(no action-request id recorded)";
    console.log(`--- bounded API log lines for this run's action request ---\n${bounded}`);
  } catch (error) {
    console.log(`could not capture bounded API log lines: ${String(error)}`);
  }
});

test("chat surface routing: action request renders and settles without reload (#1533)", async ({
  page
}) => {
  test.setTimeout(600_000);
  let expectedSurface = "";

  await test.step("Phase 1: build, install, enable Job Search; seed an active profile before first open", async () => {
    execFileSync("pnpm", ["build:external:job-search"], { stdio: "inherit" });

    const projectName = requireProjectName();
    const baseURL = requireBaseURL();

    execFileSync(
      "docker",
      buildUatComposeArgs(projectName, [
        "cp",
        "external-modules/job-search",
        "jarv1s:/data/modules/job-search"
      ]),
      { stdio: "inherit" }
    );
    await restartUatStack(projectName, baseURL);

    await signIn(page);
    await openInstanceModules(page);

    const enableSwitch = page.getByRole("checkbox", { name: "Enable Job Search", exact: true });
    await expect(enableSwitch).not.toBeChecked();
    await page.locator("label.jds-switch", { has: enableSwitch }).click();
    await expect(enableSwitch).toBeChecked();

    await restartUatStack(projectName, baseURL);

    // Seeded BEFORE the module is ever opened: use-profiles.ts's automatic bootstrap only fires
    // when the profile list comes back empty, so this profile existing already keeps that job
    // from ever enqueuing — this test is about surface routing, not onboarding.
    const seeded = execUatSql(
      projectName,
      `insert into app.job_search_profiles (id, owner_user_id, name, state, criteria) ` +
        `values ('${PROFILE_ID}', '${UAT_ADMIN_ID}', '${PROFILE_NAME}', 'active', '{}'::jsonb) ` +
        `returning id, surface_key;`
    ).trim();
    const [seededId, surfaceKey] = seeded.split("|");
    expect(seededId, "seed must return the exact profile id").toBe(PROFILE_ID);
    expect(surfaceKey, "seed must return a surface_key").toEqual(expect.any(String));
    if (!seededId || !surfaceKey) throw new Error(`unexpected seed result shape: ${seeded}`);
    test.info().annotations.push({ type: "1533-fixture-profile", description: seededId });
    expectedSurface = moduleChatSurface("job-search", surfaceKey);

    await page.reload();
    await openJobSearch(page);
    await shot(page, "01-module-opened-profile-seeded");
  });

  const streamRequestUrls: string[] = [];
  const turnRequestSurfaces: Array<string | undefined> = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/chat/stream")) {
      streamRequestUrls.push(url);
    } else if (url.includes("/api/chat/turn") && request.method() === "POST") {
      try {
        const body = request.postDataJSON() as { surface?: string };
        turnRequestSurfaces.push(body?.surface);
      } catch {
        turnRequestSurfaces.push(undefined);
      }
    }
  });

  let turnResponsePromise: Promise<Response> | null = null;

  await test.step("Phase 2: select the seeded profile, open Profile tab, click Change in chat", async () => {
    await page
      .locator('nav[aria-label="Job search profile"]')
      .getByRole("button", { name: PROFILE_NAME })
      .click();
    await page.locator('nav[aria-label="Job search view"]').getByRole("button", { name: "Profile" }).click();

    turnResponsePromise = page.waitForResponse(
      (response) => response.url().includes("/api/chat/turn") && response.request().method() === "POST",
      { timeout: 60_000 }
    );

    await page.getByRole("button", { name: "Change in chat" }).click();

    const composer = page.getByRole("textbox", { name: /^Message/ });
    await expect(composer).toHaveValue(
      `I want to change the criteria for the "${PROFILE_NAME}" job search.`
    );
    await shot(page, "02-composer-prefilled-draft");

    // Real Enter, same path as typed text (composer.tsx onKeyDown) — never reload/navigate/close.
    await composer.press("Enter");
  });

  await test.step("Phase 3: EventSource and the turn POST share one module surface", async () => {
    await expect
      .poll(() => streamRequestUrls.length > 0, { timeout: 10_000, message: "no /api/chat/stream request observed" })
      .toBe(true);
    await expect
      .poll(() => turnRequestSurfaces.length > 0, { timeout: 10_000, message: "no /api/chat/turn POST observed" })
      .toBe(true);

    const streamUrl = new URL(streamRequestUrls[streamRequestUrls.length - 1]!, requireBaseURL());
    expect(streamUrl.searchParams.get("surface"), "EventSource must carry this module's surface").toBe(
      expectedSurface
    );
    expect(
      turnRequestSurfaces[turnRequestSurfaces.length - 1],
      "turn POST body must carry the same module surface"
    ).toBe(expectedSurface);
  });

  let actionRequestId: string | null = null;

  await test.step("Phase 4: approval card renders promptly, without reload, while the POST is still pending", async () => {
    const card = page.locator('[role="region"][aria-label="Action request"]');
    // 5s bound per spec — this proves promptness, not the 150s native denial timeout.
    await expect(card).toBeVisible({ timeout: 5_000 });
    actionRequestId = await card.getAttribute("data-action-request-id");
    expect(actionRequestId, "card must carry an action request id").toEqual(expect.any(String));
    if (actionRequestId) {
      test.info().annotations.push({ type: "1533-action-request-id", description: actionRequestId });
    }
    await shot(page, "03-approval-card-visible-pending");

    // Confirm the page never reloaded/navigated to reach this state.
    expect(page.url()).toContain(requireBaseURL());
  });

  await test.step("Phase 5: reject the card; the turn POST settles; no reload was used", async () => {
    const card = page.locator('[role="region"][aria-label="Action request"]');
    await card.getByRole("button", { name: "Reject" }).click();
    await expect(card.getByText("Not approved")).toBeVisible({ timeout: 10_000 });

    if (!turnResponsePromise) throw new Error("Phase 2 did not arm the turn-response wait");
    const turnResponse = await turnResponsePromise;
    expect(turnResponse.ok(), "the original /api/chat/turn POST must settle after Reject").toBe(true);

    await shot(page, "04-card-rejected-turn-settled");
  });
});
