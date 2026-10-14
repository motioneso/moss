import { expect, test, type Page } from "@playwright/test";
import type { ListChatThreadMessagesResponse, NewsSourcePreviewResponse } from "@moss/shared";
import {
  UAT_ADMIN_EMAIL,
  UAT_ADMIN_PASSWORD,
  UAT_SECOND_OWNER_ID,
  UAT_SECOND_OWNER_EMAIL,
  UAT_SECOND_OWNER_PASSWORD
} from "../seed/admin.js";

import { bringUpRealChatModel, readUatJson } from "./real-chat-signin.js";

// #1110: withoutNewsJsonBinding leaves module.news unbound to a JSON-capable model so the
// "declared prerequisite" scenario naturally hits news.add_source.no_json_model — see
// tests/uat/seed/chunks/ai.ts's seedAiProviderChunk(runner, actorUserId, options) gate.
//
// SCOPE NOTE (#1110 / #1121): this spec asserts only the DETERMINISTIC surfaces #1110 owns —
// the News add-source prerequisite/transient error codes (rendered without any live upstream or
// LLM call). The original spec also asserted the app-map-grounded CHAT answers ("I don't know
// from the current app map", the "JSON-capable economy model" remediation, the getMapSlice trace).
// Those require a real, instruction-following chat model. The scripted chat model used here
// (chat-scripts/app-map-grounding.json) returns fixed text, so it cannot check grounding. The
// persona/grounding strings are proven at the unit level in Task 7's chat-runtime-persona test;
// the real-LLM e2e assertions wait on issue #1121.
export const uatLevel = {
  level: "multi-user",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "app-map-grounding"
} as const;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  // Scoped to the form: the auth-mode segmented control has its own "Sign in" tab button
  // with the same accessible name as the submit button (apps/web/src/auth/auth-screen.tsx).
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  // #1110: after sign-in a freshly-seeded owner with first-run onboarding pending lands on the
  // onboarding wizard, while an owner who has already completed setup (the provisioned admin) lands
  // straight on the app shell. Wait for whichever appears, then skip onboarding only when it's shown
  // (Skip setup → "Skip anyway" confirmation). Conditional so it's correct for both users and stays
  // idempotent across the shared, non-reset UAT DB.
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const skipAnyway = page.getByRole("button", { name: "Skip anyway" });
  const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    // The "Skip anyway" confirmation opens only while no chat model is available. The scripted
    // model is loaded here, so Skip setup can finish without it.
    await expect(skipAnyway.or(userMenu).first()).toBeVisible();
    if (await skipAnyway.isVisible()) await skipAnyway.click();
  }
  await expect(userMenu).toBeVisible();
}

// Open the News add-source settings surface directly by deep link. Going straight to the settings
// URL (rather than News → empty-state "Choose sources") keeps the test independent of whether the
// seeded feed has stories — with seeded content the News page renders the feed, not the empty
// state, so its "Choose sources" link is absent — and avoids the ambiguous "News" nav selector
// (the feed contains many article links whose accessible name starts with "News").
async function openNewsSourceSettings(page: Page) {
  await page.goto(`${requireBaseURL()}/settings?section=modules&module=news`);
}

