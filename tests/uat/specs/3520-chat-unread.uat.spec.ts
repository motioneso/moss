import { expect, test, type Locator, type Page } from "@playwright/test";
import { bringUpRealChatModel, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

const chatButton = (page: Page) =>
  page.getByRole("button", { name: "Chat with Moss", exact: true });
const chatDrawer = (page: Page) =>
  page.getByRole("dialog", { name: "Chat with Moss", exact: true });

async function open(page: Page) {
  await chatButton(page).click();
  const drawer = chatDrawer(page);
  await expect(drawer).toBeVisible();
  return drawer;
}
async function send(page: Page, drawer: Locator, text: string) {
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/chat/turn",
    { timeout: 120_000 }
  );
  await drawer.getByLabel("Message Moss").fill(text);
  await expect(drawer.getByRole("button", { name: "Send", exact: true })).toBeEnabled({
    timeout: 120_000
  });
  await expect(drawer.getByLabel("Message Moss")).toHaveValue(text);
  await drawer.getByRole("button", { name: "Send", exact: true }).click();
  expect((await response).ok()).toBe(true);
}
async function unread(page: Page) {
  const response = await page.request.get("/api/chat/unread");
  expect(response.ok()).toBe(true);
  return (await response.json()) as { unreadCount: number; unreadByThread: Record<string, number> };
}

test("real reminders badge closed chat, survive reload, and clear only after visible reading", async ({
  page
}) => {
  test.setTimeout(600_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  await bringUpRealChatModel(page);
  await page.goto("/today");
  const ordinary = await open(page);
  await ordinary.getByLabel("Message Moss").fill("Reply with the words ordinary unread proof.");
  await expect(ordinary.getByRole("button", { name: "Send", exact: true })).toBeEnabled({
    timeout: 120_000
  });
  const completed = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/chat/turn",
    { timeout: 120_000 }
  );
  const dispatched = page.waitForRequest(
    (r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/chat/turn",
    { timeout: 30_000 }
  );
  await ordinary.getByRole("button", { name: "Send", exact: true }).click();
  await dispatched;
  console.log("[3520] ordinary message dispatched through Send; closing drawer before completion");
  await ordinary.getByRole("button", { name: "Close chat", exact: true }).click();
  expect((await completed).ok()).toBe(true);
  await expect(chatButton(page).locator(".jds-badge")).toHaveText("1", { timeout: 20_000 });
  const completedReply = await open(page);
  await expect(
    completedReply.getByText("ordinary unread proof.", { exact: false }).last()
  ).toBeVisible();
  await expect.poll(async () => (await unread(page)).unreadCount).toBe(0);
  await completedReply.getByRole("button", { name: "Close chat", exact: true }).click();
  console.log("[3520] ordinary reply completed while closed -> badge 1 -> visible read -> count 0");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const drawer = await open(page);
    await send(page, drawer, `Remind me in 15 seconds to unread badge proof ${width}`);
    await expect.poll(async () => (await unread(page)).unreadCount, { timeout: 10_000 }).toBe(0);
    await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
    await expect(chatButton(page).locator(".jds-badge")).toHaveText("1", { timeout: 45_000 });
    await expect(chatButton(page)).toHaveAccessibleDescription("1 unread message");
    await page.reload();
    await expect(chatButton(page).locator(".jds-badge")).toHaveText("1", { timeout: 20_000 });
    const reopened = await open(page);
    await expect(
      reopened.getByText(`Reminder: unread badge proof ${width}`, { exact: true })
    ).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await unread(page)).unreadCount).toBe(0);
    await reopened.getByRole("button", { name: "Close chat", exact: true }).click();
    await expect(chatButton(page).locator(".jds-badge")).toHaveCount(0);
    console.log(
      `[3520] ${width}px: real reminder -> badge 1 -> reload retains 1 -> visible message -> count 0`
    );
  }

  const main = await open(page);
  await main.getByRole("button", { name: "Open conversations", exact: true }).click();
  await main.getByRole("button", { name: "New side chat", exact: true }).click();
  await send(page, main, "Remind me in 15 seconds to side unread proof, send it to this chat");
  await expect.poll(async () => (await unread(page)).unreadCount).toBe(0);
  await main.getByRole("button", { name: "Open conversations", exact: true }).click();
  await main.getByRole("button", { name: "Main chat", exact: true }).click();
  await main.getByRole("button", { name: "Close chat", exact: true }).click();
  await expect(chatButton(page).locator(".jds-badge")).toHaveText("1", { timeout: 45_000 });
  const reopenedMain = await open(page);
  await expect(reopenedMain.getByText("Reminder: side unread proof", { exact: true })).toHaveCount(
    0
  );
  expect((await unread(page)).unreadCount).toBe(1);
  await reopenedMain.getByRole("button", { name: "Open conversations", exact: true }).click();
  const side = reopenedMain
    .getByRole("navigation", { name: "Side conversations" })
    .getByRole("button");
  await expect(side.locator(".jds-badge")).toHaveText("1");
  await side.click();
  await expect(reopenedMain.getByText("Reminder: side unread proof", { exact: true })).toBeVisible({
    timeout: 20_000
  });
  await expect.poll(async () => (await unread(page)).unreadCount).toBe(0);
  console.log(
    "[3520] reading Main preserved side-chat unread count; picker opened the side message and cleared it"
  );
  await send(page, reopenedMain, "Remind me in 15 seconds to main unread proof");
  await expect.poll(async () => (await unread(page)).unreadCount).toBe(0);
  await reopenedMain.getByRole("button", { name: "Close chat", exact: true }).click();
  await expect(chatButton(page).locator(".jds-badge")).toHaveText("1", { timeout: 45_000 });
  const reopenedSide = await open(page);
  await expect(reopenedSide.getByText("Reminder: main unread proof", { exact: true })).toHaveCount(
    0
  );
  expect((await unread(page)).unreadCount).toBe(1);
  await reopenedSide.getByRole("button", { name: "Close chat", exact: true }).click();
  const otherClient = await page.context().newPage();
  try {
    await otherClient.goto("/today");
    const otherDrawer = await open(otherClient);
    await otherDrawer.getByRole("button", { name: "Open conversations", exact: true }).click();
    const mainRow = otherDrawer.getByRole("button", { name: "Main chat", exact: true });
    await expect(mainRow.locator(".jds-badge")).toHaveText("1");
    await expect(mainRow).toHaveAccessibleDescription("1 unread message");
    await mainRow.click();
    await expect(
      otherDrawer.getByText("Reminder: main unread proof", { exact: true })
    ).toBeVisible();
    await expect.poll(async () => (await unread(page)).unreadCount).toBe(0);
    await expect(chatButton(page).locator(".jds-badge")).toHaveCount(0, { timeout: 10_000 });
    console.log(
      "[3520] reading side preserved Main unread; reading Main in another client cleared both clients"
    );
  } finally {
    await otherClient.close();
  }
});
