import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  bringUpRealChatProvider,
  discoverCheapestChatModel,
  readUatJson,
  signInUatAdmin
} from "./real-chat-signin.js";

// #2816: live proof that an expanded tool step in the chat drawer shows quote marks and
// ampersands as plain characters, not as the escaped codes the gateway uses for the model.
export const uatLevel = { level: "admin+data", without: [] } as const;

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED);
const POLL_DEADLINE_MS = 60_000;
const TURN_TIMEOUT_MS = 180_000;
// briefings.getRunStatus is an external-content tool, so its answer reaches the model inside the
// escaped safety envelope. An unknown run id still returns a JSON answer full of quote marks.
const ASK =
  "Call briefings.getRunStatus with runId 00000000-0000-4000-8000-000000000000 and tell me the state. Use your Moss briefing tools, not the shell.";

async function ensureRealChat(page: Page): Promise<void> {
  await bringUpRealChatProvider(page);
  const cheapest = await discoverCheapestChatModel(page, POLL_DEADLINE_MS);
  await readUatJson(
    await page.request.put("/api/ai/services/chat/binding", {
      data: { binding: { kind: "model", modelId: cheapest.id } }
    })
  );
  await expect
    .poll(
      async () => {
        const body = (await readUatJson(
          await page.request.get("/api/ai/capability-route/chat")
        )) as { route: { available: boolean } };
        return body.route.available;
      },
      { timeout: POLL_DEADLINE_MS, message: "configured chat route did not become available" }
    )
    .toBe(true);
}

async function ask(dialog: Locator, message: string): Promise<void> {
  const composer = dialog.getByRole("textbox", { name: "Message Moss" });
  await composer.fill(message);
  await composer.press("Enter");
  await expect(dialog.getByRole("button", { name: "Stop generating" })).toBeVisible({
    timeout: 30_000
  });
  await expect(dialog.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: TURN_TIMEOUT_MS
  });
}

test("an expanded tool step shows plain quote marks (#2816)", async ({ page }, testInfo) => {
  test.skip(!REAL_CHAT_CONFIGURED, "needs a real chat-capable provider");
  test.setTimeout(600_000);

  await signInUatAdmin(page);
  await ensureRealChat(page);
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const dialog = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(dialog).toBeVisible();

  await ask(dialog, ASK);

  // Open the folded steps and read only the tool result lines.
  const peek = dialog.locator("details.chatd-peek").first();
  await peek.locator("summary").click();
  const resultLines = await peek
    .locator(".chatd-peek__line")
    .filter({ has: page.locator(".chatd-peek__kind", { hasText: "Result" }) })
    .allTextContents();
  console.log(`[2816 live proof] result lines:\n${resultLines.join("\n---\n").slice(0, 1200)}`);
  await dialog.screenshot({ path: testInfo.outputPath("expanded-steps.png") });

  const statusLines = resultLines.filter((line) => line.includes("not_found"));
  expect(statusLines.length).toBeGreaterThan(0);
  const joined = statusLines.join("\n");
  expect(joined).toContain('"');
  expect(joined).not.toMatch(/&(amp|quot|lt|gt|#39);/);
});
