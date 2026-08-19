import { expect, test, type Page } from "@playwright/test";

import { createMockAiModel } from "./mock-ai-api.js";
import { createMockChatMessage, createMockChatThread } from "./mock-chat-api.js";
import { createMockConnectorProviders, mockApi } from "./mock-api.js";

/**
 * Live chat drawer E2E.
 *
 * What is mocked:
 *  - The full REST surface via mockApi (auth/me/modules/etc.).
 *  - POST /api/chat/turn → { reply } (the drawer ignores this body; the stream renders).
 *  - POST /api/chat/clear → 204 for the "New chat" action.
 *  - GET  /api/chat/stream (SSE) → a one-shot, fulfilled text/event-stream body
 *    containing the user echo and the assistant reply as two `data:` events.
 *
 * The SSE stream is the SINGLE SOURCE OF TRUTH for rendered records: the drawer no
 * longer appends the POST response, so a real stream mock is required (not an empty
 * stub). Playwright's route.fulfill with a string event-stream body works here — the
 * browser EventSource reads the two events, then the fulfilled connection ends.
 * We assert both records render exactly once (no double-render).
 *
 * The chat is now a GLOBAL drawer mounted in the app shell and toggled from the topbar.
 * The stream connects at app load, so the records
 * have already arrived by the time we open the drawer.
 */
test("opens the live chat drawer from the nav and renders the streamed records once", async ({
  page
}) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  // Mock the SSE stream as the source of truth: a one-shot event-stream body with
  // the user echo and the assistant reply. The EventSource reads both events, then
  // the fulfilled connection ends. EventSource auto-reconnects after a closed
  // stream, so we serve the two events ONCE and then hold the connection open
  // (empty body, never resolved) on reconnect — otherwise the events would replay
  // and the records would render twice.
  let streamServed = false;
  await page.route("**/api/chat/stream*", async (route) => {
    if (streamServed) {
      // Hold the reconnect open with no data so events don't replay.
      return; // leave the route hanging; the page is about to assert and finish
    }
    streamServed = true;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body:
        'data: {"kind":"user","text":"Hi there"}\n\n' +
        'data: {"kind":"reply","text":"Hello from the assistant"}\n\n'
    });
  });

  await page.route("**/api/chat/turn", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reply: "Hello from the assistant" })
    })
  );

  await page.route("**/api/chat/clear", (route) => route.fulfill({ status: 204, body: "" }));

  await page.goto("/");

  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();

  // Send a turn (the reply arrives over the SSE stream, which is the source of truth).
  await drawer.getByLabel("Message Moss").fill("Hi there");
  await drawer.getByLabel("Message Moss").press("Enter");

  // Both records arrive over the SSE stream and render exactly once each.
  await expect(drawer.getByText("Hi there")).toHaveCount(1);
  await expect(drawer.getByText("Hello from the assistant")).toHaveCount(1);

  // "New chat" clears the transcript. (Assert the streamed records are gone rather than a
  // specific empty-state copy: since v0.1.4 the empty state is onboarding-gated and shows the
  // connect-a-provider explainer when no provider is configured, as in this mock.)
  await drawer.getByRole("button", { name: "New chat" }).click();
  await expect(drawer.getByText("Hello from the assistant")).toHaveCount(0);
  await expect(drawer.getByText("Hi there")).toHaveCount(0);
});

// #1089: guards the exact fire-and-forget race a since-reverted PR (#1035) reintroduced —
// `setPrivateMode(true)` firing before `clearChat({incognito:true})` resolved. The current
// `startPrivateChat` awaits the clear first (PR #1036, Part of #984) and gates `sendMessage`
// on `activatingPrivate` in the meantime; this test is the regression lock for that ordering.
test("private activation blocks send until the server confirms, then allows it", async ({
  page
}) => {
  let releaseClear: (() => void) | undefined;
  const clearGate = {
    promise: new Promise<void>((resolve) => {
      releaseClear = resolve;
    }),
    release: () => releaseClear?.()
  };

  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    clearGate
  });

  let turnCalled = false;
  await page.route("**/api/chat/turn", async (route) => {
    turnCalled = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  // The shared mock's SSE stream closes after one heartbeat, which fires EventSource.onerror
  // and would end the private session mid-test. Keep it pending — this test doesn't assert
  // on stream events.
  await page.route("**/api/chat/stream*", () => new Promise<void>(() => {}));

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Start private chat" }).click();

  // While the server confirmation is held open, the private banner must not show yet,
  // and attempting to send must not reach POST /api/chat/turn.
  await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toHaveCount(0);
  await drawer.getByLabel("Message Moss").fill("secret during race");
  await drawer.getByLabel("Message Moss").press("Enter");
  await page.waitForTimeout(100);
  expect(turnCalled).toBe(false);

  clearGate.release();

  await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toBeVisible();
});

