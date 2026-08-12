import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// SCOPE NOTE (#1109 / #1121, see docs/superpowers/handoffs/2026-07-17-1109-runtime-context-relay-7.md):
// the plan's literal spec (docs/superpowers/plans/2026-07-16-1109-runtime-context-plan.md, Task 7)
// asserts real chat replies ("hello" back, a screenshot-refusal message, a News-error remediation
// pulled from chat.getCurrentView + app.getMapSlice). The UAT harness has no chat-capable AI
// provider at any seed level — confirmed by two sibling specs' own scope notes
// (app-map-grounding.uat.spec.ts, 1089-1090-chat-drawer-private.uat.spec.ts): the only seeded
// provider is a fake one bound solely to module.news, so no seed level can drive a real chat turn
// to a model reply. That gap is tracked in #1121 ("UAT harness: deterministic scriptable chat
// engine for real-LLM e2e"). This file proves everything that IS deterministically observable
// without a real model reply — the turn-body shape (Task 5), the tool manifest (Task 3/6) — and
// `test.fixme`s the real-LLM halves, citing #1121 and the unit coverage that already proves the
// underlying logic (tests/unit/current-view-tool.test.ts, tests/unit/chat-runtime-persona.test.ts).
export const uatLevel = { level: "solo-admin", without: [] } as const;

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

test("ordinary chat turn sends no snapshot and performs no current-view pull", async ({ page }) => {
  await signIn(page);

  let turnBody: unknown;
  let pageContextPushCount = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST" && request.method() !== "PUT") return;
    const url = request.url();
    // apps/web/src/api/client.ts:835-840 sendChatTurn posts only `{ text }` — proves Task 5's
    // push-deletion holds: the client no longer bundles a page-context snapshot onto the turn.
    if (url.endsWith("/api/chat/turn")) turnBody = request.postDataJSON();
    // apps/web/src/api/client.ts:847-849 updatePageContext is the SEPARATE, debounced push path
    // (apps/web/src/chat/use-page-context-sync.ts) triggered by route/DOM/focus/selection changes
    // — not by sending a turn. Counting it proves clicking Send doesn't also trigger a push.
    if (url.endsWith("/api/chat/page-context")) pageContextPushCount += 1;
  });

  await openChat(page);
  await page.getByRole("textbox", { name: "Message Moss" }).fill("Say hello in three words.");
  await page.getByRole("button", { name: "Send" }).click();

  // No chat-capable model is seeded (see file header), so the real server response is a 400
  // ("No active chat-capable model is configured.", packages/chat/src/live-routes.ts:448). The
  // drawer's isNoActiveChatModelError catch (apps/web/src/chat/chat-drawer.tsx:241-246) sets
  // needsProvider, rendering ConnectProviderEmpty additively above the still-mounted composer
  // (apps/web/src/chat/connect-provider-empty.tsx) — a deterministic terminal state we can assert
  // against instead of a real model reply. `.first()`: the drawer renders this twice at once (the
  // thread-area empty state, chat-drawer.tsx:493, and the composer's own copy, composer.tsx:231) —
  // pre-existing app behavior, not something this test introduces.
  await expect(page.getByText("Connect a provider to start chatting").first()).toBeVisible();

  expect(turnBody).toEqual({ text: "Say hello in three words.", surface: "drawer" });
  expect(pageContextPushCount).toBe(0);
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

// #1121: the actual refusal exchange ("Take a screenshot..." -> a reply that asks the user to
// paste the exact text instead) needs a real, instruction-following chat model to produce the
// reply text. The UAT harness's only seeded provider is a fake one bound solely to module.news
// (see file header) — no seed level can drive this turn to a real reply. The persona instruction
// that would produce this refusal is proven at the unit level by
// tests/unit/chat-runtime-persona.test.ts (Task 6), and the tool's absence from the manifest is
// proven for real above. Deferred until #1121's scriptable UAT chat engine exists.
test.fixme("chat refuses to take a screenshot and explains why instead (#1121)", async () => {});

// #1121: this needs a real chat model to (a) call chat.getCurrentView + app.getMapSlice to ground
// its answer in the actual News error, and (b) produce prose citing the "JSON-capable economy
// model" remediation and a working Assistant & AI settings link. The UAT harness cannot drive this
// (see file header). The News error's own deterministic rendering (no chat involved) is already
// proven by app-map-grounding.uat.spec.ts's "declared prerequisite surfaces the News no-json-model
// error" — not duplicated here. The tool-calling and grounding logic this test would exercise is
// proven at the unit level by tests/unit/current-view-tool.test.ts (schema + read-service, Tasks
// 4/6) and tests/unit/chat-runtime-persona.test.ts (persona instructs calling chat.getCurrentView
// for screen-scoped questions, Task 6). Deferred until #1121's scriptable UAT chat engine exists.
test.fixme("News screen error is pulled and resolved against the map (#1121)", async () => {});
