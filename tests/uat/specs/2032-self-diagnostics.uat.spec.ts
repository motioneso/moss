import { expect, test, type Page, type Response as PlaywrightResponse } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE);
const MODEL_DISCOVERY_DEADLINE_MS = 60_000;
const REFRESH_DEADLINE_MS = 300_000;
const POLL_INITIAL_INTERVAL_MS = 500;
const POLL_MAX_INTERVAL_MS = 4_000;
const ACTION_CARD = '[role="region"][aria-label="Action request"]';

function baseUrl(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(baseUrl());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

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
  expect((await begin.json()).status).toBe("ready");

  const deadline = Date.now() + MODEL_DISCOVERY_DEADLINE_MS;
  let interval = POLL_INITIAL_INTERVAL_MS;
  let lastModels: unknown = null;
  while (Date.now() < deadline) {
    const response = await page.request.get("/api/ai/models");
    expect(response.ok(), `models -> ${response.status()}`).toBeTruthy();
    const body = (await response.json()) as {
      models?: readonly { status: string; capabilities: readonly string[] }[];
    };
    lastModels = body.models;
    if (
      body.models?.some((model) => model.status === "active" && model.capabilities.includes("chat"))
    ) {
      return;
    }
    await page.waitForTimeout(Math.min(interval, Math.max(0, deadline - Date.now())));
    interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);
  }
  throw new Error(
    `no chat-capable active model after ${MODEL_DISCOVERY_DEADLINE_MS}ms: ${JSON.stringify(lastModels)}`
  );
}

async function sendMessage(page: Page, text: string): Promise<Promise<PlaywrightResponse>> {
  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  const turnSettled = page.waitForResponse(
    (response) =>
      response.url().includes("/api/chat/turn") && response.request().method() === "POST",
    { timeout: REFRESH_DEADLINE_MS }
  );
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await composer.fill(text);
  await composer.press("Enter");
  return turnSettled;
}

async function readDiagnostics(page: Page): Promise<{
  readonly status?: string;
  readonly facts?: Record<string, unknown>;
}> {
  const response = await page.request.post(
    "/api/ai/assistant-tools/settings.platformDiagnostics/invoke",
    { data: { input: { module: "news", include: ["modules"] } } }
  );
  expect(response.ok(), `platformDiagnostics -> ${response.status()}`).toBeTruthy();
  const body = (await response.json()) as {
    invocation?: { status?: string; result?: unknown };
  };
  expect(body.invocation?.status).toBe("succeeded");
  const result = body.invocation?.result as {
    data?: { modules?: Array<{ status?: string; facts?: Record<string, unknown> }> };
    modules?: Array<{ status?: string; facts?: Record<string, unknown> }>;
  };
  const module = (result.data ?? result).modules?.[0];
  return module ?? {};
}

test("a real Moss conversation diagnoses, refreshes, and rechecks news", async ({ page }) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat token configured for this run (JARVIS_UAT_REAL_CHAT_ENV_FILE unset) - #2032"
  );
  test.setTimeout(600_000);

  await signIn(page);
  await bringUpRealModel(page);

  const firstTurn = await sendMessage(
    page,
    "Use settings.platformDiagnostics to inspect my news. Is it fresh? Cite the latest attempt, latest success, current state, and item count."
  );
  const firstResponse = await firstTurn;
  expect(firstResponse.ok(), `diagnosis chat turn -> ${firstResponse.status()}`).toBeTruthy();
  const firstBody = (await firstResponse.json()) as { reply?: string };
  expect(firstBody.reply).toMatch(/news|fresh|success|attempt|current|stale/i);

  const before = await readDiagnostics(page);
  const refreshTurn = await sendMessage(
    page,
    "Use news.refreshNews now. I approve this refresh request. Tell me it is queued or accepted, and do not say it has completed yet."
  );
  const card = page.locator(ACTION_CARD).filter({ hasText: "Refresh news" }).last();
  await expect(card.getByRole("button", { name: "Approve" })).toBeVisible({
    timeout: REFRESH_DEADLINE_MS
  });
  await card.getByRole("button", { name: "Approve" }).click();
  const refreshResponse = await refreshTurn;
  expect(refreshResponse.ok(), `refresh chat turn -> ${refreshResponse.status()}`).toBeTruthy();
  const refreshBody = (await refreshResponse.json()) as { reply?: string };
  expect(refreshBody.reply).toMatch(/queued|accepted|refresh/i);
  expect(refreshBody.reply).not.toMatch(/completed successfully|has completed/i);

  await expect
    .poll(async () => (await readDiagnostics(page)).facts?.lastSuccessAt, {
      timeout: REFRESH_DEADLINE_MS,
      message: "the real news refresh did not record a successful run"
    })
    .not.toBe(before.facts?.lastSuccessAt);

  const recheckTurn = await sendMessage(
    page,
    "Use settings.platformDiagnostics again to recheck my news after the refresh. Report the new successful freshness time, current state, and item count."
  );
  const recheckResponse = await recheckTurn;
  expect(recheckResponse.ok(), `recheck chat turn -> ${recheckResponse.status()}`).toBeTruthy();
  const recheckBody = (await recheckResponse.json()) as { reply?: string };
  expect(recheckBody.reply).toMatch(/fresh|current|success|item|news/i);
  const after = await readDiagnostics(page);
  expect(after.status).toBe("ok");
  expect(after.facts?.lastSuccessAt).toEqual(expect.any(String));
  expect(after.facts?.itemCount).toEqual(expect.any(Number));
});

test("the live server advertises both self-diagnostics tools", async ({ page }) => {
  await signIn(page);
  const response = await page.request.get(`${baseUrl()}/api/ai/assistant-tools`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { tools?: Array<{ name?: string; risk?: string }> };
  expect(body.tools ?? []).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "settings.platformDiagnostics", risk: "read" }),
      expect.objectContaining({ name: "news.refreshNews", risk: "write" })
    ])
  );
});
