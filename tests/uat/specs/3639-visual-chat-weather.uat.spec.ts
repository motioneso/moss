import { expect, test, type Page } from "@playwright/test";
import { signInUatAdmin, bringUpRealChatModel } from "./real-chat-signin.js";
import type { ChatMessageDto, VisualReplyV1, WeatherForecastRead } from "@moss/shared";
import { hasUsefulWeatherAnswer } from "../weather-answer.js";

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
  // Weather is a required built-in; its actual settings live in Profile, not optional Modules.
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
  // Both omitted and matching conversational place names retain the saved identity.
  const conversationResponse = await page.request.get(
    `/api/weather/forecast?dayOffset=0&startHour=18&endHour=22&place=${encodeURIComponent(source.forecast.place)}`
  );
  expect(conversationResponse.ok()).toBe(true);
  const conversationSource: WeatherForecastRead = await conversationResponse.json();
  expect(conversationSource.status).toBe("forecast");
  if (conversationSource.status !== "forecast") throw new Error("Qualified place unavailable");
  expect(conversationSource.forecast).toEqual(source.forecast);
  console.log(`[weather-conversation-source] ${JSON.stringify(conversationSource)}`);
  const results: {
    index: number;
    visual: boolean;
    useful: boolean;
    elapsedMs: number;
    replyBytes: number;
    visualBytes: number;
    promptBytes: number;
    assistantMessageId: string;
  }[] = [];
  let firstEnvelope: VisualReplyV1 | undefined;
  for (const [index, prompt] of prompts.entries()) {
    const { saved, elapsedMs } = await turn(page, prompt);
    const envelope: VisualReplyV1 | undefined = saved.visualReply;
    const visual = envelope?.blocks[0]?.kind === "weather.forecast";
    // A turn may make a fresh authorized read. Compare with the current cached source,
    // rather than assuming its retrieval timestamp must equal the pre-matrix baseline.
    const turnSourceResponse = await page.request.get(
      "/api/weather/forecast?dayOffset=0&startHour=18&endHour=22"
    );
    expect(turnSourceResponse.ok()).toBe(true);
    const turnSource: WeatherForecastRead = await turnSourceResponse.json();
    console.log(
      `[weather-turn-source] ${JSON.stringify({ index: index + 1, source: turnSource })}`
    );
    if (turnSource.status !== "forecast") throw new Error("Turn source unavailable");
    expect.soft(turnSource.forecast).toMatchObject({
      place: source.forecast.place,
      locationSource: "stored-preference",
      approximate: false,
      timeZone: source.forecast.timeZone,
      unit: source.forecast.unit,
      coverage: "complete",
      requestedStart: source.forecast.requestedStart,
      requestedEnd: source.forecast.requestedEnd
    });
    const useful = hasUsefulWeatherAnswer(saved.reply, turnSource.forecast);
    results.push({
      index: index + 1,
      visual,
      useful,
      elapsedMs,
      replyBytes: Buffer.byteLength(saved.reply),
      visualBytes: Buffer.byteLength(JSON.stringify(envelope ?? null)),
      promptBytes: Buffer.byteLength(prompt),
      assistantMessageId: saved.assistantMessageId
    });
    console.log(
      `[weather-route] ${JSON.stringify({ ...results.at(-1), prompt, reply: saved.reply.slice(0, 1500), providerModel: model.providerModelId })}`
    );
    if (!visual) continue;
    expect.soft(envelope!.snapshots[0]!.fields).toEqual(turnSource.forecast);
    const slot = (await drawer(page)).getByLabel("Visual reply").last();
    await expect(
      slot.getByRole("heading", { name: source.forecast.place, exact: true })
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
        chat.getByLabel("Visual reply").last().getByRole("heading", { name: source.forecast.place })
      ).toBeVisible();
      console.log(
        "[weather-lifecycle] exact saved snapshot, 390px/drawer, light/dark/forest/sage and reload passed"
      );
    }
  }
  console.log(
    `[weather-gate] ${JSON.stringify({ providerModel: model.providerModelId, results })}`
  );
  const privacy = await (await page.request.get("/api/chat/privacy?surface=drawer")).json();
  const history: { messages: ChatMessageDto[] } = await (
    await page.request.get(`/api/chat/threads/${privacy.threadId}/messages?surface=drawer`)
  ).json();
  console.log(
    `[weather-activity] ${JSON.stringify(
      results.map((result) => {
        const message = history.messages.find((item) => item.id === result.assistantMessageId);
        return {
          index: result.index,
          assistantMessageId: result.assistantMessageId,
          turnId: message?.turnId,
          activity: message?.activity
            .filter((event) => event.kind === "tool")
            .map(({ kind, toolName, outcome }) => ({ kind, toolName, outcome }))
        };
      })
    )}`
  );
  console.log(
    `[weather-usage] ${JSON.stringify(
      results.map((result) => ({
        index: result.index,
        usage:
          history.messages.find((message) => message.id === result.assistantMessageId)?.usage ??
          null
      }))
    )}`
  );
  expect.soft(results.filter((r) => r.visual).length).toBeGreaterThanOrEqual(19);
  expect.soft(results.every((r) => r.useful)).toBe(true);
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
  const follow = await page.request.post("/api/sports/follows", {
    data: { competitionKey: "eng.1", teamKey: "liv" }
  });
  expect(follow.ok()).toBe(true);
  const sportsSource = await (
    await page.request.get("/api/sports/results/latest?teamName=Liverpool")
  ).json();
  expect(sportsSource.status).toBe("result");
  const sports = await turn(page, "How did Liverpool do in their last match?");
  console.log(`[weather-sports-preservation] ${JSON.stringify(sports.saved)}`);
  expect(sports.saved.visualReply?.blocks[0]?.kind).toBe("sports.result");
  expect(sports.saved.visualReply.snapshots[0].fields).toEqual(sportsSource.result);
  console.log(
    "[weather-controls] four prose controls, novel user-data composition, unchanged saved location and sourced Sports preservation passed"
  );
});
