import { expect, test, type Page } from "@playwright/test";
import { signInUatAdmin, bringUpRealChatModel } from "./real-chat-signin.js";
import type { VisualReplyV1, WeatherForecastRead } from "@moss/shared";

export const uatLevel = { level: "solo-admin", without: [] } as const;
const prompts = [
  "Will I need a jacket tonight?",
  "What should I wear outdoors this evening?",
  "How cold will it get between 6 and 10 this evening?",
  "Help me prepare for an evening walk from 6 to 10 tonight.",
  "Do I need a warm layer for tonight's walk?",
  "What's the evening weather like at my saved location?",
  "Should I bring a jacket and umbrella this evening?",
  "Tell me about the temperature and rain from 6 to 10 tonight.",
  "What weather should I expect during tonight's evening outing?",
  "How windy and cool will my evening walk be?",
  "Can you help me dress for being outside tonight?",
  "Give me the local outlook for 6 to 10 this evening.",
  "Will this evening be comfortable without a jacket?",
  "What's the rain and temperature outlook tonight?",
  "What should I know before going out this evening?",
  "Would you pack a layer for a walk tonight?",
  "How does the weather change over this evening?",
  "Is a jacket sensible for tonight's outdoor plans?",
  "Catch me up on this evening's local forecast.",
  "Help me plan what to wear for this evening's weather."
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
    { timeout: 180_000 }
  );
  await chat.getByLabel("Message Moss").fill(prompt);
  const start = Date.now();
  await chat.getByLabel("Message Moss").press("Enter");
  const saved = await response;
  expect(saved.ok()).toBe(true);
  return { saved: await saved.json(), elapsedMs: Date.now() - start };
}

test("ordinary evening questions use actual place-local intervals and immutable cards (#3639)", async ({
  page
}) => {
  test.setTimeout(2_400_000);
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  await page.goto("/settings?section=profile");
  const search = page.getByLabel("Search for a weather location");
  await expect(search).toBeEnabled();
  await search.fill("San Diego");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("San Diego, California, United States", { exact: true })).toBeVisible(
    { timeout: 20_000 }
  );
  await page.getByRole("button", { name: "Use this place" }).first().click();
  await expect(
    page.getByText("Weather location saved: San Diego, California, United States.")
  ).toBeVisible();
  await expect(page.getByRole("group", { name: "Unit", exact: true })).toBeVisible();
  await page.goto("/settings?section=modules");
  await expect(page.getByText("Weather", { exact: true }).first()).toBeVisible();
  const savedLocation = await (await page.request.get("/api/me/weather-location")).json();
  const response = await page.request.get(
    "/api/weather/forecast?dayOffset=0&startHour=18&endHour=22"
  );
  expect(response.ok()).toBe(true);
  const source: WeatherForecastRead = await response.json();
  console.log(`[weather-source] ${JSON.stringify(source)}`);
  expect(source.status).toBe("forecast");
  if (source.status !== "forecast") throw new Error("Real interval forecast unavailable");
  expect(source.forecast.timeZone).toBe("America/Los_Angeles");
  expect(source.forecast.coverage).toBe("complete");
  expect(source.forecast.intervals).toHaveLength(4);
  const results: {
    index: number;
    visual: boolean;
    useful: boolean;
    elapsedMs: number;
    replyBytes: number;
    visualBytes: number;
  }[] = [];
  let firstEnvelope: VisualReplyV1 | undefined;
  for (const [index, prompt] of prompts.entries()) {
    const { saved, elapsedMs } = await turn(page, prompt);
    const envelope: VisualReplyV1 | undefined = saved.visualReply;
    const visual = envelope?.blocks[0]?.kind === "weather.forecast";
    const useful =
      saved.reply.trim().length >= 30 &&
      /jacket|layer|rain|wind|cool|warm|temperature|°[FC]|\d+\s*(?:degrees|°)/i.test(saved.reply) &&
      !/unable to (?:get|fetch|access)|couldn.t (?:get|fetch)|no (?:weather|forecast) data/i.test(
        saved.reply
      );
    results.push({
      index: index + 1,
      visual,
      useful,
      elapsedMs,
      replyBytes: Buffer.byteLength(saved.reply),
      visualBytes: Buffer.byteLength(JSON.stringify(envelope ?? null))
    });
    console.log(
      `[weather-route] ${JSON.stringify({ ...results.at(-1), prompt, reply: saved.reply.slice(0, 1500), providerModel: model.providerModelId })}`
    );
    if (!visual) continue;
    expect(envelope!.snapshots[0]!.fields).toEqual(source.forecast);
    const slot = (await drawer(page)).getByLabel("Visual reply").last();
    await expect(
      slot.getByRole("heading", { name: "Local weather forecast", exact: true })
    ).toBeVisible();
    await expect(slot.getByText(source.forecast.place, { exact: true })).toBeVisible();
    await expect(slot.getByLabel("Hourly forecast").locator("li")).toHaveCount(4);
    await expect(slot.getByText(/Open-Meteo/)).toBeVisible();
    if (!firstEnvelope) {
      firstEnvelope = envelope;
      for (const theme of ["forest", "sage"]) {
        await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
        for (const mode of ["light", "dark"]) {
          await page.evaluate(
            (value) => (document.documentElement.dataset.colorMode = value),
            mode
          );
          await page.setViewportSize({ width: 390, height: 844 });
          const bounds = await slot.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
          expect(await slot.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
        }
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      const before = await (await page.request.get("/api/chat/privacy?surface=drawer")).json();
      await page.reload();
      const chat = await drawer(page);
      const history = await (
        await page.request.get(`/api/chat/threads/${before.threadId}/messages?surface=drawer`)
      ).json();
      expect(
        history.messages.find((m: { id: string }) => m.id === saved.assistantMessageId).visualReply
      ).toEqual(envelope);
      await expect(
        chat
          .getByLabel("Visual reply")
          .last()
          .getByRole("heading", { name: "Local weather forecast" })
      ).toBeVisible();
      console.log(
        "[weather-lifecycle] exact saved snapshot, 390px/drawer, light/dark/forest/sage and reload passed"
      );
    }
  }
  console.log(
    `[weather-gate] ${JSON.stringify({ providerModel: model.providerModelId, results })}`
  );
  expect(results.filter((r) => r.visual).length).toBeGreaterThanOrEqual(19);
  expect(results.every((r) => r.useful)).toBe(true);
  for (const prompt of [
    "Text only: will I need a jacket tonight?",
    "No visual. Tell me the evening weather in one sentence.",
    "Reply in plain text only: what is two plus two?",
    "Say hello in one short sentence."
  ]) {
    const { saved } = await turn(page, prompt);
    expect(saved.visualReply).toBeUndefined();
    expect(saved.reply.trim()).not.toBe("");
  }
  const composed = await turn(
    page,
    'Arrange these pottery workshop facts into two useful titled visual sections, keeping a short answer too.\n```json\n{"material":"Clay","hours":6,"ready":true}\n```'
  );
  expect(composed.saved.visualReply.blocks[0].kind).toBe("composition");
  expect(await (await page.request.get("/api/me/weather-location")).json()).toEqual(savedLocation);
  console.log(
    "[weather-controls] four prose controls, novel user-data composition and unchanged saved location passed"
  );
});
