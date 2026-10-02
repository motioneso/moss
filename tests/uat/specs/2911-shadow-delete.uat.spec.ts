// tests/uat/specs/2911-shadow-delete.uat.spec.ts
//
// #2911 live-path proof. A real chat turn asks the assistant (the deterministic scripted provider)
// to delete the signed-in person's classifier shadow records. That calls
// chat.deleteClassifierShadowRecords, which is destructive + confirm_always, so an approval card
// appears; the test approves it, the turn settles, and the seeded row is gone from the database.
// The stack is an isolated UAT stack on its own port (never :1533).
import { expect, test, type Page, type Response as PlaywrightResponse } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "2911-shadow-delete"
} as const;

const SENTINEL = "2911-shadow-delete";
const TURN_ID = "uat-2911-shadow-delete-turn";
const ACTION_CARD = '[role="region"][aria-label="Action request"]';
const DEADLINE_MS = 120_000;

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

function seedShadowRecord(projectName: string): void {
  execUatSql(
    projectName,
    `INSERT INTO app.chat_classifier_shadow_records
       (owner_user_id, turn_id, message_text, gate_mode, classifier_config_id,
        classifier_config_version, threshold_version)
     VALUES ('${UAT_ADMIN_ID}'::uuid, '${TURN_ID}', 'UAT seeded classifier trial text', 'shadow',
             'uat-classifier-config', 'uat-v1', 'uat-threshold')`
  );
}

function countShadowRecords(projectName: string): number {
  const raw = execUatSql(
    projectName,
    `SELECT count(*) FROM app.chat_classifier_shadow_records
      WHERE owner_user_id = '${UAT_ADMIN_ID}'::uuid`
  ).trim();
  return Number(raw);
}

async function sendMessage(page: Page, text: string): Promise<Promise<PlaywrightResponse>> {
  const composer = page.getByRole("textbox", { name: /^Message/ });
  if (!(await composer.isVisible())) {
    await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
    await expect(composer).toBeVisible();
  }
  const settled = page.waitForResponse(
    (response) =>
      response.url().includes("/api/chat/turn") && response.request().method() === "POST",
    { timeout: DEADLINE_MS }
  );
  await composer.fill(text);
  await composer.press("Enter");
  return settled;
}

test("asking Moss to delete your classifier shadow records removes them (#2911)", async ({
  page
}) => {
  test.setTimeout(300_000);
  const projectName = requireProjectName();

  await test.step("sign in and seed one classifier shadow record", async () => {
    await signIn(page);
    seedShadowRecord(projectName);
    expect(countShadowRecords(projectName)).toBe(1);
  });

  await test.step("ask Moss in chat to delete the records and approve the card", async () => {
    const turn = await sendMessage(
      page,
      `${SENTINEL}: please delete my classifier shadow records.`
    );

    const card = page.locator(ACTION_CARD).last();
    await expect(card.getByRole("button", { name: "Approve" })).toBeVisible({
      timeout: DEADLINE_MS
    });
    await card.getByRole("button", { name: "Approve" }).click();

    const response = await turn;
    expect(response.ok(), `chat turn -> ${response.status()}`).toBeTruthy();
    const body = (await response.json()) as { reply?: string };
    expect(body.reply ?? "").toMatch(/deleted/i);
  });

  await test.step("the records are gone from the database", async () => {
    await expect
      .poll(() => countShadowRecords(projectName), {
        timeout: 30_000,
        message: "the classifier shadow record was not deleted"
      })
      .toBe(0);
  });
});
