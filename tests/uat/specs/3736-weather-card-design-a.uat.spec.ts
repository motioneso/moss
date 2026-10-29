import { expect, test, type Page } from "@playwright/test";
import type { ChatMessageDto, VisualReplyV1, WeatherForecastRead } from "@moss/shared";
import { signInUatAdmin, bringUpRealChatModel } from "./real-chat-signin.js";
import { readWeatherForecastSnapshot } from "../../../packages/weather/src/forecast/contract.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

async function drawer(page: Page) {
  const chat = page.getByRole("dialog", { name: "Chat with Moss" });
  if (!(await chat.isVisible())) await page.getByRole("button", { name: "Chat with Moss" }).click();
  await expect(chat.getByLabel("Message Moss")).toBeVisible();
  return chat;
}

test("real evening forecast renders design A and survives reload (#3736)", async ({ page }) => {
  test.setTimeout(600_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signInUatAdmin(page);
  const model = await bringUpRealChatModel(page);
  await page.goto("/settings?section=profile");
  await page.getByLabel("Search for a weather location").fill("San Diego");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("San Diego, California, United States", { exact: true })).toBeVisible(
    { timeout: 20_000 }
  );
  await page.getByRole("button", { name: "Use this place" }).first().click();
  await expect(
    page.getByText("Weather location saved: San Diego, California, United States.")
  ).toBeVisible();
  const chat = await drawer(page);
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/chat/turn" && r.request().method() === "POST",
    { timeout: 180_000 }
  );
  const started = Date.now();
  await chat
    .getByLabel("Message Moss")
    .fill(
      "Will I need a jacket at my saved location this evening between 6 and 10 PM? Show the hourly forecast card."
    );
  await chat.getByLabel("Message Moss").press("Enter");
  const turn = await response;
  expect(turn.ok()).toBe(true);
  const saved: { assistantMessageId: string; reply: string; visualReply?: VisualReplyV1 } =
    await turn.json();
  expect(saved.reply.trim()).not.toBe("");
  expect(saved.visualReply?.blocks[0]?.kind).toBe("weather.forecast");
  const envelope = saved.visualReply!;
  const forecast = readWeatherForecastSnapshot(envelope.snapshots[0]);
  expect(forecast).not.toBeNull();
  if (!forecast) throw new Error("No valid saved weather snapshot");
  const actual = await page.request.get(
    "/api/weather/forecast?dayOffset=0&startHour=18&endHour=22"
  );
  expect(actual.ok()).toBe(true);
  const source: WeatherForecastRead = await actual.json();
  expect(source.status).toBe("forecast");
  if (source.status !== "forecast") throw new Error("Real interval source unavailable");
  expect(forecast).toEqual(source.forecast);
  expect(forecast.coverage).toBe("complete");
  expect(forecast.intervals).toHaveLength(4);
  const card = chat.locator(".weather-forecast").last();
  await expect(card.getByRole("heading", { name: forecast.place, exact: true })).toBeVisible();
  await expect(card.locator("li")).toHaveCount(4);
  expect(await card.locator("li > strong").allTextContents()).toEqual(
    forecast.intervals.map((i) => `${Math.round(i.temperature)}°`)
  );
  expect(await card.locator("li small").allTextContents()).toEqual([
    "6–7 PM",
    "7–8 PM",
    "8–9 PM",
    "9–10 PM"
  ]);
  await expect(card.locator(".weather-forecast__dot")).toHaveCount(4);
  await expect(card.locator(".weather-forecast__line")).toHaveCount(3);
  await expect(card.locator("li svg")).toHaveCount(4);
  await expect(card.locator("footer")).toHaveCount(1);
  await expect(card.locator("footer")).toContainText("Open-Meteo · Updated");
  expect(await card.innerText()).not.toContain(forecast.timeZone);
  expect(await card.innerText()).not.toContain(forecast.localDate);
  await expect(card.locator(".jds-card")).toHaveCount(0);
  console.log(
    `[weather-card-live] ${JSON.stringify({ model: model.providerModelId, tier: model.tier, elapsedMs: Date.now() - started, place: forecast.place, unit: forecast.unit, temperatures: forecast.intervals.map((i) => i.temperature), labels: await card.locator("li small").allTextContents(), dots: 4, segments: 3, sourceMatchesSavedSnapshot: true })}`
  );
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["forest", "sage"]) {
      for (const mode of ["light", "dark"]) {
        await page.evaluate(
          ({ theme, mode }) => {
            document.documentElement.dataset.theme = theme;
            document.documentElement.dataset.colorMode = mode;
          },
          { theme, mode }
        );
        const bounds = await card.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        const metrics = await card.evaluate((node) => ({
          overflow: node.scrollWidth > node.clientWidth,
          minFont: Math.min(
            ...[...node.querySelectorAll("h3,p,strong,small,dt,dd,footer")].map((e) =>
              parseFloat(getComputedStyle(e).fontSize)
            )
          )
        }));
        expect(metrics.overflow).toBe(false);
        expect(metrics.minFont).toBeGreaterThanOrEqual(11);
        console.log(`[weather-card-layout] ${JSON.stringify({ width, theme, mode, ...metrics })}`);
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const privacy = await (await page.request.get("/api/chat/privacy?surface=drawer")).json();
  await page.reload();
  const reopened = await drawer(page);
  await expect(
    reopened
      .locator(".weather-forecast")
      .last()
      .getByRole("heading", { name: forecast.place, exact: true })
  ).toBeVisible();
  const history: { messages: ChatMessageDto[] } = await (
    await page.request.get(`/api/chat/threads/${privacy.threadId}/messages?surface=drawer`)
  ).json();
  expect(
    history.messages.find((message) => message.id === saved.assistantMessageId)?.visualReply
  ).toEqual(envelope);
  expect(errors).toEqual([]);
  console.log(
    "[weather-card-reload] exact saved envelope retained; real Profile → chat → sourced design A → phone/themes → reload passed; no page errors"
  );
});