test("reloading the page restores private-mode indication from server truth", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    incognito: true
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();

  await expect(drawer.getByRole("button", { name: "Start private chat" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
});

test("queued chat drain stays stable while SSE records arrive, then sends once after stop", async ({
  page
}) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  const turnTexts: string[] = [];
  let cancelRequests = 0;
  let releaseFirstTurn: (() => void) | null = null;
  const firstTurnStopped = new Promise<void>((resolve) => {
    releaseFirstTurn = resolve;
  });

  await page.route("**/api/chat/turn", async (route) => {
    const body = route.request().postDataJSON() as { readonly text: string };
    turnTexts.push(body.text);

    if (body.text === "First question") {
      await firstTurnStopped;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reply: `Reply for ${body.text}` })
    });
  });

  // Match by pathname, not the full URL — a ?surface=drawer query string is now appended.
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/turn/cancel"),
    async (route) => {
      cancelRequests += 1;
      releaseFirstTurn?.();
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    }
  );

  await page.route("**/api/chat/clear", (route) => route.fulfill({ status: 204, body: "" }));

  // Three SSE reconnects fire while the first turn is held and a second sits queued (#1520).
  let streamTicks = 0;
  await page.route("**/api/chat/stream*", async (route) => {
    const tick = streamTicks++;
    if (tick >= 3) return;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: `data: ${JSON.stringify({ kind: "reply", text: `Tick ${tick}`, messageId: `tick-${tick}` })}\n\n`
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  const composerInput = drawer.getByLabel("Message Moss");
  const queuedChip = drawer.locator(".chatd-next__text");

  await composerInput.fill("First question");
  await composerInput.press("Enter");

  const composerAction = drawer.locator(".chatd-input .chatd-send");
  await expect(composerAction).toHaveAttribute("aria-label", "Stop generating");
  await expect(drawer.locator(".chatd-loading .chatd-stop")).toHaveCount(0);

  await composerInput.fill("Line one");
  await composerInput.press("Shift+Enter");
  await expect(composerInput).toHaveValue("Line one\n");
  await composerInput.type("Line two");
  await composerInput.press("Enter");
  await expect(composerInput).toHaveValue("");
  await expect(queuedChip).toContainText('Next: "Line one Line two"');

  await composerInput.fill("Replacement next");
  await composerInput.press("Enter");
  await expect(queuedChip).toContainText('Next: "Replacement next"');
  await expect(drawer.getByText(/Line one/)).toHaveCount(0);

  await drawer.getByRole("button", { name: "Edit queued message" }).click();
  await expect(composerInput).toHaveValue("Replacement next");
  await expect(drawer.getByText(/Next:/)).toHaveCount(0);

  await composerInput.fill("Discard me");
  await composerInput.press("Enter");
  await drawer.getByRole("button", { name: "Discard queued message" }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(drawer.getByText(/Next:/)).toHaveCount(0);

  await composerInput.fill("Drained queued");
  await composerInput.press("Enter");
  await expect(queuedChip).toContainText('Next: "Drained queued"');

  await expect(drawer.getByText("Tick 2")).toBeVisible();
  await expect(queuedChip).toContainText('Next: "Drained queued"');
  await composerAction.click();
  await expect.poll(() => turnTexts).toEqual(["First question", "Drained queued"]);
  expect(cancelRequests).toBe(1);
  await expect(drawer.getByText(/Next:/)).toHaveCount(0);
  await expect(drawer.getByText("Drained queued", { exact: true })).toHaveCount(1);
});

test("selecting a History row both opens and activates it — no separate resume step", async ({
  page
}) => {
  const model = createMockAiModel("model-1");
  const thread = createMockChatThread("thread-old", "Old chat");
  const storedMessage = createMockChatMessage("message-old", thread.id, "Earlier context");
  let resumeCalledWith: string | null = null;
  let resumeFinished = false;
  let releaseResume: (() => void) | undefined;
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  let messagesFinished = false;
  let releaseMessages: (() => void) | undefined;
  const messagesGate = new Promise<void>((resolve) => {
    releaseMessages = resolve;
  });
  await mockApi(page, {
    authenticated: true,
    aiModels: [model],
    chatThreads: [thread],
    chatMessages: { [thread.id]: [storedMessage] },
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  await page.route("**/api/ai/chat-model-override", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        settings: {
          overrideEnabled: true,
          currentOverrideModelId: null,
          effectiveOverrideModelId: null,
          defaultModel: model,
          selectedModel: model,
          selectableOverrideModels: [model]
        }
      })
    });
  });
  // Match by pathname, not the full URL — a ?surface=drawer query string is now appended.
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/threads/thread-old/messages"),
    async (route) => {
      await messagesGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ messages: [storedMessage] })
      });
      messagesFinished = true;
    }
  );
  // Match by pathname, not the full URL — a ?surface=drawer query string is now appended.
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/threads/thread-old/resume"),
    async (route) => {
      resumeCalledWith = "thread-old";
      await resumeGate;
      await route.fulfill({ status: 204, body: "" });
      resumeFinished = true;
    }
  );
  await page.route("**/api/chat/turn", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reply: "Continued" })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  const composer = drawer.getByLabel("Message Moss");
  const modelTrigger = drawer.locator(".chatd-model__trigger");
  await drawer.getByRole("button", { name: "Show chat history" }).click();
  await drawer.getByText("Old chat").click();

  await expect.poll(() => resumeCalledWith).toBe("thread-old");
  await expect(drawer.locator(".chatd-sess")).toHaveCount(0);
  await expect(drawer.locator(".chatd-review")).toHaveCount(0);
  await expect(composer).toBeDisabled();
  await modelTrigger.click();
  const modelChoice = drawer.locator(".chatd-model__menu button").first();
  await expect(modelChoice).toBeVisible();
  await expect(modelChoice).toBeDisabled();

  releaseResume?.();
  await expect.poll(() => resumeFinished).toBe(true);
  await expect(composer).toBeDisabled();
  await expect(modelChoice).toBeDisabled();

  releaseMessages?.();
  await expect.poll(() => messagesFinished).toBe(true);
  await expect(drawer.getByText("Earlier context")).toBeVisible();
  await expect(composer).toBeEditable();
  await expect(modelChoice).toBeEnabled();

  await composer.fill("Continue here");
  await composer.press("Enter");
  await expect(drawer.getByText("Earlier context")).toBeVisible();
  await expect(drawer.getByText("Continue here")).toBeVisible();
});

