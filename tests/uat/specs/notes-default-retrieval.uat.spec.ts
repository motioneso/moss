import { expect, test, type APIResponse, type Page } from "@playwright/test";

import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE);
const POLL_DEADLINE_MS = 60_000;
const FACT = "kumquat focaccia";

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

async function readJson(response: APIResponse): Promise<unknown> {
  expect(response.ok(), `${response.url()} -> ${response.status()}`).toBeTruthy();
  return response.json();
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
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

async function ensureRealChat(page: Page): Promise<void> {
  const install = (await readJson(
    await page.request.post("/api/onboarding/provider-install", {
      data: { providerKind: "anthropic" }
    })
  )) as { installState?: string };
  expect(install.installState).toBe("installed");

  const login = (await readJson(
    await page.request.post("/api/onboarding/provider-login/begin", {
      data: { providerKind: "anthropic" }
    })
  )) as { status?: string };
  expect(login.status).toBe("ready");

  await expect
    .poll(
      async () => {
        const body = (await readJson(await page.request.get("/api/ai/models"))) as {
          models: readonly { capabilities: readonly string[]; status: string }[];
        };
        return body.models.some(
          (model) => model.status === "active" && model.capabilities.includes("chat")
        );
      },
      { timeout: POLL_DEADLINE_MS, message: "no active chat-capable model became available" }
    )
    .toBe(true);
}

test("a later chat answers from notes without narrating retrieval (#1556)", async ({ page }) => {
  test.skip(!REAL_CHAT_CONFIGURED, "needs a real chat-capable provider — #1121");
  test.setTimeout(240_000);

  await signIn(page);
  await ensureRealChat(page);

  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const composer = page.getByRole("textbox", { name: "Message Moss" });
  const path = `uat/notes-default-retrieval-${Date.now()}.md`;
  await composer.fill(
    `Use notes.create to create ${path} containing exactly: Launch snack decision: ${FACT}. ` +
      "Do not ask a follow-up question."
  );
  await composer.press("Enter");

  const action = page.getByRole("region", { name: "Action request" });
  await expect(action).toBeVisible({ timeout: 60_000 });
  await action.getByRole("button", { name: "Approve" }).click();
  await expect(action.getByText("Approved")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: "New chat" }).click();
  await composer.fill("What snack did we choose for the launch?");
  await composer.press("Enter");

  await expect(page.getByText(new RegExp(FACT, "i"))).toBeVisible({ timeout: 60_000 });
  const threadText = await page.locator(".chatd__log").innerText();
  expect(threadText).not.toMatch(
    /searching (?:your )?notes|checking (?:your )?notes|let me (?:check|search)/i
  );
});
