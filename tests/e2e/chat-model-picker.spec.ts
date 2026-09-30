import { expect, test, type Page } from "@playwright/test";

import { createMockAiModel } from "./mock-ai-api.js";
import { createMockConnectorProviders, mockApi } from "./mock-api.js";
import type { AiConfiguredModelDto } from "@moss/shared";

/**
 * #2810 chat model picker: providers at the top level, drill in to pick, star favorites.
 *
 * The override and favorites endpoints are stateful route mocks, so a reload proves the picker
 * reads favorites back from the server rather than from component state.
 */

function anthropicModel(id: string): AiConfiguredModelDto {
  return createMockAiModel(id, {
    providerConfigId: "provider-anthropic",
    providerKind: "anthropic",
    providerDisplayName: "Anthropic",
    providerModelId: id,
    displayName: id
  });
}

function openAiModel(id: string): AiConfiguredModelDto {
  return createMockAiModel(id, {
    providerConfigId: "provider-openai",
    providerKind: "anthropic",
    providerDisplayName: "OpenAI",
    providerModelId: id,
    displayName: id
  });
}

const opus = anthropicModel("claude-opus");
const sonnet = anthropicModel("claude-sonnet");
const sol = openAiModel("gpt-sol");
const luna = openAiModel("gpt-luna");

async function mockPicker(page: Page) {
  const state = { overrideId: null as string | null, favoriteIds: [] as string[], switches: 0 };
  await mockApi(page, {
    authenticated: true,
    aiModels: [opus, sonnet, sol, luna],
    chatThreads: [],
    chatMessages: {},
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  const settings = () => {
    const selected = [opus, sonnet, sol, luna].find((m) => m.id === state.overrideId) ?? null;
    return {
      settings: {
        overrideEnabled: true,
        currentOverrideModelId: state.overrideId,
        effectiveOverrideModelId: selected?.id ?? null,
        defaultModel: opus,
        selectedModel: selected ?? opus,
        selectableOverrideModels: [opus, sonnet, sol, luna]
      }
    };
  };
  await page.route("**/api/ai/chat-model-override", async (route) => {
    if (route.request().method() === "PUT") {
      state.overrideId = (route.request().postDataJSON() as { modelId: string | null }).modelId;
    }
    await route.fulfill({ status: 200, json: settings() });
  });
  await page.route("**/api/ai/chat-model-favorites", async (route) => {
    if (route.request().method() === "PUT") {
      state.favoriteIds = (route.request().postDataJSON() as { modelIds: string[] }).modelIds;
    }
    await route.fulfill({ status: 200, json: { modelIds: state.favoriteIds } });
  });
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/switch"),
    async (route) => {
      state.switches += 1;
      await route.fulfill({ status: 200, json: { ok: true } });
    }
  );
  return state;
}

async function openPicker(page: Page) {
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await drawer.locator(".chatd-model__trigger").click();
  return drawer.locator(".chatd-model__menu");
}

test("top level lists providers; a provider drills in and back returns", async ({ page }) => {
  await mockPicker(page);
  await page.goto("/");
  const menu = await openPicker(page);

  await expect(menu.getByText("Star a model to pin it here.")).toBeVisible();
  await expect(menu.getByRole("button", { name: /^Anthropic, 2 models/ })).toBeVisible();
  await expect(menu.getByRole("button", { name: /^OpenAI, 2 models/ })).toBeVisible();
  await expect(menu.getByRole("button", { name: "gpt-sol", exact: true })).toHaveCount(0);

  await menu.getByRole("button", { name: /^OpenAI/ }).click();
  await expect(menu.getByRole("button", { name: "gpt-sol", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "gpt-luna", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: /^claude-sonnet/ })).toHaveCount(0);

  await menu.getByRole("button", { name: /Back to all providers/ }).click();
  await expect(menu.getByRole("button", { name: /^OpenAI, 2 models/ })).toBeFocused();
});

test("picking a model inside a provider selects it and marks it current", async ({ page }) => {
  const state = await mockPicker(page);
  await page.goto("/");
  let menu = await openPicker(page);

  await menu.getByRole("button", { name: /^Anthropic/ }).click();
  await menu.getByRole("button", { name: /^claude-sonnet/ }).click();
  await expect.poll(() => state.overrideId).toBe("claude-sonnet");
  await expect(menu).toHaveCount(0);

  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer.locator(".chatd-model__trigger")).toContainText("claude-sonnet");
  await drawer.locator(".chatd-model__trigger").click();
  menu = drawer.locator(".chatd-model__menu");
  await expect(
    menu.getByRole("button", { name: /^Anthropic, 2 models, current model claude-sonnet/ })
  ).toBeVisible();
  await menu.getByRole("button", { name: /^Anthropic/ }).click();
  await expect(menu.getByRole("button", { name: /^claude-sonnet/ })).toHaveAttribute(
    "aria-current",
    "true"
  );
});

test("starring puts a model under Favorites, survives a reload, and unstarring removes it", async ({
  page
}) => {
  const state = await mockPicker(page);
  await page.goto("/");
  let menu = await openPicker(page);

  await menu.getByRole("button", { name: /^OpenAI/ }).click();
  await menu.getByRole("button", { name: "Star gpt-luna" }).click();
  await expect(menu.getByRole("button", { name: "Unstar gpt-luna" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect.poll(() => state.favoriteIds).toEqual(["gpt-luna"]);

  await page.reload();
  menu = await openPicker(page);
  const favorites = menu.getByRole("group", { name: "Favorites" });
  await expect(favorites.getByRole("button", { name: /^gpt-luna/ })).toBeVisible();
  await expect(menu.getByText("Star a model to pin it here.")).toHaveCount(0);

  await favorites.getByRole("button", { name: "Unstar gpt-luna" }).click();
  await expect.poll(() => state.favoriteIds).toEqual([]);
  await expect(menu.getByRole("group", { name: "Favorites" })).toHaveCount(0);
  await expect(menu.getByText("Star a model to pin it here.")).toBeVisible();
});

test("a favorite is selectable straight from the top level", async ({ page }) => {
  const state = await mockPicker(page);
  state.favoriteIds = ["claude-sonnet"];
  await page.goto("/");
  const menu = await openPicker(page);

  await menu
    .getByRole("group", { name: "Favorites" })
    .getByRole("button", { name: /^claude-sonnet/ })
    .click();
  await expect.poll(() => state.overrideId).toBe("claude-sonnet");
});

test("the picker works from the keyboard", async ({ page }) => {
  const state = await mockPicker(page);
  // Switching provider asks for confirmation before starting a new chat.
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/");
  const menu = await openPicker(page);

  // Focus lands on the current row (instance default); Down moves to the first provider.
  await expect(menu.getByRole("button", { name: /Instance default/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("button", { name: /^Anthropic/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await expect(menu.getByRole("button", { name: "gpt-sol", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(menu.getByRole("button", { name: /^OpenAI/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("button", { name: "gpt-luna", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => state.overrideId).toBe("gpt-luna");

  await page
    .getByRole("dialog", { name: "Chat with Moss" })
    .locator(".chatd-model__trigger")
    .click();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});
