import { expect, test, type Page } from "@playwright/test";
import { signInUatAdmin, bringUpRealChatModel } from "./real-chat-signin.js";
import type { VisualReplyV1 } from "@moss/shared";
import { hasUsefulSportsAnswer } from "../sports-answer.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;
const prompts = [
  "How did Liverpool do in their last match?",
  "What was Liverpool's latest result?",
  "Give me Liverpool's most recent completed match result.",
  "Who did Liverpool last play and what was the score?",
  "How did Liverpool's last completed game end?",
  "Catch me up on the latest available Liverpool result.",
  "What happened in Liverpool's most recent match?",
  "Tell me the score from Liverpool's last finished match.",
  "What is the newest completed Liverpool match you can find?",
  "How did Liverpool fare most recently?",
  "What was the result of Liverpool's latest completed fixture?",
  "Show me how Liverpool did in their last finished game.",
  "What score did Liverpool finish with in the latest match?",
  "Give me the latest available final score for Liverpool.",
  "Which teams played in Liverpool's latest result and how did it end?",
  "What's the most recent completed Liverpool score you have?",
  "How did Liverpool get on in their last completed fixture?",
  "I'd like to catch up on Liverpool's last result.",
  "Summarize Liverpool's latest available finished match.",
  "What happened when Liverpool last finished a match?"
];
async function drawer(page: Page) {
  const chat = page.getByRole("dialog", { name: "Chat with Moss" });
  if (!(await chat.isVisible())) await page.getByRole("button", { name: "Chat with Moss" }).click();
  await expect(chat.getByLabel("Message Moss")).toBeVisible();
  return chat;
}
async function turn(page: Page, prompt: string) {
  const chat = await drawer(page);
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/chat/turn" && r.request().method() === "POST",
    { timeout: 180000 }
  );
  await chat.getByLabel("Message Moss").fill(prompt);
  const start = Date.now();
  await chat.getByLabel("Message Moss").press("Enter");
  const saved = await response;
  expect(saved.ok()).toBe(true);
  return { saved: await saved.json(), elapsedMs: Date.now() - start };
}

test("ordinary Sports questions save real sourced results and retain user-data compositions (#3629)", async ({
  page
}) => {
  test.setTimeout(2400000);
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  // Real module/settings paths, then a synthetic actor's follow through the normal public API.
  await page.goto("/sports");
  await expect(page.getByRole("banner").getByText("Sports", { exact: true })).toBeVisible();
  await page.goto("/settings?section=modules&module=sports");
  await expect(page.getByText("Following", { exact: true }).first()).toBeVisible();
  const follow = await page.request.post("/api/sports/follows", {
    data: { competitionKey: "eng.1", teamKey: "liv" }
  });
  expect(follow.ok()).toBe(true);
  const source = await page.request.get("/api/sports/results/latest?teamName=Liverpool");
  expect(source.ok()).toBe(true);
  const read = await source.json();
  console.log(`[sports-source] ${JSON.stringify(read)}`);
  expect(read.status).toBe("result");
  const results: { index: number; visual: boolean; useful: boolean; elapsedMs: number }[] = [];
  let firstEnvelope: VisualReplyV1 | undefined;
  for (const [index, prompt] of prompts.entries()) {
    const { saved, elapsedMs } = await turn(page, prompt);
    const envelope: VisualReplyV1 | undefined = saved.visualReply;
    const visual = envelope?.blocks[0]?.kind === "sports.result";
    const useful = hasUsefulSportsAnswer(saved.reply, read.result);
    results.push({ index: index + 1, visual, useful, elapsedMs });
    console.log(
      `[sports-route] ${JSON.stringify({ ...results.at(-1), prompt, reply: saved.reply.slice(0, 1500), providerModel: model.providerModelId, replyBytes: Buffer.byteLength(saved.reply), visualBytes: Buffer.byteLength(JSON.stringify(envelope ?? null)) })}`
    );
    if (!visual) continue;
    expect(envelope!.snapshots[0]!.fields).toEqual(read.result);
    const chat = await drawer(page);
    const slot = chat.getByLabel("Visual reply").last();
    await expect(
      slot.getByRole("heading", { name: "Latest available result", exact: true })
    ).toBeVisible();
    await expect(slot.getByText(read.result.home.name, { exact: true })).toBeVisible();
    await expect(slot.getByText(read.result.away.name, { exact: true })).toBeVisible();
    const images = slot.locator("img");
    await expect(images).toHaveCount(2);
    await expect
      .poll(() =>
        images.evaluateAll((imgs) =>
          imgs.every(
            (img) =>
              (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0
          )
        )
      )
      .toBe(true);
    if (!firstEnvelope) {
      firstEnvelope = envelope;
      await page.setViewportSize({ width: 390, height: 844 });
      const bounds = await slot.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      await page.setViewportSize({ width: 1280, height: 900 });
      const before = await (await page.request.get("/api/chat/privacy?surface=drawer")).json();
      await page.reload();
      await drawer(page);
      const history = await (
        await page.request.get(`/api/chat/threads/${before.threadId}/messages?surface=drawer`)
      ).json();
      expect(
        history.messages.find((m: { id: string }) => m.id === saved.assistantMessageId).visualReply
      ).toEqual(envelope);
      await expect(
        (await drawer(page))
          .getByLabel("Visual reply")
          .last()
          .getByRole("heading", { name: "Latest available result" })
      ).toBeVisible();
      console.log(
        "[sports-lifecycle] exact saved snapshot, real crests, phone bounds and reload passed"
      );
    }
  }
  console.log(`[sports-gate] ${JSON.stringify({ providerModel: model.providerModelId, results })}`);
  // Report the entire fixed matrix before deciding the required first-attempt threshold.
  expect(results.filter((r) => r.visual).length).toBeGreaterThanOrEqual(19);
  expect(results.every((r) => r.useful)).toBe(true);
  const controls = [
    "Text only: give me Liverpool's latest result.",
    "No visual. Tell me Liverpool's last score in one sentence.",
    "Reply in plain text only: what is two plus two?",
    "Say hello in one short sentence."
  ];
  for (const prompt of controls) {
    const { saved } = await turn(page, prompt);
    expect(saved.visualReply).toBeUndefined();
    expect(saved.reply.trim()).not.toBe("");
  }
  const composed = await turn(
    page,
    'Arrange these sculpture workshop facts into two useful titled visual sections, keeping a short answer too.\n```json\n{"material":"Clay","hours":6,"ready":true}\n```'
  );
  expect(composed.saved.visualReply.blocks[0].kind).toBe("composition");
  console.log("[sports-controls] four prose controls and novel user-data composition passed");
});
