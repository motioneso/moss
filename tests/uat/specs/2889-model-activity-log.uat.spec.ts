// tests/uat/specs/2889-model-activity-log.uat.spec.ts
//
// Plan 3.6a (#2889) live-path proof. A real chat turn runs through the scripted CLI provider, so
// the provider-adapter recording seam fires for real. An admin then opens Settings > Model
// activity and sees the row; the log shows the model name and the outcome, never the chat text.
//
// withoutNewsJsonBinding: true is load-bearing for the same reason as the #1252 live-path spec:
// without it, admin+data's default AI-provider seeding plus this spec's own scripted provider
// leaves two active assistant providers and no usable default, so the chat turn never sends.
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "phase1-smoke"
} as const;

const SCRIPTED_MODEL_NAME = "uat-scripted-chat-model";
const CHAT_MESSAGE = "show me my goals";

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
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible({ timeout: 30_000 });
}

async function openModelActivity(page: Page): Promise<void> {
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Model activity" }).click();
}

interface ModelActivityEntry {
  readonly occurredAt?: string;
  readonly kind?: string;
  readonly outcome?: string;
  readonly modelName?: string;
}

async function fetchModelActivity(page: Page): Promise<readonly ModelActivityEntry[]> {
  const response = await page.request.get("/api/ai/model-activity?limit=25");
  expect(response.ok(), `model-activity -> ${response.status()}`).toBeTruthy();
  return ((await response.json()) as { entries: readonly ModelActivityEntry[] }).entries;
}

test("a real model call appears in the admin model activity log, without its chat text (#2889)", async ({
  page
}) => {
  test.setTimeout(300_000);

  await test.step("sign in as admin", async () => {
    await signIn(page);
  });

  await test.step("run a real chat turn on the scripted provider", async () => {
    await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
    const composer = page.getByRole("textbox", { name: /^Message/ });
    await composer.fill(CHAT_MESSAGE);
    await composer.press("Enter");
    await expect(page.getByText("Here are your goals.", { exact: false })).toBeVisible({
      timeout: 60_000
    });
  });

  await test.step("the endpoint records the call with its model name and outcome", async () => {
    await expect
      .poll(
        async () => {
          const entries = await fetchModelActivity(page);
          return entries.find((entry) => entry.modelName === SCRIPTED_MODEL_NAME)?.outcome;
        },
        {
          timeout: 30_000,
          message: `no model-activity row for ${SCRIPTED_MODEL_NAME} appeared`
        }
      )
      .toBe("ok");
  });

  await test.step("the admin screen shows the row, and never the chat text", async () => {
    await openModelActivity(page);
    const row = page.locator(".aud__row").first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".aud__cat", { hasText: SCRIPTED_MODEL_NAME }).first()).toBeVisible({
      timeout: 15_000
    });
    await expect(page.locator(".aud__row").getByText("Answered").first()).toBeVisible({
      timeout: 15_000
    });
    // The log is action/outcome only: the turn's reply must not leak into it.
    await expect(page.locator(".aud").getByText("Here are your goals.")).toHaveCount(0);
  });
});
