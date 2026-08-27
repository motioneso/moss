import { expect, test, type APIResponse, type Locator, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1992: proves the daily archive job (packages/chat/src/jobs.ts handleArchiveDayJob) records a
// status when it can't write today's note, and that Settings (apps/web/src/settings/settings-ai-pane.tsx)
// shows it, through the real running app: turn archiving on, send a message so the archive-day
// job runs, disconnect the notes folder so the next run cannot write, send another message, and
// confirm both the API and the on-screen Settings pane show the paused message. Reconnecting and
// sending again must clear it. Follows the same signIn/openChat/send pattern as
// 1987-chat-archive-backfill.uat.spec.ts and the same settings navigation as
// 1974-chat-archive-settings.uat.spec.ts.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "1992-chat-archive-status"
} as const;

const NOTES_ROOT = `/data/vaults/${UAT_ADMIN_ID}`;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

async function readJson(response: APIResponse): Promise<unknown> {
  expect(response.ok(), `${response.url()} -> ${response.status()}`).toBeTruthy();
  return response.json();
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();
}

async function openChat(page: Page): Promise<Locator> {
  await page.locator(".topbar-actions button").click();
  const drawer = page.locator("aside.chatd");
  await expect(drawer).toBeVisible();
  return drawer;
}

async function sendMessage(page: Page, drawer: Locator, message: string): Promise<void> {
  const turnResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/chat/turn") &&
      response.request().method() === "POST",
    { timeout: 180_000 }
  );
  const composer = drawer.getByLabel("Message Moss");
  await composer.fill(message);
  await composer.press("Enter");
  const response = await turnResponse;
  if (response.status() !== 200) {
    const body = await response.text().catch(() => "<no body>");
    throw new Error(`turn failed: ${response.status()} ${body}`);
  }
}

async function gotoAssistantSettings(page: Page): Promise<void> {
  await page.goto(`${requireBaseURL()}/settings?section=assistant`);
}

test("Settings shows a paused message when the notes folder is disconnected, and clears it once archiving can write again (#1992)", async ({
  page
}) => {
  test.setTimeout(240_000);
  await signIn(page);

  await readJson(await page.request.put("/api/me/notes-source", { data: { path: NOTES_ROOT } }));
  await readJson(
    await page.request.put("/api/me/chat-archive", {
      data: { enabled: true, folder: "Moss/Chats" }
    })
  );

  // A healthy run first: folder is connected, so this send-and-archive round must leave the
  // status clear.
  let drawer = await openChat(page);
  await sendMessage(page, drawer, "UAT-1992 message while notes folder is connected");
  await page.waitForTimeout(8_000);
  let state = (await readJson(await page.request.get("/api/me/chat-archive"))) as {
    status: { state: string; reason: string } | null;
  };
  expect(state.status).toBeNull();
  await gotoAssistantSettings(page);
  await expect(page.getByText("Archiving is paused", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Archiving failed", { exact: false })).toHaveCount(0);

  // Disconnect the notes folder so the next archive-day run cannot write, then send another
  // message so the job runs again today. Navigating to Settings above unmounted the chat drawer,
  // so it has to be reopened before another message can be sent.
  await readJson(await page.request.put("/api/me/notes-source", { data: { path: null } }));
  await page.goto(requireBaseURL());
  drawer = await openChat(page);
  await sendMessage(page, drawer, "UAT-1992 message while notes folder is disconnected");
  await page.waitForTimeout(8_000);

  state = (await readJson(await page.request.get("/api/me/chat-archive"))) as {
    status: { state: string; reason: string } | null;
  };
  expect(state.status).toEqual({ state: "paused", reason: "No notes folder is connected." });

  // Settings hides the whole "Save chats to Notes" section while no notes folder is connected
  // (it shows a "connect a folder" prompt instead), so the paused message only becomes visible
  // once the folder is reconnected but before the next archive run has had a chance to clear it.
  await readJson(await page.request.put("/api/me/notes-source", { data: { path: NOTES_ROOT } }));
  await gotoAssistantSettings(page);
  await expect(page.getByText("Archiving is paused: No notes folder is connected.")).toBeVisible();

  // Sending again now that the folder is back must let the job succeed and clear the status,
  // both from the API and on screen.
  await page.goto(requireBaseURL());
  drawer = await openChat(page);
  await sendMessage(page, drawer, "UAT-1992 message after reconnecting the notes folder");
  await page.waitForTimeout(8_000);

  state = (await readJson(await page.request.get("/api/me/chat-archive"))) as {
    status: { state: string; reason: string } | null;
  };
  expect(state.status).toBeNull();
  await gotoAssistantSettings(page);
  await expect(page.getByText("Archiving is paused", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Archiving failed", { exact: false })).toHaveCount(0);

  // Leave the shared UAT admin account as this file found it.
  await readJson(
    await page.request.put("/api/me/chat-archive", {
      data: { enabled: false, folder: "Moss/Chats" }
    })
  );
});
