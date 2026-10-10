// Live-Path Gate for #3027 - Moss answers an email question in normal time, and the API keeps
// answering other requests while it embeds memory queries. Runs against a REAL dev instance: real
// API, real database, real mail account and model. Nothing is mocked or intercepted.
//
// Run with:
//   LIVE_BASE_URL=http://127.0.0.1:<web-port> LIVE_API_URL=http://127.0.0.1:<api-port> \
//     LIVE_OWNER_EMAIL=... LIVE_OWNER_PASSWORD=... \
//     npx playwright test --config playwright.live.config.ts pool-hang-3027
import { expect, test, type Locator, type Page } from "@playwright/test";

const OWNER_PASSWORD = process.env.LIVE_OWNER_PASSWORD;
const API_URL = process.env.LIVE_API_URL;
if (!OWNER_PASSWORD || !API_URL) {
  throw new Error("Set LIVE_OWNER_PASSWORD and LIVE_API_URL for the development instance.");
}
const OWNER = { email: process.env.LIVE_OWNER_EMAIL ?? "ben@ben.com", password: OWNER_PASSWORD };
const REPLIES = ".chatd-msg:not(.chatd-msg--me) .chatd-bubble";
// Reply source labels share the step line class, so they are excluded from the step check.
const ACTIVITY = ".chatd-peek__line:not(.chatd-freshness__item)";

// About 2,800 characters, so each recall embeds a document-sized query.
const LONG_QUERY = Array.from(
  { length: 60 },
  (_, index) => `meeting notes about the garden project item ${index}`
).join(" ");

async function signInThroughUi(page: Page) {
  await page.goto("/");
  await page.getByLabel(/email/i).fill(OWNER.email);
  await page.getByLabel(/password/i).fill(OWNER.password);
  await page
    .locator("form")
    .getByRole("button", { name: /sign in/i })
    .click();
  await expect(page.getByRole("navigation").first()).toBeVisible();
}

// The drawer reopens its last conversation, so a fresh chat comes from Conversations.
// Sending waits for the drawer clear and for the old replies and steps to leave, so the
// activity read after the turn belongs to this turn only.
async function startSideChat(page: Page, drawer: Locator): Promise<void> {
  const cleared = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === "/api/chat/clear" &&
      url.searchParams.get("surface") === "drawer"
    );
  });
  await drawer.getByRole("button", { name: "Open conversations" }).click();
  await drawer.getByRole("button", { name: "New side chat", exact: true }).click();
  expect((await cleared).status()).toBe(204);
  await expect(drawer.locator(REPLIES)).toHaveCount(0);
  await expect(drawer.locator(ACTIVITY)).toHaveCount(0);
}

test("an email question finishes in normal time while the API embeds and stays responsive", async ({
  page
}) => {
  test.setTimeout(300_000);
  await signInThroughUi(page);

  let busy = true;
  const testStartedAt = Date.now();
  const health: { status: number; ms: number; at: number }[] = [];
  const healthProbe = (async () => {
    while (busy) {
      const startedAt = Date.now();
      const status = await fetch(`${API_URL}/health`).then(
        (response) => response.status,
        () => 0
      );
      health.push({ status, ms: Date.now() - startedAt, at: startedAt - testStartedAt });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  const recalls: number[] = [];
  const embedding = (async () => {
    for (let index = 0; busy; index += 1) {
      const response = await page.request.get(
        `/api/memory/graph/recall?q=${encodeURIComponent(`${LONG_QUERY} ${index}`)}`
      );
      recalls.push(response.status());
    }
  })();

  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await startSideChat(page, drawer);
  const composer = drawer.getByLabel("Message Moss");
  await composer.fill(
    "List the five most recent emails in my inbox with sender and subject. Use the email listing tool."
  );
  const turnResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/chat/turn") && response.request().method() === "POST",
    { timeout: 240_000 }
  );
  const sentAt = Date.now();
  await composer.press("Enter");
  const turn = await turnResponse;
  const turnMs = Date.now() - sentAt;
  const turnBody = (await turn.json()) as { reply?: string };
  await expect(drawer.getByRole("button", { name: "Stop generating" })).toHaveCount(0);
  // The steps sit inside a collapsed details element, so read their text content.
  const activity = await drawer.locator(ACTIVITY).allTextContents();

  busy = false;
  await Promise.all([healthProbe, embedding]);
  const latencies = health.map((sample) => sample.ms).sort((a, b) => a - b);
  console.log(
    `[3027] turn ${turn.status()} in ${turnMs} ms; reply ${String(turnBody.reply ?? "").length} chars`
  );
  if (!turnBody.reply) console.log(`[3027] turn body: ${JSON.stringify(turnBody).slice(0, 300)}`);
  console.log(`[3027] activity: ${activity.join(" | ").slice(0, 400)}`);
  const slowest = [...health].sort((a, b) => b.ms - a.ms).slice(0, 3);
  console.log(
    `[3027] test start ${testStartedAt}; turn sent at ${sentAt - testStartedAt} ms; slowest probes ` +
      slowest.map((sample) => `${sample.ms} ms at ${sample.at} ms`).join(", ")
  );
  console.log(
    `[3027] recalls ${recalls.length} (${[...new Set(recalls)].join(",")}); health ${latencies.length}` +
      ` probes, p50 ${latencies[Math.floor((latencies.length - 1) / 2)]} ms,` +
      ` max ${latencies[latencies.length - 1]} ms`
  );

  expect(turn.status()).toBe(200);
  expect(String(turnBody.reply ?? "").length).toBeGreaterThan(0);
  expect(activity.some((line) => /email/i.test(line))).toBe(true);
  expect(turnMs).toBeLessThan(120_000);
  expect(recalls.length).toBeGreaterThan(0);
  expect(recalls.every((status) => status === 200)).toBe(true);
  expect(health.length).toBeGreaterThan(0);
  expect(health.every((sample) => sample.status === 200)).toBe(true);
  expect(latencies[latencies.length - 1]).toBeLessThan(500);
});