async function ask(page: Page, text: string) {
  // Live label is `Chat with ${assistantName}` (apps/web/src/shell/app-shell.tsx), sourced from
  // settings persona and defaulting to "Moss" (packages/shared/src/persona-api.ts) — not the
  // pre-rename "Jarvis" literal.
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  await page.getByRole("textbox", { name: "Message Moss" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

// #1110 binding: this asserts the withoutNewsJsonBinding SEED THREADING (Task 8's additive
// provisioner → run-uat → seed level → seedAiProviderChunk path). With module.news left unbound,
// the add-source preview short-circuits on the hasJsonModel gate and surfaces
// news.add_source.no_json_model with no upstream call. If that threading regressed and news got a
// JSON model bound, the gate would pass and this error would never render — so the assertion goes
// red, which is what makes it meaningful for #1110 rather than a tautology over #1025 rendering.
// (The original app-map-grounded chat remediation for this error is deferred to #1121 — see the
// scope note above.)
//
// #1110 discovery: with a genuinely-empty AI-provider seed (hasJsonModel() truly false), the News
// settings UI's own prerequisite gate (customSourceByUrlEnabled = hasJsonModel, see
// packages/news/src/personalization-routes.ts) hides the add-source form entirely — "Add source"
// renders disabled with no "Publication homepage or domain" input, so the backend's
// news.add_source.no_json_model error can never be reached by driving the form. That UI gate is
// correct product behavior (don't invite a submission you know will fail), not a bug. This test
// asserts both layers: the UI is gated, and the backend endpoint independently enforces the same
// rule for any caller that reaches it directly (e.g. a future non-browser client).
test("declared prerequisite surfaces the News no-json-model error", async ({ page }) => {
  await signIn(page, UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD);
  await openNewsSourceSettings(page);
  await expect(page.getByRole("button", { name: "Add source" })).toBeDisabled();
  await expect(
    page.getByText("Adding sources needs an AI model with structured output.")
  ).toBeVisible();

  const response = await page.request.post(`${requireBaseURL()}/api/news/sources/preview`, {
    data: { input: "example.com" }
  });
  const body = (await response.json()) as NewsSourcePreviewResponse;
  expect(body.error?.code).toBe("news.add_source.no_json_model");
});

// #1121: the "honest unknown" scenario ("Where is the quantum sandwich scheduler?" → the chat
// answers "I don't know from the current app map" and never invents a location) is a pure
// app-map-grounded CHAT assertion with no deterministic surface to stand in for it. It requires a
// real instruction-following chat model the UAT harness does not provide, so there is intentionally
// no e2e case here. The behavior is covered at the unit level by Task 7's chat-runtime-persona
// test, and the real-LLM e2e is deferred until the scriptable UAT chat engine (#1121) exists.

// #1110 binding: this asserts the previewOverride path SPECIFICALLY. The "uat-transient.invalid"
// sentinel is mapped by #1110's buildUatNewsPreviewOverride to a transient discovery error, and
// personalization-routes checks that override BEFORE the hasJsonModel gate. Because this spec's
// seed leaves news unbound, without the override the same input would fall through to the gate and
// surface news.add_source.no_json_model (class="prerequisite") instead — so an error whose
// class is "transient" can only come from #1110's override winning first. If previewOverride
// regressed or stopped winning first, this assertion goes red.
//
// #1110 discovery: same as the prerequisite test above, the "Publication homepage or domain"
// input is unreachable via the UI under a genuinely-empty AI-provider seed (the News settings
// page gates the whole add-source form behind hasJsonModel, which is false here by design) — so
// this exercises the same authenticated preview endpoint directly rather than driving the form.
test("transient discovery error is surfaced deterministically via previewOverride", async ({
  page
}) => {
  await signIn(page, UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD);
  const response = await page.request.post(`${requireBaseURL()}/api/news/sources/preview`, {
    data: { input: "uat-transient.invalid" }
  });
  const body = (await response.json()) as NewsSourcePreviewResponse;
  expect(body.error?.class).toBe("transient");
});

// A real second-owner turn must consult the map without revealing admin-only surfaces.
test("non-admin map query never reveals admin settings", async ({ page, browser }) => {
  const strict = Boolean(process.env.JARVIS_UAT_REQUIRE_REAL_CHAT);
  if (strict) {
    test.setTimeout(300_000);
    const context = await browser.newContext({ baseURL: requireBaseURL() });
    try {
      const admin = await context.newPage();
      await signIn(admin, UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD);
      const model = await bringUpRealChatModel(admin);
      await readUatJson(
        await admin.request.put(`/api/admin/users/${UAT_SECOND_OWNER_ID}/ai-pin`, {
          data: { modelId: model.id }
        })
      );
      await signIn(page, UAT_SECOND_OWNER_EMAIL, UAT_SECOND_OWNER_PASSWORD);
      for (const capability of ["chat", "tool-use", "json", "summarization"]) {
        const body = (await readUatJson(
          await page.request.get(`/api/ai/capability-route/${capability}`)
        )) as {
          route: { model: { id: string } | null; reason: string };
        };
        expect(body.route.model?.id).toBe(model.id);
        expect(body.route.reason).toBe("admin-pin");
      }
    } finally {
      await context.close();
    }
  } else {
    await signIn(page, UAT_SECOND_OWNER_EMAIL, UAT_SECOND_OWNER_PASSWORD);
  }
  const response = strict
    ? page.waitForResponse(
        (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/chat/turn",
        { timeout: 180_000 }
      )
    : null;
  await ask(page, "Use the app map to list every settings screen I can use");
  if (response) {
    const body = (await readUatJson(await response)) as {
      reply: string;
      assistantMessageId: string;
    };
    expect(body.reply).toMatch(/settings/i);
    const privacy = (await readUatJson(
      await page.request.get("/api/chat/privacy?surface=drawer")
    )) as { threadId: string };
    const history = (await readUatJson(
      await page.request.get(`/api/chat/threads/${privacy.threadId}/messages?surface=drawer`)
    )) as ListChatThreadMessagesResponse;
    const answer = history.messages.find((message) => message.id === body.assistantMessageId);
    expect(answer).toBeDefined();
    const calls = answer!.activity.filter(
      (entry) =>
        entry.kind === "tool" && entry.toolName?.includes("getMapSlice") && entry.toolCallId
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(
      answer!.activity.some(
        (entry) =>
          entry.kind === "result" &&
          calls.some((call) => call.toolCallId === entry.toolCallId) &&
          /"items"\s*:\s*\[\s*\{|^\|.+\|\s*\n\|[ :|-]+\|/m.test(entry.text)
      )
    ).toBe(true);
    expect(body.reply).not.toMatch(/Advanced host setup|People & access|Instance modules/i);
  } else {
    await expect(page.getByText("Scripted reply for the settings question.").first()).toBeVisible();
  }
  await expect(page.getByText(/Advanced host setup|People & access|Instance modules/i)).toHaveCount(
    0
  );
});
