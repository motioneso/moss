// tests/uat/specs/2911-shadow-delete-real.uat.spec.ts
//
// #2911 live-path proof with a REAL model through the chat drawer (the route PR 2904 proved
// works; see tests/uat/specs/2890-model-activity-chat-turn.uat.spec.ts for why the ACP chat
// engine no longer plays the scripted fixture). An admin asks Moss to delete their classifier
// shadow records, approves the confirmation card, and the seeded row is gone from the database.
//
// SKIPS unless the operator's own Codex login was copied into the stack
// (JARVIS_UAT_REAL_CHAT_CONFIGURED — see tests/uat/real-chat-env.ts, #2732), so CI and the gate
// stay credential-free. Run on an isolated test stack, never :1533.
import { expect, test, type Locator } from "@playwright/test";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";
import { execUatSql } from "./job-search-board-sql.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED);
const ACTION_CARD = '[role="region"][aria-label="Action request"]';
const TURN_ID = "uat-2911-shadow-delete-real";
const MESSAGE =
  "Please delete my classifier shadow records now. Use the chat.deleteClassifierShadowRecords tool.";

function seedShadowRecord(): void {
  execUatSql(
    requireUatProjectName(),
    `INSERT INTO app.chat_classifier_shadow_records
       (owner_user_id, turn_id, message_text, gate_mode, classifier_config_id,
        classifier_config_version, threshold_version)
     VALUES ('${UAT_ADMIN_ID}'::uuid, '${TURN_ID}', 'UAT seeded classifier trial text', 'shadow',
             'uat-classifier-config', 'uat-v1', 'uat-threshold')`
  );
}

function countShadowRecords(): number {
  return Number(
    execUatSql(
      requireUatProjectName(),
      `SELECT count(*) FROM app.chat_classifier_shadow_records
        WHERE owner_user_id = '${UAT_ADMIN_ID}'::uuid`
    ).trim()
  );
}

test("asking Moss to delete your classifier shadow records removes them, with a real model (#2911)", async ({
  page
}) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat login configured for this run (JARVIS_UAT_REAL_CHAT_CONFIGURED unset) — #2732"
  );
  test.setTimeout(420_000);

  await test.step("sign in, seed one shadow record, and bring up a real chat model", async () => {
    await signInUatAdmin(page);
    seedShadowRecord();
    expect(countShadowRecords()).toBe(1);
    const model = await bringUpRealChatModel(page);
    expect(model.id, "no chat model id returned").toBeTruthy();
  });

  await test.step("ask Moss in the drawer to delete the records, then approve the card", async () => {
    await page.locator(".topbar-actions button").click();
    const drawer: Locator = page.locator("aside.chatd");
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    const composer = drawer.getByLabel("Message Moss");
    await composer.fill(MESSAGE);
    const turnResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith("/api/chat/turn") &&
        response.request().method() === "POST",
      { timeout: 300_000 }
    );
    await composer.press("Enter");

    const card = page.locator(ACTION_CARD).last();
    await expect(card.getByRole("button", { name: "Approve" })).toBeVisible({ timeout: 180_000 });
    await card.getByRole("button", { name: "Approve" }).click();

    const response = await turnResponse;
    expect(response.status(), `chat turn -> ${response.status()}`).toBe(200);
    await expect(drawer.locator(".chatd-msg:not(.chatd-msg--me) .chatd-bubble").last()).toBeVisible(
      {
        timeout: 120_000
      }
    );
  });

  await test.step("the records are gone from the database", async () => {
    await expect
      .poll(() => countShadowRecords(), {
        timeout: 30_000,
        message: "the classifier shadow record was not deleted"
      })
      .toBe(0);
  });
});
