import { expect, test, type Locator } from "@playwright/test";

import { createMockAiModel } from "./mock-ai-api.js";
import { createMockChatMessage, createMockChatThread } from "./mock-chat-api.js";
import { createMockConnectorProviders } from "./mock-api.js";
import { mockApi } from "./mock-chat-model.js";

/** Opens the "More chat options" menu, picks one item, and leaves the menu closed (it closes itself). */
async function pickChatMenuItem(drawer: Locator, name: string) {
  await drawer.getByRole("button", { name: "More chat options" }).click();
  await drawer.getByRole("menuitemcheckbox", { name }).click();
}

async function openConversations(drawer: Locator) {
  await drawer.getByRole("button", { name: "Open conversations" }).click();
}

async function startNewSideChat(drawer: Locator) {
  await openConversations(drawer);
  await drawer.getByRole("button", { name: "New side chat" }).click();
}

/** Opens the menu, checks the private item's state, and closes the menu again. */
async function expectPrivateChecked(drawer: Locator, checked: boolean) {
  await drawer.getByRole("button", { name: "More chat options" }).click();
  await expect(
    drawer.getByRole("menuitemcheckbox", { name: /^(Start|Leave) private chat$/ })
  ).toHaveAttribute("aria-checked", String(checked));
  await drawer.page().keyboard.press("Escape");
  await expect(drawer.getByRole("menu")).toHaveCount(0);
}

/**
 * Live chat drawer E2E.
 *
 * What is mocked:
 *  - The full REST surface via mockApi (auth/me/modules/etc.).
 *  - POST /api/chat/turn → { reply } (the drawer ignores this body; the stream renders).
 *  - POST /api/chat/clear → 204 for the "New side chat" action.
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

  // "New side chat" clears the transcript. (Assert the streamed records are gone rather than a
  // specific empty-state copy: since v0.1.4 the empty state is onboarding-gated and shows the
  // connect-a-provider explainer when no provider is configured, as in this mock.)
  await startNewSideChat(drawer);
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
  await pickChatMenuItem(drawer, "Start private chat");

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

  await expectPrivateChecked(drawer, true);
});

test("a focus refetch during a pending private close does not restore the closed banner early, and a failed close is restored afterwards", async ({
  page
}) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    incognito: true
  });

  // The server's privacy answer throughout this test: still private, until the test flips it
  // once the held-open close request is released.
  let serverIncognito = true;
  // Match by pathname, not a glob string: the drawer's privacy GET carries a `?surface=...`
  // query string (see the comment in mock-chat-api.ts), which a plain "**/api/chat/privacy"
  // glob does not match.
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/privacy"),
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ incognito: serverIncognito })
      });
    }
  );

  // Hold the close request open until the test releases it, so a focus event can be dispatched
  // while the close is still in flight -- the scenario the spec locks in for this child issue.
  let releaseEnd: ((status: number) => void) | undefined;
  const endGate = new Promise<number>((resolve) => {
    releaseEnd = resolve;
  });
  await page.route(
    (url) => url.pathname.endsWith("/api/chat/private/end"),
    async (route) => {
      const status = await endGate;
      if (status >= 200 && status < 300) {
        await route.fulfill({ status, body: "" });
        return;
      }
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({ error: "Could not end private chat" })
      });
    }
  );

  // The shared mock's SSE stream closes after one heartbeat, which fires EventSource.onerror
  // and would end the private session before this test gets to the close/refetch it cares
  // about (see the identical comment on the "private activation blocks send..." test above).
  await page.route("**/api/chat/stream*", () => new Promise<void>(() => {}));

  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();

  const privateBanner = drawer.locator(".chatd-private").filter({ hasText: "not saved" });
  await expect(privateBanner).toBeVisible();

  await privateBanner.getByRole("button", { name: "End" }).click();

  // Optimistic UI: the private banner disappears immediately, before the close request settles.
  await expect(privateBanner).toHaveCount(0);

  // Dispatch a browser focus event while the close is still pending. The closing guard must
  // keep any refetch this triggers from restoring the banner early -- whether or not the
  // dispatch itself reaches the network is not asserted here (see the plan's notes on
  // refetchOnWindowFocus wiring); what matters is that the banner does not come back before the
  // close settles.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(privateBanner).toHaveCount(0);

  // Release the close as a failure: the server never actually ended the private session.
  serverIncognito = true;
  releaseEnd?.(500);

  // The failure surfaces instead of staying silent, and the invalidate-driven refetch restores
  // the private banner instead of leaving the UI stuck on the optimistic "closed" state.
  await expect(drawer.locator(".chatd-private.is-error")).toBeVisible();
  await expect(privateBanner).toBeVisible();
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

  await expect(drawer.getByText("Tick 2")).toBeVisible({ timeout: 10_000 });
  await expect(queuedChip).toContainText('Next: "Drained queued"');
  await composerAction.click();
  await expect.poll(() => turnTexts).toEqual(["First question", "Drained queued"]);
  expect(cancelRequests).toBe(1);
  await expect(drawer.getByText(/Next:/)).toHaveCount(0);
  await expect(drawer.getByText("Drained queued", { exact: true })).toHaveCount(1);
});

