import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  UAT_ADMIN_EMAIL,
  UAT_ADMIN_ID,
  UAT_ADMIN_PASSWORD,
  UAT_SECOND_OWNER_ID
} from "../seed/admin.js";
import { UAT_SHARED_MAIN_MESSAGE, UAT_SHARED_MAIN_TITLE } from "../seed/chunks/shared-main.js";

export const uatLevel = {
  level: "multi-user",
  without: [],
  chatScript: "3192-shared-main"
} as const;

const OWN_MESSAGE = "UAT-3192 owner Main transcript marker";
const DRAFT = "UAT-3192 unsent Main draft";

interface ThreadRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly isMain: boolean;
  readonly title: string;
}

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

async function openConversations(drawer: Locator): Promise<Locator> {
  await drawer.getByRole("button", { name: "Open conversations" }).click();
  const conversations = drawer.getByLabel("Conversations", { exact: true });
  await expect(conversations).toBeVisible();
  return conversations;
}

async function listThreads(page: Page): Promise<readonly ThreadRow[]> {
  const response = await page.request.get(`${requireBaseURL()}/api/chat/threads?surface=drawer`);
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { threads: readonly ThreadRow[] }).threads;
}

async function privacyThreadId(page: Page): Promise<string | undefined> {
  const response = await page.request.get(`${requireBaseURL()}/api/chat/privacy?surface=drawer`);
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { threadId?: string }).threadId;
}

async function expectOwnMainActive(drawer: Locator, ownTitle: string): Promise<void> {
  const conversations = await openConversations(drawer);
  const mainRow = conversations.getByRole("button", { name: "Main chat", exact: true });
  await expect(mainRow).toHaveAttribute("aria-pressed", "true");
  await expect(mainRow).toContainText(ownTitle);
  await expect(mainRow).not.toContainText(UAT_SHARED_MAIN_TITLE);
  const sharedRow = conversations.getByRole("button", { name: UAT_SHARED_MAIN_TITLE, exact: true });
  await expect(sharedRow).toHaveAttribute("aria-pressed", "false");
  await conversations.getByRole("button", { name: "Close conversations" }).click();
  await expect(drawer.getByText(OWN_MESSAGE, { exact: true })).toBeVisible();
  await expect(drawer.getByText(UAT_SHARED_MAIN_MESSAGE, { exact: true })).toHaveCount(0);
}

test("a newer shared Main never replaces the owner's Main or its draft (#3192)", async ({
  page
}) => {
  test.setTimeout(300_000);
  await signIn(page);
  let drawer = await openChat(page);
  let own!: ThreadRow;
  let shared!: ThreadRow;

  await test.step("the owner's Main binds first and a granted foreign Main is listed first", async () => {
    const composer = drawer.getByLabel("Message Moss");
    await composer.fill(OWN_MESSAGE);
    await composer.press("Enter");
    await expect(drawer.getByText("UAT-3192 scripted reply.", { exact: true })).toBeVisible();

    const threads = await listThreads(page);
    own = threads.find((thread) => thread.isMain && thread.ownerUserId === UAT_ADMIN_ID)!;
    shared = threads.find((thread) => thread.ownerUserId === UAT_SECOND_OWNER_ID)!;
    expect(own).toBeDefined();
    expect(shared).toMatchObject({ isMain: true, title: UAT_SHARED_MAIN_TITLE });
    expect(threads[0]!.id).toBe(shared.id);
    await expect(privacyThreadId(page)).resolves.toBe(own.id);
  });

  // Reading a chat shared with you is out of scope (#3216); the server keeps transcripts owner-only.
  await test.step("Conversations marks only the owner's Main and the shared chat stays unreadable (#3216)", async () => {
    await expectOwnMainActive(drawer, own.title);
    const sharedMessages = await page.request.get(
      `${requireBaseURL()}/api/chat/threads/${shared.id}/messages?surface=drawer`
    );
    expect(sharedMessages.status()).toBe(404);
  });

  await test.step("the shared chat is listed but does not open, and Main and the draft stay unchanged", async () => {
    await drawer.getByLabel("Message Moss").fill(DRAFT);
    const conversations = await openConversations(drawer);
    await conversations.getByRole("button", { name: UAT_SHARED_MAIN_TITLE, exact: true }).click();
    await expect(drawer.getByLabel("Conversations", { exact: true })).toBeVisible();
    await expect(drawer.getByText(UAT_SHARED_MAIN_MESSAGE, { exact: true })).toHaveCount(0);
    await conversations.getByRole("button", { name: "Main chat", exact: true }).click();
    await expect(drawer.getByText(OWN_MESSAGE, { exact: true })).toBeVisible();
    await expect(drawer.getByLabel("Message Moss")).toHaveValue(DRAFT);
    await expect(privacyThreadId(page)).resolves.toBe(own.id);
  });

  await test.step("a reload returns to the same Main with the draft intact", async () => {
    await page.reload();
    drawer = await openChat(page);
    await expect(drawer.getByLabel("Message Moss")).toHaveValue(DRAFT);
    await expectOwnMainActive(drawer, own.title);
    await expect(drawer.getByLabel("Message Moss")).toHaveValue(DRAFT);
    await expect(privacyThreadId(page)).resolves.toBe(own.id);
    const threads = await listThreads(page);
    expect(
      threads.filter((thread) => thread.ownerUserId === UAT_ADMIN_ID && thread.isMain)
    ).toEqual([expect.objectContaining({ id: own.id })]);
  });
});