// #1090: resuming a persisted (necessarily non-incognito — ChatRepository.listThreads
// filters `incognito = false`) History thread while a private session is active must
// invalidate the stale client-side `privateMode` flag. Before the fix, resumeMutation's
// onSuccess never touched `privateMode`/`privateEnded`, so once the user sent a message in
// the resumed thread (flipping `reviewing` back to false) the "not saved" private banner and
// the shield toggle's pressed state kept lying about a thread that IS being saved.
test("resuming a History thread while private clears the stale privateMode flag", async ({
  page
}) => {
  const thread = createMockChatThread("thread-old", "Old chat");
  const storedMessage = createMockChatMessage("message-old", thread.id, "Earlier context");

  await mockApi(page, {
    authenticated: true,
    chatThreads: [thread],
    chatMessages: { [thread.id]: [storedMessage] },
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    // Server truth on mount: a private session is already active (mirrors reload-while-private).
    incognito: true
  });
  // Match by pathname, not the full URL — a ?surface=drawer query string is now appended.
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/threads/thread-old/resume"),
    (route) => route.fulfill({ status: 204, body: "" })
  );
  await page.route("**/api/chat/turn", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reply: "Continued" })
    })
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  const privateToggle = drawer.getByRole("button", { name: "Start private chat" });

  // Sanity: private mode really is active before the resume (server-truth restore, #1036).
  await expect(privateToggle).toHaveAttribute("aria-pressed", "true");

  await drawer.getByRole("button", { name: "Show chat history" }).click();
  await drawer.getByText("Old chat").click();
  await expect(drawer.getByText("Earlier context")).toBeVisible();

  // The stale privateMode flag from before the resume must already be gone — the resumed
  // thread is persisted (non-incognito), so the shield toggle must not show pressed.
  await expect(privateToggle).toHaveAttribute("aria-pressed", "false");

  const composer = drawer.getByLabel("Message Moss");
  await composer.fill("Continue here");
  await composer.press("Enter");
  await expect(drawer.getByText("Continued")).toBeVisible();

  // `reviewing` flips false once a message is sent in the resumed thread — this is exactly
  // where the stale flag used to surface the "not saved" banner on a now-persisted thread.
  await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toHaveCount(0);
});

