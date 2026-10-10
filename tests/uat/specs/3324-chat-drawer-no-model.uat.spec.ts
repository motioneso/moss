// tests/uat/specs/3324-chat-drawer-no-model.uat.spec.ts
//
// #3324 live-path proof: once a chat model exists, reopening the chat drawer must not show the
// "Connect a provider" prompt, not even for one frame. The drawer's capability lookup caches the
// last answer. A cached "no model" answer used to render the prompt until the recheck returned.
//
// Runs on the harness's own disposable stack with real network. Nothing is intercepted or rewritten.
// The chat model is added through the same AI API the Settings screens call, while the page stays
// loaded. No chat script is seeded, so the stack starts with no chat model at all.
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// withoutNewsJsonBinding keeps the news module from binding an assistant provider, which would
// otherwise make chat available from the start.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true
} as const;

const CONNECT_PROMPT = ".chatd-empty--connect, .chatd-connect-cta";
const SCREENSHOT_DIR = "test-results/3324-chat-drawer-no-model";

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

// Mirrors moss-assistant-name.uat.spec.ts: skip first-run onboarding only when it is shown.
async function signIn(page: Page) {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const skipAnyway = page.getByRole("button", { name: "Skip anyway" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await expect(skipAnyway.or(userMenu).first()).toBeVisible();
    if (await skipAnyway.isVisible()) await skipAnyway.click();
  }
  await expect(userMenu).toBeVisible();
}

// A CLI provider needs no credential. The model row is what the drawer's capability lookup reads.
async function addChatModel(page: Page): Promise<void> {
  const baseURL = requireBaseURL();
  const providerResponse = await page.request.post(`${baseURL}/api/ai/providers`, {
    data: {
      providerKind: "anthropic",
      displayName: "UAT Chat Provider 3324",
      authMethod: "cli",
      acpAgentId: "claude-acp"
    }
  });
  expect(providerResponse.status()).toBe(201);
  const { provider } = (await providerResponse.json()) as { provider: { id: string } };

  const modelResponse = await page.request.post(`${baseURL}/api/ai/models`, {
    data: {
      providerConfigId: provider.id,
      providerModelId: "uat-chat-model-3324",
      displayName: "UAT Chat Model 3324",
      capabilities: ["chat"]
    }
  });
  expect(modelResponse.status()).toBe(201);
}

// Records every connect prompt the page shows from now on. Each mutation batch is checked two
// ways: the nodes it inserted, which catches a prompt added and removed in one render, and the
// prompts on screen right now, which catches a prompt revealed without an insert.
async function watchForConnectPrompt(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const shown: string[] = [];
    Object.assign(window, { __connectPromptShown: shown });
    const record = (element: Element) => {
      shown.push(element.textContent?.trim() ?? "");
    };
    new MutationObserver((records) => {
      for (const mutation of records) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (!(node instanceof Element)) continue;
          if (node.matches(selector)) record(node);
          node.querySelectorAll(selector).forEach(record);
        }
      }
      document.querySelectorAll(selector).forEach((element) => {
        if (element.getClientRects().length > 0) record(element);
      });
    }).observe(document.body, { childList: true, subtree: true, attributes: true });
  }, CONNECT_PROMPT);
}

async function connectPromptShown(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as Window & { __connectPromptShown?: string[] }).__connectPromptShown ?? []
  );
}

test("reopening the drawer after a chat model is added never shows the connect prompt", async ({
  page
}) => {
  await signIn(page);
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const openButton = page.getByRole("button", { name: "Chat with Moss" });
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  const composer = drawer.getByRole("textbox", { name: "Message Moss" });

  // No chat model yet, so the drawer shows the connect prompt.
  await openButton.click();
  await expect(drawer.locator(CONNECT_PROMPT).first()).toBeVisible();
  await drawer.screenshot({ path: `${SCREENSHOT_DIR}/1-no-model-connect-prompt.png` });
  await drawer.getByRole("button", { name: "Close chat", exact: true }).click();
  await expect(drawer).toBeHidden();

  // Add the model while the page stays loaded, so the drawer's cached "no model" answer remains.
  await addChatModel(page);

  // Reopen with the watcher already running. The prompt must never show.
  await watchForConnectPrompt(page);
  await openButton.click();
  await expect(composer).toBeVisible();
  await expect(drawer.locator(CONNECT_PROMPT)).toHaveCount(0);
  expect(await connectPromptShown(page), "connect prompt shown during reopen").toEqual([]);
  await drawer.screenshot({ path: `${SCREENSHOT_DIR}/2-model-added-message-box.png` });
});
