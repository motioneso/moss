import { expect, type Locator, type Page, type Response } from "@playwright/test";
import type { GetChatPrivacyStateResponse, ListChatThreadMessagesResponse } from "@moss/shared";

import { readUatJson } from "./real-chat-signin.js";

const PERSIST_DEADLINE_MS = 30_000;

export async function drawerThreadId(page: Page): Promise<string | undefined> {
  const body = (await readUatJson(
    await page.request.get("/api/chat/privacy?surface=drawer")
  )) as GetChatPrivacyStateResponse;
  return body.threadId;
}

function isDrawerCall(response: Response, method: string, pathname: string): boolean {
  const url = new URL(response.url());
  return (
    response.request().method() === method &&
    url.pathname === pathname &&
    url.searchParams.get("surface") === "drawer"
  );
}

/**
 * Starts a fresh conversation through Conversations > New side chat and returns its id.
 * Resolves only after the clear is acknowledged, no message from the previous conversation
 * is left on screen, and the drawer reports a different conversation.
 */
export async function startNewSideChat(page: Page, chatDialog: Locator): Promise<string> {
  const before = await drawerThreadId(page);
  expect(before, "the previous conversation has an id").toBeDefined();

  await chatDialog.getByRole("button", { name: "Open conversations" }).click();
  const cleared = page.waitForResponse((response) =>
    isDrawerCall(response, "POST", "/api/chat/clear")
  );
  await chatDialog.getByRole("button", { name: "New side chat", exact: true }).click();
  expect((await cleared).status()).toBe(204);

  await expect(chatDialog.locator(".chatd-msg")).toHaveCount(0);
  const after = await drawerThreadId(page);
  expect(after, "the new side chat has an id").toBeDefined();
  expect(after).not.toBe(before);
  await expect(chatDialog.getByRole("textbox", { name: /^Message/ })).toBeEnabled();
  return after!;
}

async function userBodies(page: Page, threadId: string): Promise<string[]> {
  const body = (await readUatJson(
    await page.request.get(`/api/chat/threads/${threadId}/messages?surface=drawer`)
  )) as ListChatThreadMessagesResponse;
  return body.messages.filter((message) => message.role === "user").map((message) => message.body);
}

/** The thread's only stored user turn is `question`. */
export async function expectOnlyUserTurn(
  page: Page,
  threadId: string,
  question: string
): Promise<void> {
  await expect
    .poll(() => userBodies(page, threadId), { timeout: PERSIST_DEADLINE_MS })
    .toEqual([question]);
}

/** A user turn in the thread mentions `text`. */
export async function expectThreadCarries(
  page: Page,
  threadId: string,
  text: string
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await userBodies(page, threadId)).some((body) =>
          body.toLowerCase().includes(text.toLowerCase())
        ),
      { timeout: PERSIST_DEADLINE_MS }
    )
    .toBe(true);
}