test("resume failure clears selection and reopens History", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [createMockChatThread("thread-old", "Old chat")],
    chatMessages: { "thread-old": [] },
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  // Match by pathname, not the full URL — a ?surface=drawer query string is now appended.
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/threads/thread-old/resume"),
    async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Chat thread not found" })
      });
    }
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await drawer.getByRole("button", { name: "Show chat history" }).click();
  await drawer.getByText("Old chat").click();

  await expect(drawer.locator(".chatd-sess")).toBeVisible();
  await expect(drawer.locator(".chatd-sess__row.is-selected")).toHaveCount(0);
});

test("History hides the ordinary composer seeds while open", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [
      {
        id: "thread-old",
        ownerUserId: "user-1",
        title: "Old chat",
        incognito: false,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }
    ],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await drawer.getByRole("button", { name: "Show chat history" }).click();

  await expect(drawer.locator(".chatd-empty")).toHaveCount(0);
  await expect(drawer.locator(".chatd-sess")).toBeVisible();
});

test("empty History explains that there are no past conversations", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await drawer.getByRole("button", { name: "Show chat history" }).click();

  await expect(drawer.getByText("No past conversations yet.")).toBeVisible();
  await expect(drawer.locator(".chatd-empty")).toHaveCount(0);
});

/**
 * Helper: serve a single assistant `reply` record over the SSE stream (the source of
 * truth), then hold any reconnect open so the event does not replay. Mirrors the
 * one-shot stream pattern used above.
 */
async function streamReply(page: Page, replyText: string) {
  let streamServed = false;
  await page.route("**/api/chat/stream*", async (route) => {
    if (streamServed) {
      return; // hold reconnect open; no replay
    }
    streamServed = true;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: `data: ${JSON.stringify({ kind: "reply", text: replyText })}\n\n`
    });
  });
}

test("renders assistant markdown as rich HTML (table, bold, code, list)", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  const md =
    "**bold text** and `inline`\n\n" +
    "| A | B |\n|---|---|\n| 1 | 2 |\n\n" +
    "- one\n- two\n\n" +
    "```\ncode block\n```";
  await streamReply(page, md);

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();

  // Markdown parsed into semantic elements (not literal source).
  await expect(drawer.locator(".chatd-md table")).toHaveCount(1);
  await expect(drawer.locator(".chatd-md strong")).toHaveText("bold text");
  await expect(drawer.locator(".chatd-md code").first()).toContainText("inline");
  await expect(drawer.locator(".chatd-md pre")).toContainText("code block");
  await expect(drawer.locator(".chatd-md li")).toHaveCount(2);
  // The raw GFM table source must NOT appear literally.
  await expect(drawer.getByText("| A | B |")).toHaveCount(0);
});

