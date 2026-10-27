import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import type { SendChatTurnResponse } from "@moss/shared";

import { buildUatComposeArgs } from "../compose-args.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";
import { installPromotedMeetingCodex } from "./meeting-promoted-codex.js";
import { bringUpRealChatModel, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = {
  level: "admin+data",
  without: ["news", "sports", "tasks", "calendar", "finance"]
} as const;
test.use({ trace: "off", screenshot: "off", video: "off" });
const deadline = 180000;
const root = `/data/vaults/${UAT_ADMIN_ID}`;
const path = "uat/coordinated-authoring.md";

/** Read-only evidence from the file the real Notes service published, never a proof fixture. */
function content(): string | null {
  const project = requireUatProjectName();
  const owner = execFileSync(
    "docker",
    buildUatComposeArgs(project, ["exec", "-T", "jarv1s", "stat", "-c", "%u:%g", "/data/vaults"]),
    { encoding: "utf8" }
  ).trim();
  const result = execFileSync(
    "docker",
    buildUatComposeArgs(project, [
      "exec",
      "-T",
      "--user",
      owner,
      "jarv1s",
      "node",
      "-e",
      "const fs=require('node:fs');try{process.stdout.write(JSON.stringify(fs.readFileSync(process.argv[1],'utf8')))}catch(e){if(e.code!=='ENOENT')throw e;process.stdout.write('null')}",
      `${root}/${path}`
    ]),
    { encoding: "utf8" }
  );
  return JSON.parse(result) as string | null;
}

async function turn(
  page: Page,
  drawer: Locator,
  text: string,
  expected: string | null,
  approvalRequired = false
) {
  const before = content();
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === "/api/chat/turn" &&
      candidate.request().method() === "POST" &&
      candidate.request().postDataJSON()?.text === text,
    { timeout: deadline }
  );
  let settled = false;
  void response.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await drawer.getByRole("textbox", { name: /^Message/ }).fill(text);
  await drawer.getByRole("button", { name: "Send", exact: true }).click();
  const card = drawer
    .getByRole("region", { name: "Action request", exact: true })
    .filter({ has: page.getByRole("button", { name: "Approve", exact: true }) });
  await expect
    .poll(async () => settled || (await card.isVisible()), { timeout: deadline })
    .toBe(true);
  if (approvalRequired) await expect(card).toBeVisible();
  if (await card.isVisible()) {
    await expect(card.getByText(posix.basename(path), { exact: true })).toBeVisible();
    await expect(card.getByRole("definition").filter({ hasText: /^uat$/ })).toBeVisible();
    expect(content()).toBe(before);
    await card.getByRole("button", { name: "Approve", exact: true }).click();
  }
  const result = await response;
  expect(result.status()).toBe(200);
  const saved = (await result.json()) as SendChatTurnResponse;
  expect(saved.assistantMessageId).toMatch(/^[0-9a-f-]{36}$/);
  await expect.poll(content, { timeout: 30000 }).toBe(expected);
  const metadata = JSON.parse(
    execUatSql(
      requireUatProjectName(),
      `SELECT model_metadata->'executed' FROM app.chat_messages WHERE id='${saved.assistantMessageId}'::uuid AND owner_user_id='${UAT_ADMIN_ID}'::uuid`
    ).trim()
  ) as { provider: string; model: string };
  expect(metadata.provider).toBeTruthy();
  expect(metadata.model).toBeTruthy();
}

test("linked-folder authoring through real Settings and chat preserves current bytes (#3777)", async ({
  page
}) => {
  test.setTimeout(900000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  await signInUatAdmin(page);
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup", exact: true }).click();
  await page.getByRole("button", { name: "AI providers", exact: true }).click();
  const model = await bringUpRealChatModel(page);
  installPromotedMeetingCodex(requireUatProjectName());
  await page.getByRole("button", { name: "Personal", exact: true }).click();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: /^(Browse…|Change folder)$/ }).click();
  await page.locator(".vroot").filter({ hasText: root }).click();
  await expect(page.locator(".vselect__path")).toHaveText(root);
  await page.getByRole("button", { name: "Use this folder", exact: true }).click();
  await expect(page.locator(".vault__path")).toHaveText(root);
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  const drawer = page.locator("aside.chatd");
  await expect(drawer).toBeVisible();
  expect(content()).toBeNull();
  await turn(
    page,
    drawer,
    `Create a Markdown note at exactly ${path} containing exactly APPLE BANANA. Use the Notes create action, keep overwrite false, and submit any required approval.`,
    "APPLE BANANA"
  );
  await turn(
    page,
    drawer,
    `Edit note ${path}: replace exactly APPLE with ORANGE using the Notes edit action. Preserve BANANA and submit any required approval.`,
    "ORANGE BANANA"
  );
  await turn(
    page,
    drawer,
    `Edit note ${path}: replace exactly BANANA with GRAPE using the Notes edit action. Preserve ORANGE and submit any required approval.`,
    "ORANGE GRAPE"
  );
  await turn(
    page,
    drawer,
    `Overwrite the existing note ${path} using the Notes create action with overwrite true and content exactly FINAL CONTENT. Submit the overwrite approval.`,
    "FINAL CONTENT",
    true
  );
  await turn(
    page,
    drawer,
    `Delete the note ${path} using the Notes delete action. Submit the required permanent deletion approval.`,
    null,
    true
  );
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Account & preferences", exact: true }).click();
  await page.getByRole("button", { name: "Prepare export", exact: true }).click();
  const download = page.getByRole("link", { name: "Download", exact: true });
  await expect(download).toBeVisible({ timeout: 120000 });
  const received = page.waitForEvent("download");
  await download.click();
  const archiveDownload = await received;
  expect(await archiveDownload.failure()).toBeNull();
  const archivePath = await archiveDownload.path();
  expect(archivePath).toBeTruthy();
  const archive = JSON.parse(await readFile(archivePath!, "utf8")) as {
    format: string;
    userId: string;
    sections: { notes: { actors: unknown[]; sources: unknown[] } };
  };
  expect(archive.format).toBe("jarvis-archive/v1");
  expect(archive.userId).toBe(UAT_ADMIN_ID);
  // This foundation does not yet register contributions through ordinary authoring.
  // Populated lifecycle rows are exercised through both assembled exporters in integration.
  expect(archive.sections.notes).toEqual({ actors: [], sources: [] });
  console.log(
    `MANAGED_VAULT_REAL_UAT model=${model.id} settingsFolder=true create=true edits=true overwrite=true delete=true actualFileBytes=true settingsArchiveDownload=true notesLifecycleSection=true screenshots=off`
  );
});