test("selecting a side chat both opens and activates it — no separate resume step", async ({
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
  await openConversations(drawer);
  await drawer.getByText("Old chat").click();

  await expect.poll(() => resumeCalledWith).toBe("thread-old");
  await expect(drawer.locator(".chatd-conversations__overlay")).toHaveCount(0);
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
// filters `incognito = false`) side chat while a private session is active must
// invalidate the stale client-side `privateMode` flag. Before the fix, resumeMutation's
// onSuccess never touched `privateMode`/`privateEnded`, so once the user sent a message in
// the resumed thread (flipping `reviewing` back to false) the "not saved" private banner and
// the shield toggle's pressed state kept lying about a thread that IS being saved.
test("resuming a side chat while private clears the stale privateMode flag", async ({ page }) => {
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

  // Sanity: private mode really is active before the resume (server-truth restore, #1036).
  await expectPrivateChecked(drawer, true);

  await openConversations(drawer);
  await drawer.getByText("Old chat").click();
  await expect(drawer.getByText("Earlier context")).toBeVisible();

  // The stale privateMode flag from before the resume must already be gone — the resumed
  // thread is persisted (non-incognito), so the shield toggle must not show pressed.
  await expectPrivateChecked(drawer, false);

  const composer = drawer.getByLabel("Message Moss");
  await composer.fill("Continue here");
  await composer.press("Enter");
  await expect(drawer.getByText("Continued")).toBeVisible();

  // `reviewing` flips false once a message is sent in the resumed thread — this is exactly
  // where the stale flag used to surface the "not saved" banner on a now-persisted thread.
  await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toHaveCount(0);
});

test("resume failure clears selection and reopens conversations", async ({ page }) => {
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
  await openConversations(drawer);
  await drawer.getByText("Old chat").click();

  await expect(drawer.locator(".chatd-conversations__overlay")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Old chat" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
});

test("conversations overlay keeps the covered drawer background inert while open", async ({
  page
}) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [
      {
        id: "thread-old",
        ownerUserId: "user-1",
        title: "Old chat",
        incognito: false,
        isMain: false,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
        lastActiveAt: "2026-07-01T00:00:00.000Z",
        lastMessagePreview: null
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
  await openConversations(drawer);

  await expect(drawer.locator(".chatd-empty")).toHaveCount(1);
  await expect(drawer.locator(".chatd__body[inert]")).toHaveCount(1);
  await expect(drawer.locator(".chatd-overlay-background[inert]")).toHaveCount(3);
  await expect(drawer.locator(".chatd-conversations__overlay")).toBeVisible();
});

test("empty conversations explains how to start a side chat", async ({ page }) => {
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
  await openConversations(drawer);

  await expect(drawer.getByText("Start a side chat to keep a topic together.")).toBeVisible();
  await expect(drawer.locator(".chatd-empty")).toHaveCount(1);
});

test("conversations overlay covers the docked chat panel only at desktop width (#3282)", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
  await expect(drawer).toHaveClass(/chatd--docked/);
  await openConversations(drawer);
  const overlay = drawer.locator(".chatd-conversations__overlay");
  await expect(overlay).toBeVisible();

  const panel = (await drawer.boundingBox())!;
  const box = (await overlay.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(panel.x - 1);
  expect(box.y).toBeGreaterThanOrEqual(panel.y - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(panel.y + panel.height + 1);

  // The page beside the panel stays uncovered.
  const besidePanel = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest(".chatd-conversations__overlay"),
    { x: panel.x / 2, y: panel.y + panel.height / 2 }
  );
  expect(besidePanel).toBeNull();

  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "Open conversations" })).toBeFocused();
  await expect(drawer.locator(".chatd-overlay-background[inert]")).toHaveCount(0);

  // A click on the page beside the panel still dismisses the open overlay.
  await openConversations(drawer);
  await expect(overlay).toBeVisible();
  await expect(drawer.locator(".chatd-overlay-background[inert]").first()).toBeAttached();
  await page.mouse.click(panel.x / 2, panel.y + panel.height / 2);
  await expect(overlay).toHaveCount(0);
});
