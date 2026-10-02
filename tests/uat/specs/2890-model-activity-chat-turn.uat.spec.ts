// tests/uat/specs/2890-model-activity-chat-turn.uat.spec.ts
//
// Plan 3.6b (#2890) live-path proof for a live chat turn. 3.6a recorded only the provider-adapter
// boundary, which a live chat turn never reaches — chat runs a whole CLI session. This spec proves
// the new per-turn recording through the real app: an admin sends a chat message (a real turn
// against the scripted chat provider), then opens Settings > Model activity and sees a chat row for
// the turn's real model, without the message text.
//
// Kept as its own spec (rather than folded into 2889-model-activity-log.uat.spec.ts) because the
// scripted chat provider and the 3.6a briefing-writer HTTP provider cannot both be the active chat
// model on one instance; each proof runs on its own instance.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "phase1-smoke"
} as const;

// The scripted chat provider's model, seeded by tests/uat/seed/chunks/chat-script.ts.
const SCRIPTED_CHAT_MODEL_NAME = "uat-scripted-chat-model";
const MESSAGE = "UAT 3.6b chat turn for the model activity log";

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
  const skip = page.getByRole("button", { name: "Skip setup" });
  const menu = page.locator(".jds-usermenu__trigger");
  await expect(skip.or(menu).first()).toBeVisible({ timeout: 30_000 });
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible({ timeout: 30_000 });
}

async function sendMessage(page: Page): Promise<void> {
  await page.locator(".topbar-actions button").click();
  const drawer: Locator = page.locator("aside.chatd");
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  const turnResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/chat/turn") &&
      response.request().method() === "POST",
    { timeout: 180_000 }
  );
  const composer = drawer.getByLabel("Message Moss");
  await composer.fill(MESSAGE);
  await composer.press("Enter");
  const response = await turnResponse;
  expect(response.status(), `chat turn -> ${response.status()}`).toBe(200);
}

async function openModelActivity(page: Page): Promise<void> {
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Model activity" }).click();
}

interface ModelActivityEntry {
  readonly kind?: string;
  readonly outcome?: string;
  readonly modelName?: string;
}

async function fetchModelActivity(page: Page): Promise<readonly ModelActivityEntry[]> {
  const response = await page.request.get("/api/ai/model-activity?limit=25");
  expect(response.ok(), `model-activity -> ${response.status()}`).toBeTruthy();
  return ((await response.json()) as { entries: readonly ModelActivityEntry[] }).entries;
}

test("a live chat turn appears in the admin model activity log (#2890)", async ({ page }) => {
  test.setTimeout(300_000);

  await test.step("sign in as admin", async () => {
    await signIn(page);
  });

  await test.step("send a real chat turn through the scripted provider", async () => {
    await sendMessage(page);
  });

  await test.step("the endpoint records one chat row for the turn's model", async () => {
    await expect
      .poll(
        async () => {
          const entries = await fetchModelActivity(page);
          return entries.find(
            (entry) => entry.kind === "chat" && entry.modelName === SCRIPTED_CHAT_MODEL_NAME
          )?.outcome;
        },
        {
          timeout: 30_000,
          message: `no chat model-activity row for ${SCRIPTED_CHAT_MODEL_NAME} appeared`
        }
      )
      .toBe("ok");
  });

  await test.step("the admin screen shows the chat row, and never the message text", async () => {
    await openModelActivity(page);
    const chatRow = page.locator(".aud__row").filter({ hasText: SCRIPTED_CHAT_MODEL_NAME }).first();
    await expect(chatRow).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".aud").getByText(MESSAGE)).toHaveCount(0);
  });
});