test("does not inject executable HTML from untrusted markdown", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  // Untrusted reply covering every injection vector: raw <script>, an <img onerror>, a
  // raw-HTML event-handler blob, a javascript: markdown link, a data:text/html markdown
  // link, and a bare URL (which remark-gfm autolinks into an <a> without link syntax).
  // None may produce executable HTML; only http(s)/mailto hrefs may survive.
  const evil =
    "<script>window.__pwned = 1</script>\n\n" +
    '<img src=x onerror="window.__pwned = 1">\n\n' +
    '<div onclick="window.__pwned = 1">raw html blob</div>\n\n' +
    "[click me](javascript:alert(1))\n\n" +
    "[doc link](data:text/html,<script>window.__pwned=1</script>)\n\n" +
    "bare autolink https://example.com/safe here";
  await streamReply(page, evil);

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  // Wait for the reply to render (the link text survives as plain text).
  await expect(drawer.getByText("click me")).toBeVisible();
  // The markdown renderer is active (ties this security test to the feature).
  await expect(drawer.locator(".chatd-md")).toHaveCount(1);
  // The bare URL was autolinked (proves the gfm autolink path is exercised, not bypassed).
  await expect(drawer.locator('.chatd-md a[href="https://example.com/safe"]')).toHaveCount(1);

  // No script/img/event-handler element was injected into the chat bubble.
  await expect(drawer.locator(".chatd-md script")).toHaveCount(0);
  await expect(drawer.locator(".chatd-md img")).toHaveCount(0);
  await expect(drawer.locator(".chatd-md [onclick]")).toHaveCount(0);

  // Every surviving href is on the http(s)/mailto allowlist — no javascript:/data:/etc.
  const hrefs = await drawer
    .locator(".chatd-md a")
    .evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? ""));
  for (const href of hrefs) {
    expect(href === "" || /^(https?:|mailto:)/i.test(href)).toBe(true);
  }

  // Every rendered link opens safely.
  const rels = await drawer
    .locator(".chatd-md a")
    .evaluateAll((els) => els.map((el) => el.getAttribute("rel") ?? ""));
  for (const rel of rels) {
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  }

  // The injection side-effect never fired.
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)
  ).toBeUndefined();
});

test("#638: reopening the drawer scrolls to the newest message, not the top", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  // Enough records to overflow the drawer body so a fresh (top-scrolled) mount is
  // visibly distinguishable from a bottom-pinned one.
  const events = Array.from(
    { length: 30 },
    (_, i) => `data: ${JSON.stringify({ kind: "reply", text: `Message number ${i}` })}\n\n`
  ).join("");
  let streamServed = false;
  await page.route("**/api/chat/stream*", async (route) => {
    if (streamServed) {
      return; // hold reconnect open; no replay
    }
    streamServed = true;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: events
    });
  });

  await page.goto("/");

  const navToggle = page.getByRole("button", { name: "Chat with Moss" });
  await navToggle.click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Message number 29")).toBeVisible();

  // Close, then reopen — the drawer unmounts its scroll container while closed (renders
  // null), so a fresh mount must re-pin to the newest message rather than starting at the top.
  await navToggle.click();
  await expect(drawer).toBeHidden();
  await navToggle.click();
  await expect(drawer).toBeVisible();

  await expect(drawer.getByText("Message number 29")).toBeInViewport();
});

test("#664: a sent message renders after the prior turn, not at the top", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  // Hold the SSE stream open WITHOUT delivering any records. This isolates the
  // POST-fallback path: props.records stays empty, so records rendered while waiting for
  // the stream come entirely from fallbackRecords + the optimistic pending bubble.
  await page.route("**/api/chat/stream*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: ""
    })
  );

  // POST /turn #1 resolves immediately so its user+reply land in fallbackRecords before #2.
  // POST /turn #2 is held pending so the optimistic pending bubble stays on screen for the
  // ordering assertion (once it resolves the records reshuffle).
  const gate: { resolve: (() => void) | null } = { resolve: null };
  const secondTurnReleased = new Promise<void>((resolve) => {
    gate.resolve = resolve;
  });
  await page.route("**/api/chat/turn", async (route) => {
    const body = route.request().postDataJSON() as { readonly text: string };
    if (body.text === "Second message") {
      await secondTurnReleased;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        reply: `Reply to ${body.text}`,
        userMessageId: `user-${body.text}`,
        assistantMessageId: `assistant-${body.text}`
      })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  const composerInput = drawer.getByLabel("Message Moss");

  // Send #1 — POST resolves, fallbackRecords becomes [user1, reply1]. SSE delivers nothing.
  await composerInput.fill("First message");
  await composerInput.press("Enter");
  await expect(drawer.getByText("Reply to First message")).toBeVisible();

  // Send #2 — held pending, so the optimistic "Second message" bubble is on screen.
  await composerInput.fill("Second message");
  await composerInput.press("Enter");

  // The just-sent "Second message" must render AFTER the prior turn, not at the top.
  // Today this FAILS: effectiveRecords = [pendingUser2, user1, reply1] (user2 on top, #664).
  const userBubbles = drawer.locator(".chatd-msg--me .chatd-bubble");
  await expect
    .poll(async () => (await userBubbles.allTextContents()).map((t) => t.trim()))
    .toEqual(["First message", "Second message"]);

  gate.resolve?.();
});

