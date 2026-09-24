import { expect, test, type Page } from "@playwright/test";

import { createMockBriefingDefinition, createMockConnectorProviders, mockApi } from "./mock-api.js";

/**
 * #891 — Today's evening tomorrow panel.
 *
 * The "Chat with {assistant}" button must OPEN THE CHAT DRAWER on click, the same
 * way the topbar chat button does. The regression it guards: opening the drawer used
 * to live in the seed mutation's onSuccess, so a slow or failing
 * POST /api/chat/evening-interview (e.g. an instance with no chat model configured)
 * left the button doing nothing — the drawer never opened. The seeded interview turn
 * arrives separately over the global chat SSE stream.
 *
 * To render evening mode deterministically regardless of the test-run clock, the
 * evening briefing definition targets 00:00 UTC — already in the past for any wall
 * clock, so deriveTodayMode() returns "evening".
 */
async function seedEveningMode(page: Page) {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    briefingDefinitions: [
      createMockBriefingDefinition("briefing-evening", "Evening", {
        briefingType: "evening",
        cadence: "daily",
        enabled: true,
        scheduleMetadata: { targetTime: "00:00", timezone: "UTC" }
      })
    ]
  });
}

test("#891: evening Prep-for-tomorrow opens the chat drawer even when the seed interview fails", async ({
  page
}) => {
  await seedEveningMode(page);

  // Seed POST fails — mirrors an instance with no chat-capable model. The drawer must
  // still open (before #891 the failure was swallowed and nothing happened).
  let seedCalls = 0;
  await page.route("**/api/chat/evening-interview", (route) => {
    seedCalls += 1;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "No active chat-capable model is configured." })
    });
  });

  await page.goto("/today");

  const prepButton = page.locator("button.ev-tomorrow__chat");
  await expect(prepButton).toBeVisible();
  await prepButton.click();

  // The drawer opens on click, not gated behind the (failed) seed POST.
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();

  // The seed interview was still attempted.
  await expect.poll(() => seedCalls).toBe(1);
});

test("#891: evening Prep-for-tomorrow opens the drawer before the seed POST resolves", async ({
  page
}) => {
  await seedEveningMode(page);

  // Hold the seed POST open — the drawer must open immediately, without waiting for it.
  // Seed with a noop (not null) so the type stays `() => void`; root tsc narrows a
  // `(() => void) | null` assigned only inside the executor callback down to `never`.
  let releaseSeed: () => void = () => undefined;
  const seedHeld = new Promise<void>((resolve) => {
    releaseSeed = resolve;
  });
  await page.route("**/api/chat/evening-interview", async (route) => {
    await seedHeld;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reply: "ok", userMessageId: "u1", assistantMessageId: "a1" })
    });
  });

  await page.goto("/today");
  await page.locator("button.ev-tomorrow__chat").click();

  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible(); // open while the seed POST is still pending

  releaseSeed();
});
