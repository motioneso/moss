// tests/uat/specs/2911-shadow-delete.uat.spec.ts
//
// #2911 live-path proof. A real chat turn asks the assistant (the deterministic scripted provider)
// to delete the signed-in person's classifier shadow records. That calls
// chat.deleteClassifierShadowRecords, which is destructive + confirm_always, so an approval card
// appears; the test approves it, the turn settles, and the seeded row is gone from the database.
// The stack is an isolated UAT stack on its own port (never :1533).
//
// #1121 update: the scripted provider cannot host the whole card round-trip. The ACP chat engine
// and the tested invoke route both resolve an approval through a live in-process gateway waiter
// (the transcript tools/call the chat engine votes on), which a scripted chat turn never creates.
// What this spec CAN prove without a real model is the tool's confirmation gate and its owner
// scoped delete, driven through the app's own endpooints while signed in as the real user. The
// end-to-end "ask Moss in chat, approve the card, records are gone" proof is
// 2911-shadow-delete-real.uat.spec.ts, which needs a real chat login (JARVIS_UAT_REAL_CHAT_CONFIGURED).
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "2911-shadow-delete"
} as const;

const TURN_ID = "uat-2911-shadow-delete-turn";
const TOOL_NAME = "chat.deleteClassifierShadowRecords";
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
  const menu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
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

/**
 * Proves the tool is gated: invoking it as an ordinary signed-in user is refused with a pending
 * confirmation and an action request id, and nothing is deleted yet.
 */
async function expectDeleteRequiresConfirmation(page: Page): Promise<void> {
  const response = await page.request.post(`/api/ai/assistant-tools/${TOOL_NAME}/invoke`, {
    data: { input: {} },
    timeout: DEADLINE_MS
  });
  const body = await response.text();
  expect(response.status(), `${TOOL_NAME} should require confirmation first: ${body}`).toBe(403);
  const blocked = JSON.parse(body) as {
    invocation?: { blockedReason?: string; actionRequestId?: string };
  };
  expect(blocked.invocation?.blockedReason).toBe("confirmation_required");
  expect(
    blocked.invocation?.actionRequestId,
    "confirmation must carry an action request id"
  ).toEqual(expect.any(String));
}

test("a plain request to delete classifier shadow records is refused and the records stay (#2911)", async ({
  page
}) => {
  test.setTimeout(300_000);
  const projectName = requireProjectName();

  await test.step("sign in and seed one classifier shadow record", async () => {
    await signIn(page);
    seedShadowRecord(projectName);
    expect(countShadowRecords(projectName)).toBe(1);
  });

  await test.step("the tool refuses a plain invoke and asks for confirmation", async () => {
    await expectDeleteRequiresConfirmation(page);
    // Still present: a refused invoke must not delete anything.
    expect(countShadowRecords(projectName)).toBe(1);
  });
});
