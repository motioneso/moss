import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Task 7's early live proof. The normal UAT run stays credential-free; Prover enables this
// explicitly on a running dev instance and records the bounded log line beside the PR evidence.
export const uatLevel = { level: "solo-admin", without: [] } as const;

const ACP_CHAT_PROOF_ENABLED = process.env.JARVIS_UAT_ACP_CHAT_PROOF === "1";
const ACP_SESSION_OPEN_LINE = process.env.JARVIS_UAT_ACP_SESSION_OPEN_LINE;
const ACP_LOG_PATH = process.env.JARVIS_UAT_ACP_LOG_PATH;

function baseUrl(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(baseUrl());
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

async function shot(page: Page, name: string): Promise<void> {
  const path = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
}

// A raw list, not just the first entry: another conversation active at the same time
// could otherwise supply both the assumed-first thread and the first fresh log line.
async function currentThreadIds(page: Page): Promise<ReadonlySet<string>> {
  const response = await page.request.get(`${baseUrl()}/api/chat/threads?surface=drawer`);
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { threads?: readonly { id?: unknown }[] };
  return new Set(
    (body.threads ?? []).map((thread) => thread.id).filter((id) => typeof id === "string")
  );
}

test("ACP chat answers, queues the next send, and refuses shell tools (#2424)", async ({
  page
}) => {
  test.skip(!ACP_CHAT_PROOF_ENABLED, "Prover enables this live proof explicitly");
  test.setTimeout(180_000);
  await signIn(page);
  if (!ACP_SESSION_OPEN_LINE || !ACP_LOG_PATH) {
    throw new Error("JARVIS_UAT_ACP_SESSION_OPEN_LINE and JARVIS_UAT_ACP_LOG_PATH are required");
  }
  const logBeforeOpen = await readFile(ACP_LOG_PATH, "utf8");
  const threadIdsBeforeOpen = await currentThreadIds(page);

  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  const assistantReplies = page.locator(".chatd-msg:not(.chatd-msg--me) .chatd-bubble");
  const repliesBefore = await assistantReplies.count();

  await composer.fill("Hello, please introduce yourself in one sentence.");
  await composer.press("Enter");
  await expect(assistantReplies).toHaveCount(repliesBefore + 1, { timeout: 120_000 });
  await expect(assistantReplies.nth(repliesBefore)).not.toHaveText("");
  await expect(assistantReplies.nth(repliesBefore)).not.toHaveText(
    "Hello, please introduce yourself in one sentence."
  );
  await shot(page, "01-first-answer");
  const log = await readFile(ACP_LOG_PATH, "utf8");
  expect(log.startsWith(logBeforeOpen)).toBeTruthy();
  const freshLog = log.slice(logBeforeOpen.length);

  // The conversation this run actually exercised: the one thread id that appeared
  // after opening chat but was not there before. Not threads[0] — another active
  // conversation could hold that slot instead of the one this test opened.
  const threadIdsAfterOpen = await currentThreadIds(page);
  const newThreadIds = [...threadIdsAfterOpen].filter((id) => !threadIdsBeforeOpen.has(id));
  expect(newThreadIds).toHaveLength(1);
  const currentConversationId = newThreadIds[0] as string;

  const sessionOpenLines = freshLog
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line.startsWith(`[acp-chat] session opened conversation=${currentConversationId} `)
    );
  expect(sessionOpenLines).toHaveLength(1);
  const sessionOpenLine = sessionOpenLines[0];
  const expectedSessionOpenLine = ACP_SESSION_OPEN_LINE.replace(
    "<conversation-id>",
    currentConversationId
  );
  expect(sessionOpenLine).toBe(expectedSessionOpenLine);
  expect(sessionOpenLine).toMatch(
    new RegExp(
      `^\\[acp-chat\\] session opened conversation=${currentConversationId} provider=anthropic$`
    )
  );

  await composer.fill("Count from one to twenty, one number per line, slowly.");
  await composer.press("Enter");
  await composer.fill("And then say done.");
  await composer.press("Enter");
  await expect(page.locator(".chatd-next__text")).toContainText("Next:", {
    timeout: 30_000
  });
  await expect(page.locator(".chatd-next__text")).toContainText("And then say done.");
  await shot(page, "02-queued");
  await expect(assistantReplies).toHaveCount(repliesBefore + 3, { timeout: 120_000 });
  await expect(assistantReplies.nth(repliesBefore + 1)).toContainText(/1|one/i);
  await expect(assistantReplies.nth(repliesBefore + 1)).toContainText(/20|twenty/i);
  await expect(assistantReplies.nth(repliesBefore + 2)).toContainText(/done/i);

  await expect(composer).toBeVisible();
  await composer.fill('Run the command "whoami" in a shell and tell me the output.');
  await composer.press("Enter");
  await expect(assistantReplies.last()).toContainText(/cannot run shell|shell commands|refused/i, {
    timeout: 120_000
  });
  await shot(page, "03-shell-refused");
  await expect(page.locator('[role="region"][aria-label="Action request"]')).toHaveCount(0);
  await expect(assistantReplies.last()).toContainText(/cannot run shell|shell commands|refused/i);
  await shot(page, "04-shell-settled");
});
