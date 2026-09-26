import { expect, test, type Page, type Response as PlaywrightResponse } from "@playwright/test";
import { bringUpRealChatModel, requireUatBaseURL, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true
} as const;

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED);
const REFRESH_DEADLINE_MS = 300_000;
const ACTION_CARD = '[role="region"][aria-label="Action request"]';

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
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat token configured for this run (JARVIS_UAT_REAL_CHAT_CONFIGURED unset) - #2032"
  );
  test.setTimeout(600_000);

  await signInUatAdmin(page);
  await bringUpRealChatModel(page);

  const firstTurn = await sendMessage(
    page,
    "UAT-2032-diagnose: use settings.platformDiagnostics to inspect my news."
  );
  const firstResponse = await firstTurn;
  expect(firstResponse.ok(), `diagnosis chat turn -> ${firstResponse.status()}`).toBeTruthy();
  const firstBody = (await firstResponse.json()) as { reply?: string };
  expect(firstBody.reply).toMatch(/last success/i);
  expect(firstBody.reply).toMatch(/latest attempt|last attempt/i);
  expect(firstBody.reply).toMatch(/\b\d+\s+items?\b/i);

  const before = await readDiagnostics(page);
  const refreshTurn = await sendMessage(
    page,
    "UAT-2032-refresh: use news.refreshNews now. I approve this refresh request."
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
  expect(refreshBody.reply).not.toMatch(/complete/i);

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
  expect(recheckBody.reply).toMatch(/last success/i);
  expect(recheckBody.reply).toMatch(/latest attempt|last attempt/i);
  expect(recheckBody.reply).toMatch(/\b\d+\s+items?\b/i);
  const after = await readDiagnostics(page);
  expect(after.status).toBe("ok");
  expect(after.facts?.lastSuccessAt).toEqual(expect.any(String));
  expect(after.facts?.itemCount).toEqual(expect.any(Number));
});

test("the live server advertises both self-diagnostics tools", async ({ page }) => {
  await signInUatAdmin(page);
  const response = await page.request.get(`${requireUatBaseURL()}/api/ai/assistant-tools`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { tools?: Array<{ name?: string; risk?: string }> };
  expect(body.tools ?? []).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "settings.platformDiagnostics", risk: "read" }),
      expect.objectContaining({ name: "news.refreshNews", risk: "write" })
    ])
  );
});
