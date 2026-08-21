import { expect, test, type Page } from "@playwright/test";

import { createMockConnectorProviders, mockApi } from "./mock-api.js";

/**
 * Live chat drawer E2E — rendering and reconciliation.
 *
 * Split out of chat-drawer.spec.ts (over the 1000-line file-size gate) once #1521 added a new
 * test there. Covers markdown rendering, message-ordering regressions, and fallback-record
 * reconciliation. See chat-drawer.spec.ts for the mocking notes shared by both files.
 */

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
