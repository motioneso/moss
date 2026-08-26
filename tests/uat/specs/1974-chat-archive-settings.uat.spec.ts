import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_ID, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1974 (settings screen half of chat archive, backend shipped in #1951/#1963): proves the two
// on-screen controls (apps/web/src/settings/settings-ai-pane.tsx, ChatArchive) drive the real
// GET/PUT /api/me/chat-archive route, that the empty state appears with no notes folder
// connected, and that a rejected folder shows the server's own plain-English error, not a raw
// crash or a silently-swallowed failure.
//
// Deliberately serial and stateful within this one file, mirroring
// moss-assistant-name.uat.spec.ts: the "no notes folder connected" case must run BEFORE any test
// connects one, since seedNotesChunk (tests/uat/seed/chunks/notes.ts) only writes vault files —
// it never sets the notes-source preference — so the admin genuinely starts disconnected at
// admin+data and stays that way until a test PUTs one, same as
// notes-default-retrieval.uat.spec.ts:97 and notes-path-recheck.uat.spec.ts:31.
export const uatLevel = { level: "admin+data", without: [] } as const;

const NOTES_ROOT = `/data/vaults/${UAT_ADMIN_ID}`;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

async function readJson(response: APIResponse): Promise<unknown> {
  expect(response.ok(), `${response.url()} -> ${response.status()}`).toBeTruthy();
  return response.json();
}

// Mirrors notes-default-retrieval.uat.spec.ts's signIn(): admin+data returns before the
// onboarding chunk, so the seeded owner still has first-run onboarding pending.
async function signIn(page: Page) {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

// Direct route with the section query param, the house pattern for jumping straight to a
// settings pane (moss-assistant-name.uat.spec.ts's gotoAssistantSettings()).
async function gotoAssistantSettings(page: Page) {
  await page.goto(`${requireBaseURL()}/settings?section=assistant`);
}

test.describe.serial("chat archive settings section drives the real backend (#1974)", () => {
  test("with no notes folder connected, the section shows the empty state and no controls", async ({
    page
  }) => {
    await signIn(page);
    await gotoAssistantSettings(page);

    await expect(page.getByText("No notes folder connected")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Save chats to Notes" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Transcript folder" })).toHaveCount(0);
  });

  test("connecting a notes folder reveals the switch off and the default folder", async ({
    page
  }) => {
    await signIn(page);
    await readJson(await page.request.put("/api/me/notes-source", { data: { path: NOTES_ROOT } }));
    await gotoAssistantSettings(page);

    const toggle = page.getByRole("checkbox", { name: "Save chats to Notes" });
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByRole("textbox", { name: "Transcript folder" })).toHaveValue(
      "Moss/Chats"
    );
  });

  test("turning the switch on persists across a reload", async ({ page }) => {
    await signIn(page);
    await gotoAssistantSettings(page);

    const toggle = page.getByRole("checkbox", { name: "Save chats to Notes" });
    await toggle.click();
    await expect(page.getByText("Chat archiving enabled")).toBeVisible();

    await gotoAssistantSettings(page);
    await expect(page.getByRole("checkbox", { name: "Save chats to Notes" })).toBeChecked();
  });

  test("a nested folder path saves without error", async ({ page }) => {
    await signIn(page);
    await gotoAssistantSettings(page);

    const folderInput = page.getByRole("textbox", { name: "Transcript folder" });
    await folderInput.fill("2 Area/Moss/Chats");
    await folderInput.blur();

    await expect(
      page.getByText("Chat archive folder cannot", { exact: false })
    ).toHaveCount(0);
    await gotoAssistantSettings(page);
    await expect(folderInput).toHaveValue("2 Area/Moss/Chats");
  });

  test("a folder starting with a slash is refused with the server's own message", async ({
    page
  }) => {
    await signIn(page);
    await gotoAssistantSettings(page);

    const folderInput = page.getByRole("textbox", { name: "Transcript folder" });
    await folderInput.fill("/etc/passwd");
    await folderInput.blur();

    await expect(
      page.getByText("Chat archive folder cannot start with a leading slash")
    ).toBeVisible();

    // The rejected value must not silently become the saved one.
    await gotoAssistantSettings(page);
    await expect(page.getByRole("textbox", { name: "Transcript folder" })).toHaveValue(
      "2 Area/Moss/Chats"
    );
  });

  test.afterAll(async ({ browser }) => {
    // Leave the shared UAT admin account as this file found it: archiving off, default folder.
    // The vault's notes-source connection itself is left in place, matching
    // notes-default-retrieval.uat.spec.ts's precedent of not tearing that down.
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page);
    await readJson(
      await page.request.put("/api/me/chat-archive", {
        data: { enabled: false, folder: "Moss/Chats" }
      })
    );
    await context.close();
  });
});
