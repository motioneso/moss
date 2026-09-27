import { expect, test, type Page } from "@playwright/test";

import {
  attachNotesFailureEvidence,
  captureCurrentThreadId,
  readSessionCookieHeader
} from "./notes-failure-evidence.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import {
  bringUpRealChatProvider,
  discoverCheapestChatModel,
  readUatJson,
  requireUatBaseURL,
  signInUatAdmin
} from "./real-chat-signin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED);
const POLL_DEADLINE_MS = 60_000;
const FACT = "kumquat focaccia";
const NOTES_ROOT = `/data/vaults/${UAT_ADMIN_ID}`;
const TURN_ANNOTATION_TYPE = "2737-notes-turn";
const CHAT_SURFACE = "drawer";

// This spec binds the chat capability directly (PUT /api/ai/services/chat/binding) rather than
// going through the account's chat-model-override, so it composes the shared provider bring-up
// and cheapest-model discovery instead of using bringUpRealChatModel wholesale.
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

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  const baseUrl = process.env.JARVIS_UAT_BASE_URL;
  const turnAnnotation = testInfo.annotations.find(
    (annotation) => annotation.type === TURN_ANNOTATION_TYPE
  )?.description;
  if (!projectName || !baseUrl || !turnAnnotation) return;
  try {
    const turn = JSON.parse(turnAnnotation) as {
      fullNotePath: string;
      turnStartIso: string;
      threadId: string | null;
    };
    await attachNotesFailureEvidence(testInfo, page, baseUrl, {
      projectName,
      fullNotePath: turn.fullNotePath,
      turnStartIso: turn.turnStartIso,
      chatSurface: CHAT_SURFACE,
      threadId: turn.threadId
    });
  } catch (error) {
    // #2737: best-effort only — never mask the spec's own (already-decided) failure.
    console.error(`[uat #2737] failure-evidence capture itself failed: ${String(error)}`);
  }
});

test("a later chat answers from notes without narrating retrieval (#1556)", async ({ page }) => {
  test.skip(!REAL_CHAT_CONFIGURED, "needs a real chat-capable provider — #1121");
  test.setTimeout(240_000);

  await signInUatAdmin(page);
  await readUatJson(await page.request.put("/api/me/notes-source", { data: { path: NOTES_ROOT } }));
  await ensureRealChat(page);

  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const composer = page.getByRole("textbox", { name: "Message Moss" });
  const path = `uat/notes-default-retrieval-${Date.now()}.md`;
  const syncNotBefore = Date.now();
  await composer.fill(
    `Use notes.create to create ${path} containing exactly: Launch snack decision: ${FACT}. ` +
      "Do not ask a follow-up question."
  );
  await composer.press("Enter");

  // #2737: record which thread this turn landed in right now, before anything about the turn's
  // outcome is known — the spec opens a second, unrelated thread later for the retrieval turn,
  // and picking "the newest thread" at failure time would silently read that later turn instead.
  const baseUrlForTurnCapture = requireUatBaseURL();
  const cookieHeaderForTurnCapture = await readSessionCookieHeader(page);
  const threadId = cookieHeaderForTurnCapture
    ? await captureCurrentThreadId(
        fetch,
        baseUrlForTurnCapture,
        cookieHeaderForTurnCapture,
        CHAT_SURFACE
      )
    : null;
  test.info().annotations.push({
    type: TURN_ANNOTATION_TYPE,
    description: JSON.stringify({
      fullNotePath: `${NOTES_ROOT}/${path}`,
      turnStartIso: new Date(syncNotBefore).toISOString(),
      threadId
    })
  });

  await expect(page.getByRole("status").filter({ hasText: "Executed: notes.create" })).toBeVisible({
    timeout: 60_000
  });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  await expect
    .poll(
      async () => {
        const body = (await readUatJson(await page.request.get("/api/me/notes-last-sync"))) as {
          lastSync: { at: string | null; ingested: number; errors: number } | null;
        };
        const completedAt = body.lastSync?.at ? Date.parse(body.lastSync.at) : 0;
        return (
          completedAt >= syncNotBefore && body.lastSync!.ingested > 0 && body.lastSync!.errors === 0
        );
      },
      { timeout: POLL_DEADLINE_MS, message: "created note was not indexed" }
    )
    .toBe(true);

  const cleared = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/chat/clear" &&
      response.status() === 204
  );
  await page.getByRole("button", { name: "New chat" }).click();
  await cleared;
  await composer.fill("What snack did we choose for the launch?");
  await composer.press("Enter");

  await expect(page.getByText(new RegExp(FACT, "i"))).toBeVisible({ timeout: 60_000 });
  const threadText = await page.getByRole("dialog", { name: "Chat with Moss" }).innerText();
  expect(threadText).not.toMatch(
    /searching (?:your )?notes|checking (?:your )?notes|let me (?:check|search)/i
  );
});
