import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1572 — custom public news sources by team and league. This is the Live-Path Gate proof for
// Task 1 (schema + discovery/preview/confirm REST + settings UI).
//
// The full add -> assign -> edit -> remove loop needs a real, working JSON-capable model:
// resolveSportsSourceInput (packages/sports/src/source/discovery.ts) fetches the submitted URL
// for real, then calls a real AI policy check (decideSourcePolicy) before a candidate is ever
// returned. The UAT harness's default "admin+data" AI seed is deliberately a fake, non-functional
// credential (tests/uat/seed/chunks/ai.ts) that exists only to satisfy UI gates, not to answer
// real calls — so this spec follows the same pattern as 926-food-real-chat.uat.spec.ts: it runs
// the full live loop only when the operator supplied a real Anthropic token
// (JARVIS_UAT_REAL_CHAT_ENV_FILE), and stays skipped on every default/CI run so the gate remains
// credential-free. A second, always-on test proves the settings surface itself is live and wired,
// with no dependency on a real model.
export const uatLevel = { level: "solo-admin", without: [] } as const;

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE);

// A long-standing, publicly documented ESPN RSS feed — a direct feed URL (not a homepage), so
// resolveSportsSourceInput's discovery step has nothing to guess: it only needs to fetch, parse,
// and pass the real AI policy check. Real network + real model, so genuinely live, not mocked.
const TEST_FEED_URL = "https://www.espn.com/espn/rss/nfl/news";
const MODEL_DISCOVERY_DEADLINE_MS = 60_000;
const POLL_INITIAL_INTERVAL_MS = 500;
const POLL_MAX_INTERVAL_MS = 4_000;

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
  // solo-admin returns before the onboarding chunk, so login can land on the first-run wizard.
  // Skip it only when shown, keeping this idempotent across the shared, non-reset UAT DB.
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

async function openSportsSettings(page: Page): Promise<void> {
  await page.goto(`${requireBaseURL()}/settings?section=modules&module=sports`);
}

// Same non-interactive onboarding the #926 spec drives: the provisioner has already persisted the
// operator's OAuth token into the cli-auth volume, so login settles to "ready" rather than handing
// back an authorization URL, and the resulting model becomes the instance-default that
// resolveModelForService("module.sports") falls back to (no explicit module.sports binding is
// seeded — see tests/uat/seed/chunks/ai.ts's comment on the implicit-default-provider fallback).
async function bringUpRealModel(page: Page): Promise<void> {
  const install = await page.request.post("/api/onboarding/provider-install", {
    data: { providerKind: "anthropic" }
  });
  expect(install.ok(), `provider-install -> ${install.status()}`).toBeTruthy();
  expect((await install.json()).installState).toBe("installed");

  const begin = await page.request.post("/api/onboarding/provider-login/begin", {
    data: { providerKind: "anthropic" }
  });
  expect(begin.ok(), `provider-login/begin -> ${begin.status()}`).toBeTruthy();
  expect(
    (await begin.json()).status,
    "the pre-seeded token should authenticate the anthropic CLI non-interactively"
  ).toBe("ready");

  const deadline = Date.now() + MODEL_DISCOVERY_DEADLINE_MS;
  let interval = POLL_INITIAL_INTERVAL_MS;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const body = (await (await page.request.get("/api/ai/models")).json()) as {
      models: readonly { status: string; capabilities: readonly string[] }[];
    };
    last = body.models;
    if (body.models.some((m) => m.status === "active" && m.capabilities.includes("json"))) return;
    await page.waitForTimeout(Math.min(interval, Math.max(0, deadline - Date.now())));
    interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);
  }
  throw new Error(
    `no json-capable active model after ${MODEL_DISCOVERY_DEADLINE_MS}ms: ${JSON.stringify(last)}`
  );
}

test("the Custom sources settings surface is live and wired (#1572)", async ({ page }) => {
  await signIn(page);
  await openSportsSettings(page);

  const section = page.locator('section[aria-label="Custom sports news sources"]');
  await expect(section).toBeVisible();
  await expect(section.getByLabel("Publication homepage or domain")).toBeVisible();
  await expect(section.getByRole("button", { name: "Check" })).toBeVisible();
});

test("adding, assigning, editing, and removing a custom source works end to end (#1572)", async ({
  page
}) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat token configured for this run (JARVIS_UAT_REAL_CHAT_ENV_FILE unset) — #1572"
  );
  // A cold provider probe, async model discovery, plus a real fetch and a real AI policy call.
  test.setTimeout(300_000);

  await signIn(page);
  await bringUpRealModel(page);

  // Seed a whole-league follow via the real API so the assignment picker has something to offer —
  // "NFL" is static catalog data (packages/sports/src/source/catalog.ts), safe to assume present.
  const followResponse = await page.request.post("/api/sports/follows", {
    data: { competitionKey: "nfl" }
  });
  expect(followResponse.ok(), `follows -> ${followResponse.status()}`).toBeTruthy();

  await openSportsSettings(page);
  const section = page.locator('section[aria-label="Custom sports news sources"]');

  await section.getByLabel("Publication homepage or domain").fill(TEST_FEED_URL);
  await section.getByRole("button", { name: "Check" }).click();

  const candidate = section.locator(".sp-src__candidate");
  await expect(
    candidate,
    "the real fetch + AI policy check never produced a candidate for a known-stable ESPN feed"
  ).toBeVisible({ timeout: 90_000 });
  const domain = (await candidate.locator(".sp-src__item-meta").first().textContent())?.trim();
  expect(domain, "candidate rendered with no canonical domain").toBeTruthy();

  await candidate.getByLabel("All NFL").check();
  await candidate.getByRole("button", { name: "Add this source" }).click();
  await expect(section.getByText("Source added.")).toBeVisible({ timeout: 15_000 });

  const itemRow = section.locator(".sp-src__item").filter({ hasText: domain as string });
  await expect(itemRow).toBeVisible();
  await expect(itemRow.getByText("Unassigned — not used yet.")).toHaveCount(0);

  // Edit: unassign it, save, and confirm the change persisted.
  await itemRow.getByRole("button", { name: /^Edit teams/ }).click();
  await itemRow.getByLabel("All NFL").uncheck();
  await itemRow.getByRole("button", { name: "Save" }).click();
  await expect(itemRow.getByText("Unassigned — not used yet.")).toBeVisible({ timeout: 15_000 });

  // Remove: the row must disappear from the live list.
  await itemRow.getByRole("button", { name: /^Remove/ }).click();
  await expect(section.locator(".sp-src__item").filter({ hasText: domain as string })).toHaveCount(
    0,
    { timeout: 15_000 }
  );
});
