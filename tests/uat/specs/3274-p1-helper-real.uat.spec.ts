import { expect, test, type Page, type Response } from "@playwright/test";
import type { GetChatPrivacyStateResponse, ListChatThreadMessagesResponse } from "@moss/shared";
import { openChatDrawer } from "../visual-parity/shell-navigation.js";
import { bringUpRealChatModel, signInUatAdmin } from "./real-chat-signin.js";

// Repository live-path proof uses executable assertions and bounded text only.
test.use({ trace: "off", screenshot: "off", video: "off" });

export const uatLevel = { level: "solo-admin", without: [] } as const;

const REPLIES = ".chatd-msg:not(.chatd-msg--me) .chatd-bubble";
const P1_QUESTION = "What are my goals?";

function isClear(response: Response): boolean {
  return (
    new URL(response.url()).pathname.endsWith("/api/chat/clear") &&
    response.request().method() === "POST"
  );
}

async function drawerThreadId(page: Page): Promise<string | undefined> {
  const response = await page.request.get("/api/chat/privacy?surface=drawer");
  expect(response.status()).toBe(200);
  return ((await response.json()) as GetChatPrivacyStateResponse).threadId;
}

// Evidence scope: real owner login → Today → general chat drawer → Conversations → New side chat →
// real chat API → the signed-in economy model. General drawer chat refuses API-key providers, so
// this proof runs on the real CLI login rather than the Meetings stand-in. Nothing is intercepted.
test("the installed P1 helper opens twice and gets a fresh reply after a clear through Conversations (#3274)", async ({
  page
}) => {
  test.setTimeout(420_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED, "real configured login is required").toBe(
    "1"
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  expect(model.tier).toBe("economy");
  await page.goto("/today");
  await expect(page.getByRole("button", { name: "Close chat" })).toHaveCount(0);

  const clears: Response[] = [];
  const onResponse = (response: Response) => {
    if (isClear(response)) clears.push(response);
  };
  page.on("response", onResponse);
  try {
    await openChatDrawer(page);
    expect(clears).toHaveLength(0);
    const firstThread = await drawerThreadId(page);
    expect(firstThread).toBeDefined();
    await page.getByRole("button", { name: "Close chat" }).click();
    await expect(page.getByRole("button", { name: "Close chat" })).toHaveCount(0);

    await openChatDrawer(page);
    expect(clears).toHaveLength(1);
    expect(clears[0]!.status()).toBe(204);
    expect(new URL(clears[0]!.url()).searchParams.get("surface")).toBe("drawer");
    await expect(page.locator(REPLIES).filter({ hasText: /\S/ })).toHaveCount(1);
    const secondThread = await drawerThreadId(page);
    expect(secondThread).toBeDefined();
    expect(secondThread).not.toBe(firstThread);

    const kept = await page.request.get(`/api/chat/threads/${firstThread}/messages?surface=drawer`);
    expect(kept.status()).toBe(200);
    const keptMessages = ((await kept.json()) as ListChatThreadMessagesResponse).messages;
    expect(keptMessages.filter((message) => message.role === "user").at(-1)?.body).toBe(
      P1_QUESTION
    );
    expect(
      keptMessages.some((message) => message.role === "assistant" && message.body.trim())
    ).toBe(true);
  } finally {
    page.off("response", onResponse);
  }
  console.log(
    `P1_HELPER_REAL_UAT real UI/API on the signed-in economy model (tier=${model.tier}); first open replied without a clear; second open cleared through Conversations (204, drawer), got one fresh nonempty reply in a new conversation, and the first conversation kept its question and answer`
  );
});
