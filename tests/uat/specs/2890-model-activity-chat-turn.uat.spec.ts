// tests/uat/specs/2890-model-activity-chat-turn.uat.spec.ts
//
// Plan 3.6b (#2890) live-path proof for a live chat turn. 3.6a recorded only the provider-adapter
// boundary, which a live chat turn never reaches — chat runs a whole CLI session. This spec proves
// the new per-turn recording through the real app: an admin sends a real chat turn through the
// drawer (a real model reply), then opens Settings > Activity and sees one "Answered a chat
// message" line for the turn. (#2956 slice D retired the old Model activity screen.)
//
// This uses the operator's own signed-in Codex login (tests/uat/real-chat-env.ts, #2732) rather
// than the scripted provider fixture: the ACP chat engine spawns @agentclientprotocol/
// claude-agent-acp, whose protocol the scripted fixture no longer satisfies, so a scripted turn
// fails ("Failed to fetch") before it completes. The real-chat path is the one working provider
// reachable in a UAT stack. The spec SKIPS when no real login is configured, so CI and the gate
// stay credential-free — matching real-chat-onboarding.uat.spec.ts.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { bringUpRealChatModel, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

// #2732: the provisioner sets this ONLY after copying a real Codex login into the stack. Absent on
// every default/CI run, so the whole spec skips rather than failing there.
const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED);
// A live-proof run sets this so a missing real login is a LOUD failure, not a silent skip that
// reads as a pass. CI and default runs leave it unset and keep the skip.
const REQUIRE_REAL_CHAT = Boolean(process.env.JARVIS_UAT_REQUIRE_REAL_CHAT);

const MESSAGE = "UAT 3.6b coverage check: reply with a short greeting.";

async function openActivity(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
}

interface ModelActivityEntry {
  readonly kind?: string;
  readonly outcome?: string;
  readonly modelName?: string;
}

async function fetchModelActivity(page: Page): Promise<readonly ModelActivityEntry[]> {
  // #2956 slice D retired /api/ai/model-activity; the owner-scoped lines endpoint
  // carries the same kind/outcome fields for the admin's own rows.
  const response = await page.request.get("/api/ai/activity-lines?limit=25");
  expect(response.ok(), `activity-lines -> ${response.status()}`).toBeTruthy();
  return ((await response.json()) as { entries: readonly ModelActivityEntry[] }).entries;
}

/** Send the message through the real drawer, waiting for the turn route, and assert a reply. */
async function sendThroughDrawer(page: Page): Promise<void> {
  await page.locator(".topbar-actions button").click();
  const drawer: Locator = page.locator("aside.chatd");
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  const composer = drawer.getByLabel("Message Moss");
  await composer.fill(MESSAGE);
  const turnResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/chat/turn") &&
      response.request().method() === "POST",
    { timeout: 180_000 }
  );
  await composer.press("Enter");
  const response = await turnResponse;
  expect(response.status(), `chat turn -> ${response.status()}`).toBe(200);
  // The real model answered; the reply is non-deterministic so we only require it to render.
  await expect(drawer.locator(".chatd-msg:not(.chatd-msg--me) .chatd-bubble").first()).toBeVisible({
    timeout: 120_000
  });
}

test("a live chat turn appears in the Activity lines (#2890)", async ({ page }) => {
  if (REQUIRE_REAL_CHAT && !REAL_CHAT_CONFIGURED) {
    throw new Error(
      "JARVIS_UAT_REQUIRE_REAL_CHAT is set but no real Codex login was copied into this stack " +
        "(JARVIS_UAT_REAL_CHAT_CONFIGURED unset), so the live proof did not actually run. " +
        "Provide ~/.codex/auth.json or unset the strict flag."
    );
  }
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat login configured for this run (JARVIS_UAT_REAL_CHAT_CONFIGURED unset), see #2732"
  );
  test.setTimeout(300_000);

  await test.step("sign in as admin", async () => {
    await signInUatAdmin(page);
  });

  await test.step("install + log in the real Codex CLI and bind the cheapest chat model", async () => {
    const model = await bringUpRealChatModel(page);
    expect(model.id, "no chat model id returned").toBeTruthy();
  });

  await test.step("send a real chat turn through the drawer", async () => {
    await sendThroughDrawer(page);
  });

  await test.step("the endpoint records exactly one chat row for the turn", async () => {
    await expect
      .poll(
        async () => {
          const entries = await fetchModelActivity(page);
          return entries.filter((entry) => entry.kind === "chat").length;
        },
        { timeout: 30_000, message: "expected exactly one chat model-activity row" }
      )
      .toBe(1);
    // A duplicate would land just after the first row, so wait briefly and count once more.
    await page.waitForTimeout(3_000);
    const chatRows = (await fetchModelActivity(page)).filter((entry) => entry.kind === "chat");
    expect(chatRows.length, "a turn must leave exactly one chat row").toBe(1);
    expect(chatRows[0]?.outcome, "the chat row should be ok").toBe("ok");
  });

  await test.step("the Activity page shows one answered-chat line for the turn", async () => {
    await openActivity(page);
    const chatLine = page.locator(".act-line", { hasText: "Answered a chat message" }).first();
    await expect(chatLine).toBeVisible({ timeout: 15_000 });
  });
});