// #1519 (1139-B): reconcile fallback records by identity (kind + messageId), not by kind + exact
// text. Two turns sent with identical text produce two same-kind, same-text fallback pairs with
// distinct ids. The old predicate matched an incoming SSE record against BOTH identical fallbacks
// by text alone, so the first SSE delivery silently dropped its still-unconfirmed sibling — a
// visible flicker from 2 bubbles to 1. This locks the fix: each SSE delivery must retire only the
// fallback that shares its messageId, and the legacy (id-less on both sides) case must still fall
// back to kind + exact text.
test("identical fallbacks reconcile by messageId, not by kind+text", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  // Three staged SSE connections, one per reconciling delivery, each held open until its gate
  // resolves so we control exactly when it lands relative to the POST turns already having
  // populated fallbackRecords. After the third, hold the stream open forever (no replay).
  function makeGate(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve: (() => void) | null = null;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve: resolve! };
  }
  const gate0 = makeGate();
  const gate1 = makeGate();
  const gate2 = makeGate();
  const connections: ReadonlyArray<{
    readonly gate: { readonly promise: Promise<void>; readonly resolve: () => void };
    readonly body: string;
  }> = [
    {
      gate: gate0,
      body: 'retry: 10\ndata: {"kind":"reply","text":"Reply to Ping","messageId":"turn-1-reply"}\n\n'
    },
    {
      gate: gate1,
      body: 'retry: 10\ndata: {"kind":"reply","text":"Reply to Ping","messageId":"turn-2-reply"}\n\n'
    },
    { gate: gate2, body: 'data: {"kind":"reply","text":"Reply to Legacy ping"}\n\n' }
  ];
  let connectionIndex = 0;
  await page.route("**/api/chat/stream*", async (route) => {
    const idx = connectionIndex++;
    const connection = connections[idx];
    if (!connection) {
      return; // hold the final reconnect open forever; no replay
    }
    await connection.gate.promise;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: connection.body
    });
  });

  let turnCount = 0;
  await page.route("**/api/chat/turn", async (route) => {
    const body = route.request().postDataJSON() as { readonly text: string };
    if (body.text === "Legacy ping") {
      // Simulate a pre-#1482 backend response carrying no ids.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ reply: "Reply to Legacy ping" })
      });
      return;
    }
    turnCount++;
    const n = turnCount;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        reply: "Reply to Ping",
        userMessageId: `turn-${n}-user`,
        assistantMessageId: `turn-${n}-reply`
      })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  const composerInput = drawer.getByLabel("Message Moss");

  // Two identical turns land as two same-kind, same-text fallback pairs with distinct ids.
  await composerInput.fill("Ping");
  await composerInput.press("Enter");
  await expect(drawer.getByText("Reply to Ping")).toHaveCount(1);
  await composerInput.fill("Ping");
  await composerInput.press("Enter");
  await expect(drawer.getByText("Reply to Ping")).toHaveCount(2);

  // First matching SSE delivery: only its own fallback must disappear. The old kind+text-only
  // predicate matched BOTH identical fallbacks against this one SSE record, dropping the count
  // to 1 — the flicker this test exists to close.
  gate0.resolve();
  await expect(drawer.getByText("Reply to Ping")).toHaveCount(2);

  // Second matching SSE delivery: the remaining fallback reconciles too, no duplicate.
  gate1.resolve();
  await expect(drawer.getByText("Reply to Ping")).toHaveCount(2);

  // Legacy id-less fixture: neither side has a messageId, so the kind+text fallback still
  // applies and must not survive its own SSE echo.
  await composerInput.fill("Legacy ping");
  await composerInput.press("Enter");
  await expect(drawer.getByText("Reply to Legacy ping")).toHaveCount(1);
  gate2.resolve();
  await expect(drawer.getByText("Reply to Legacy ping")).toHaveCount(1);
});

