import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Chat turns here run on the harness's scripted chat model (fixture: chat-scripts/runtime-context.json).
// Its reply is fixed text, so the check below covers only what a turn sends: the turn body carries no
// page snapshot. Page-context pushes are not counted here. The debounced sync
// (apps/web/src/chat/use-page-context-sync.ts) also runs on focus changes and DOM changes. Clicking
// Send moves focus, and the sent message changes the DOM, so a push can follow a send. withoutNewsJsonBinding keeps the scripted provider the only
// assistant provider, so it becomes the default model (see 1533-chat-surface-live-path.uat.spec.ts).
//
// Two behaviours need a real model to judge, so they stay test.fixme (#1121): the screenshot refusal,
// and the News error being pulled from the map and explained. Their logic is proven at unit level by
// tests/unit/current-view-tool.test.ts and tests/unit/chat-runtime-persona.test.ts.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "runtime-context"
} as const;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

// Mirrors app-map-grounding.uat.spec.ts's signIn(): `solo-admin` returns before the onboarding
// chunk (tests/uat/seed/levels.ts:65-67), so the seeded owner still has first-run onboarding
// pending and login lands on the wizard, not the app shell. Skip it only when shown, so this stays
// correct if a future level change pre-completes onboarding, and idempotent across the shared,
// non-reset UAT DB.
async function signIn(page: Page) {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  // Scoped to the form: the auth-mode segmented control has its own "Sign in" tab button
  // with the same accessible name as the submit button (apps/web/src/auth/auth-screen.tsx).
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

// Role-scoped to "button" so this never matches the drawer's own `role="dialog"
// aria-label="Chat with ${assistantName}"` (apps/web/src/shell/app-shell.tsx) — a different
// element that happens to share the same accessible name. Label is the live settings-persona
// name, defaulting to "Moss" (packages/shared/src/persona-api.ts) — not the pre-rename "Jarvis".
async function openChat(page: Page) {
  await page.getByRole("button", { name: "Chat with Moss" }).click();
}

test("ordinary chat turn sends no page snapshot", async ({ page }) => {
  await signIn(page);

  let turnBody: unknown;
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    // apps/web/src/api/client.ts:835-840 sendChatTurn posts only `{ text }` — proves Task 5's
    // push-deletion holds: the client no longer bundles a page-context snapshot onto the turn.
    if (request.url().endsWith("/api/chat/turn")) turnBody = request.postDataJSON();
  });

  await openChat(page);
  await page.getByRole("textbox", { name: "Message Moss" }).fill("Say hello in three words.");
  await page.getByRole("button", { name: "Send" }).click();

  // The scripted model answers this exact prompt with fixed text.
  await expect(page.getByText("Hello there, friend.").first()).toBeVisible();

  expect(turnBody).toEqual({ text: "Say hello in three words.", surface: "drawer" });
});

test("assistant tools never expose a screenshot capability", async ({ page }) => {
  await signIn(page);

  // packages/ai/src/routes.ts:599-616 — cookie-authed, real manifest listing, no chat turn or
  // model needed. Proves Task 3's manifest change holds against the real running server, not just
  // a unit test's in-memory manifest.
  const body = await page.evaluate(async () => {
    const response = await fetch("/api/ai/assistant-tools");
    return response.json();
  });
  expect(JSON.stringify(body).toLowerCase()).not.toContain("screenshot");
});

// #1121: the refusal ("Take a screenshot..." answered by a reply that asks the user to paste the
// exact text instead) needs a real instruction-following model to write the reply. The scripted
// model returns fixed text, so it cannot show this. The persona instruction is proven at unit level
// by tests/unit/chat-runtime-persona.test.ts, and the tool's absence from the manifest is proven for
// real above.
test.fixme("chat refuses to take a screenshot and explains why instead (#1121)", async () => {});

// #1121: grounding the answer in the News error (chat.getCurrentView and app.getMapSlice) and citing
// the "JSON-capable economy model" remediation needs a real model to pick the tools and write the
// prose. The scripted model cannot do either. The News error's own rendering is proven by
// app-map-grounding.uat.spec.ts, and the tool logic by tests/unit/current-view-tool.test.ts and
// tests/unit/chat-runtime-persona.test.ts.
test.fixme("News screen error is pulled and resolved against the map (#1121)", async () => {});
