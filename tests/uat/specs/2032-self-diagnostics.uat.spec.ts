import { expect, test, type Page, type Response as PlaywrightResponse } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "2032-self-diagnostics"
} as const;

const REFRESH_DEADLINE_MS = 300_000;

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

async function sendMessage(page: Page, text: string): Promise<Promise<PlaywrightResponse>> {
  const composer = page.getByRole("textbox", { name: /^Message/ });
  if (!(await composer.isVisible())) {
    await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
    await expect(composer).toBeVisible();
  }
  const turnSettled = page.waitForResponse(
    (response) =>
      response.url().includes("/api/chat/turn") && response.request().method() === "POST",
    { timeout: REFRESH_DEADLINE_MS }
  );
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
  const responseBody = await response.text();
  expect(
    response.ok(),
    `platformDiagnostics -> ${response.status()}: ${responseBody}`
  ).toBeTruthy();
  const body = JSON.parse(responseBody) as {
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
  test.setTimeout(600_000);

  await signIn(page);

  const firstTurn = await sendMessage(
    page,
    "UAT-2032-diagnose: use settings.platformDiagnostics to inspect my news."
  );
  const firstResponse = await firstTurn;
  expect(firstResponse.ok(), `diagnosis chat turn -> ${firstResponse.status()}`).toBeTruthy();
  const firstBody = (await firstResponse.json()) as { reply?: string };
  expect(firstBody.reply).toBe(
    "News diagnostics report the latest attempt, latest success, current state, and item count."
  );
  await expect(
    page.getByText(
      "News diagnostics report the latest attempt, latest success, current state, and item count."
    )
  ).toBeVisible();

  const before = await readDiagnostics(page);
  const refreshTurn = await sendMessage(
    page,
    "UAT-2032-refresh: use news.refreshNews now. I approve this refresh request."
  );
  const refreshResponse = await refreshTurn;
  expect(refreshResponse.ok(), `refresh chat turn -> ${refreshResponse.status()}`).toBeTruthy();
  const refreshBody = (await refreshResponse.json()) as { reply?: string };
  expect(refreshBody.reply).toBe("Refresh accepted and queued; it has not completed.");
  await expect(page.getByText("Refresh accepted and queued; it has not completed.")).toBeVisible();

  await expect
    .poll(async () => (await readDiagnostics(page)).facts?.lastSuccessAt, {
      timeout: REFRESH_DEADLINE_MS,
      message: "the real news refresh did not record a successful run"
    })
    .not.toBe(before.facts?.lastSuccessAt);

  const recheckTurn = await sendMessage(
    page,
    "UAT-2032-recheck: use settings.platformDiagnostics again after the refresh."
  );
  const recheckResponse = await recheckTurn;
  expect(recheckResponse.ok(), `recheck chat turn -> ${recheckResponse.status()}`).toBeTruthy();
  const recheckBody = (await recheckResponse.json()) as { reply?: string };
  expect(recheckBody.reply).toBe(
    "News is current after the refresh, with a new success time and item count."
  );
  await expect(
    page.getByText("News is current after the refresh, with a new success time and item count.")
  ).toBeVisible();
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