// #1519 (1139-B) QA-RED follow-up: the real live-path SSE "kind: user" echo
// (packages/chat/src/live/chat-session-manager.ts) is emitted synchronously at turn start and
// NEVER carries a messageId, while the POST-fallback's user record always does (result.userMessageId
// arrives after the turn completes). The `a.messageId || b.messageId` predicate treated that
// asymmetry as a real id mismatch (undefined !== '<uuid>') and never retired the fallback — the
// user's own message rendered twice, permanently. This locks the `a.messageId && b.messageId` fix
// (strict id compare only when BOTH sides carry one) and, since two identical sends now produce two
// same-text fallbacks that must each reconcile against only their own idless echo (not both against
// the first arrival — the general one-to-one `reconcileFallbacks` requirement), also proves that.
test("user fallback reconciles against an idless live echo, one-to-one across duplicate sends", async ({
  page
}) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  function makeGate(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve: (() => void) | null = null;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve: resolve! };
  }
  const gate0 = makeGate();
  const gate1 = makeGate();
  const connections: ReadonlyArray<{
    readonly gate: { readonly promise: Promise<void>; readonly resolve: () => void };
    readonly body: string;
  }> = [
    { gate: gate0, body: 'retry: 10\ndata: {"kind":"user","text":"Ping"}\n\n' },
    { gate: gate1, body: 'data: {"kind":"user","text":"Ping"}\n\n' }
  ];
  let connectionIndex = 0;
  await page.route("**/api/chat/stream*", async (route) => {
    const idx = connectionIndex++;
    const connection = connections[idx];
    if (!connection) {
      return; // hold the final reconnect open forever; no replay
    }
    await connection.gate.promise;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: connection.body
    });
  });

  let turnCount = 0;
  await page.route("**/api/chat/turn", async (route) => {
    turnCount++;
    const n = turnCount;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        reply: "Reply to Ping",
        userMessageId: `turn-${n}-user`,
        assistantMessageId: `turn-${n}-reply`
      })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  const composerInput = drawer.getByLabel("Message Moss");
  const pingBubbles = drawer.getByText("Ping", { exact: true });

  // Two identical sends: each POST resolves with its own userMessageId, producing two same-kind,
  // same-text "Ping" fallbacks with distinct ids. Neither live echo will carry one.
  await composerInput.fill("Ping");
  await composerInput.press("Enter");
  await expect(drawer.getByText("Reply to Ping")).toHaveCount(1);
  await composerInput.fill("Ping");
  await composerInput.press("Enter");
  await expect(drawer.getByText("Reply to Ping")).toHaveCount(2);
  await expect(pingBubbles).toHaveCount(2);

  // First idless echo arrives: under the old `||` predicate this never matches either
  // id-carrying fallback (undefined !== '<uuid>'), so the echo renders ADDITIONALLY and the count
  // would grow to 3, permanently duplicating the user's own message. It must retire exactly one
  // fallback and leave the count unchanged.
  gate0.resolve();
  await expect(pingBubbles).toHaveCount(2);

  // Second idless echo: the remaining fallback reconciles too. A non-consuming match (checking
  // liveness via `.some()` against all fallbacks) would have let the FIRST echo collapse both
  // fallbacks already-count would already be wrong above; this final check confirms the second
  // send's fallback survived independently and reconciles on its own turn.
  gate1.resolve();
  await expect(pingBubbles).toHaveCount(2);
});

test("renders a large markdown reply without error", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });

  // A reply arrives as ONE whole record (the backend pushes the full reply text; the SSE
  // consumer is append-only and never grows a record token-by-token). This guards that a
  // large markdown body renders correctly in a single parse — the realistic worst case.
  const big = Array.from({ length: 80 }, (_, i) => `## Section ${i}\n\n- item **${i}**`).join(
    "\n\n"
  );
  await streamReply(page, big);

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();

  await expect(drawer.locator(".chatd-md h2")).toHaveCount(80);
  await expect(drawer.locator(".chatd-md li")).toHaveCount(80);
});
