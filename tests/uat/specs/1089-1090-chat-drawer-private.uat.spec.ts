import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

/** Opens the "More chat options" menu, picks one item, and leaves the menu closed (it closes itself). */
async function pickChatMenuItem(drawer: Locator, name: string) {
  await drawer.getByRole("button", { name: "More chat options" }).click();
  await drawer.getByRole("menuitemcheckbox", { name }).click();
}

/** Opens the menu, checks the private item's state, and closes the menu again. */
async function expectPrivateChecked(drawer: Locator, checked: boolean) {
  await drawer.getByRole("button", { name: "More chat options" }).click();
  await expect(
    drawer.getByRole("menuitemcheckbox", { name: /^(Start|Leave) private chat$/ })
  ).toHaveAttribute("aria-checked", String(checked));
  await drawer.page().keyboard.press("Escape");
  await expect(drawer.getByRole("menu")).toHaveCount(0);
}

export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "1105-drawer-private"
} as const;

const FIRST_MESSAGE = "UAT-1105 first persisted message";
const CONTINUATION_MESSAGE = "UAT-1105 continue in resumed thread";
const ACTIVATION_MESSAGE = "UAT-1105 send during activation";
const AFTER_ACTIVATION_MESSAGE = "UAT-1105 after activation";
const SCRIPTED_REPLY = "Scripted UAT-1105 reply.";
const clearPath = (url: URL): boolean => url.pathname.endsWith("/api/chat/clear");
const turnPath = (url: URL): boolean => url.pathname.endsWith("/api/chat/turn");

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
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();
}

async function openChat(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function sendAndAwaitReply(page: Page, drawer: Locator, message: string): Promise<void> {
  const turnResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/chat/turn") &&
      response.request().method() === "POST"
  );
  const composer = drawer.getByLabel("Message Moss");
  await composer.fill(message);
  await composer.press("Enter");
  const response = await turnResponse;
  expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toMatchObject({ text: message });
  await expect(drawer.getByText(SCRIPTED_REPLY, { exact: true }).last()).toBeVisible();
  await expect(response.json()).resolves.toMatchObject({ reply: SCRIPTED_REPLY });
}

/** Reads the server's current privacy state and selected conversation for the drawer. */
async function drawerPrivacy(page: Page): Promise<{ incognito: boolean; threadId?: string }> {
  const response = await page.request.get(`${requireBaseURL()}/api/chat/privacy?surface=drawer`);
  expect(response.status()).toBe(200);
  return (await response.json()) as { incognito: boolean; threadId?: string };
}

/** Reads the user message bodies persisted in one drawer conversation. */
async function persistedUserMessages(page: Page, threadId: string): Promise<string[]> {
  const response = await page.request.get(
    `${requireBaseURL()}/api/chat/threads/${threadId}/messages?surface=drawer`
  );
  expect(response.status()).toBe(200);
  const { messages } = (await response.json()) as {
    messages: { role: string; body: string }[];
  };
  return messages.filter((message) => message.role === "user").map((message) => message.body);
}

test.describe.configure({ mode: "serial" });

test("resuming Main from Conversations while private clears the stale privateMode flag (#1090)", async ({
  page
}) => {
  await signIn(page);
  const drawer = await openChat(page);

  await sendAndAwaitReply(page, drawer, FIRST_MESSAGE);
  const persistent = await drawerPrivacy(page);
  expect(persistent.incognito).toBe(false);
  const mainThreadId = persistent.threadId;
  if (!mainThreadId) throw new Error("the drawer has no persisted Main conversation");
  await pickChatMenuItem(drawer, "Start private chat");
  await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toBeVisible();
  await expectPrivateChecked(drawer, true);
  expect(await drawerPrivacy(page)).toMatchObject({ incognito: true });
  await drawer.getByRole("button", { name: "Open conversations" }).click();
  const conversations = drawer.getByLabel("Conversations", { exact: true });
  await expect(conversations).toBeVisible();
  const mainRow = conversations.getByRole("button", { name: "Main chat", exact: true });
  await expect(mainRow).toBeVisible();
  await mainRow.click();

  await expect(drawer.getByText(FIRST_MESSAGE)).toBeVisible();
  await expectPrivateChecked(drawer, false);
  await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toHaveCount(0);
  await sendAndAwaitReply(page, drawer, CONTINUATION_MESSAGE);
  await expect(drawer.getByText(CONTINUATION_MESSAGE, { exact: true })).toBeVisible();
  await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toHaveCount(0);

  // The resumed conversation is the same persisted Main, and the continuation lands in it.
  expect(await drawerPrivacy(page)).toEqual({ incognito: false, threadId: mainThreadId });
  const persisted = await persistedUserMessages(page, mainThreadId);
  expect(persisted).toContain(FIRST_MESSAGE);
  expect(persisted).toContain(CONTINUATION_MESSAGE);
});

test("private activation blocks send until the server confirms, then allows it (#1089)", async ({
  page
}) => {
  let clearRoute: Route | undefined;
  let releaseClear: (() => void) | undefined;
  const clearHeld = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  const turnRequestMethods: string[] = [];

  await page.route(clearPath, async (route) => {
    clearRoute = route;
    await clearHeld;
    await route.continue();
  });
  await page.route(turnPath, async (route) => {
    turnRequestMethods.push(route.request().method());
    await route.continue();
  });

  try {
    await signIn(page);
    const drawer = await openChat(page);
    await pickChatMenuItem(drawer, "Start private chat");

    await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toHaveCount(0);
    await drawer.getByLabel("Message Moss").fill(ACTIVATION_MESSAGE);
    await drawer.getByLabel("Message Moss").press("Enter");
    await page.waitForTimeout(2_000);
    expect(turnRequestMethods).toEqual([]);

    expect(clearRoute).toBeDefined();
    releaseClear?.();
    await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toBeVisible();
    await expectPrivateChecked(drawer, true);
    await sendAndAwaitReply(page, drawer, AFTER_ACTIVATION_MESSAGE);
    await expect.poll(() => turnRequestMethods).toEqual(["POST"]);
  } finally {
    await page.unroute(clearPath);
    await page.unroute(turnPath);
  }
});
