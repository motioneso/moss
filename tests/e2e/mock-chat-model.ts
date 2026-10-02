import type { Page } from "@playwright/test";

import { mockApi as mockBaseApi } from "./mock-api.js";

type MockApiOptions = Parameters<typeof mockBaseApi>[1];

/** The usual mock surface, plus an available chat model so the message box is usable (#2919). */
export async function mockApi(page: Page, options: MockApiOptions) {
  await mockBaseApi(page, options);
  await page.route(/\/api\/ai\/capability-route\/chat$/, (route) =>
    route.fulfill({
      status: 200,
      json: {
        route: { capability: "chat", available: true, reason: "matched-active-model", model: null }
      }
    })
  );
}
