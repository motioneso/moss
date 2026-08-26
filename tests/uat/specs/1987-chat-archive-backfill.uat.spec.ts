import { expect, test, type APIResponse, type Locator, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1987: proves the archive-day fix (packages/chat/src/jobs.ts's handleArchiveDayJob no longer
// filters out messages sent before archiving was turned on) through the real running app: a
// message sent BEFORE archiving is enabled and one sent AFTER both end up in today's archived
// note. Reads the note back through the same channel the AI itself uses to edit notes (the
// notes.edit MCP tool, driven here via the scripted chat provider's `calls` mechanism) since this
// app has no notes-content-viewer page or REST route (checked: only notes-sync-routes.ts exists,
// and it only exposes source-path/sync-status, never file content). notes.edit reads and writes
// the file directly by its known path (folder + today's date), so this does not depend on the
// separate notes search-index/sync pipeline — that pipeline has its own unrelated permission
// problem in this test environment (confirmed: no other UAT spec has ever exercised it
// successfully either) and is out of scope for this issue.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "1987-archive-backfill"
} as const;

const NOTES_ROOT = `/data/vaults/${UAT_ADMIN_ID}`;
const BEFORE_MESSAGE = "UAT-1987-before this message was sent while archiving was off";
const AFTER_MESSAGE = "UAT-1987-after this message was sent while archiving was on";
const VERIFY_MESSAGE = "UAT-1987-verify please check today's note";
const BEFORE_REPLY = "Scripted UAT-1987 before reply.";
const AFTER_REPLY = "Scripted UAT-1987 after reply.";
const VERIFY_REPLY = "Scripted UAT-1987 verify reply.";

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

async function sendAndAwaitReply(
  page: Page,
  drawer: Locator,
  message: string,
  expectedReply: string
): Promise<void> {
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
  expect(response.status()).toBe(200);
  await expect(drawer.getByText(expectedReply, { exact: true })).toBeVisible({ timeout: 180_000 });
}

test("today's archived note includes a message sent before archiving was turned on and one sent after (#1987)", async ({
  page
}) => {
  test.setTimeout(240_000);
  await signIn(page);

  // Connect the notes folder (same pattern as 1974's settings spec) so the archive job has
  // somewhere to write, then confirm archiving starts off — the default the spec relies on.
  await readJson(await page.request.put("/api/me/notes-source", { data: { path: NOTES_ROOT } }));
  const beforeState = (await readJson(
    await page.request.get("/api/me/chat-archive")
  )) as { enabled: boolean };
  expect(beforeState.enabled).toBe(false);

  const drawer = await openChat(page);

  // Message 1: sent while archiving is off.
  await sendAndAwaitReply(page, drawer, BEFORE_MESSAGE, BEFORE_REPLY);

  // Turn archiving on.
  await readJson(
    await page.request.put("/api/me/chat-archive", {
      data: { enabled: true, folder: "Moss/Chats" }
    })
  );

  // Message 2: sent while archiving is on. Storing this turn enqueues the archive-day job for
  // today (packages/chat/src/live/persistence.ts), which re-renders the whole day's note —
  // this is the exact path the fix changed.
  await sendAndAwaitReply(page, drawer, AFTER_MESSAGE, AFTER_REPLY);

  // The archive-day job (packages/chat/src/jobs.ts) that rewrites today's note runs on a
  // background queue with a 2-second poll interval (packages/jobs/src/pg-boss.ts), so give it
  // room to pick up and finish the job triggered by message 2 before checking the file.
  await page.waitForTimeout(8_000);

  // Message 3: the AI edits both the "before" and "after" tokens directly in today's archive
  // file (notes.edit) — each edit only succeeds if its text appears in the file exactly once
  // (packages/notes/src/write-tools.ts notesEditExecute). If either message had been dropped
  // from the note, this turn's tool call would fail and the turn itself would never complete,
  // failing this test.
  await sendAndAwaitReply(page, drawer, VERIFY_MESSAGE, VERIFY_REPLY);

  // Leave the shared UAT admin account as this file found it.
  await readJson(
    await page.request.put("/api/me/chat-archive", {
      data: { enabled: false, folder: "Moss/Chats" }
    })
  );
});
