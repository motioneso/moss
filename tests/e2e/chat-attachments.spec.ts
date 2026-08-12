import { expect, test, type Page } from "@playwright/test";

import { createMockConnectorProviders, mockApi } from "./mock-api.js";

/**
 * #1133 — chat composer attachments (attach button + clipboard paste).
 *
 * What is mocked (same layer as chat-drawer.spec.ts):
 *  - The full REST surface via mockApi.
 *  - POST /api/chat/attachments → 201 { attachment } echoing the request's declared
 *    mime/name/size, mirroring packages/chat/src/attachments-routes.ts's real response shape.
 *  - POST /api/chat/turn → captured body + a canned reply (the fallback-records path).
 *  - GET /api/chat/stream → held open with an EMPTY body, so every rendered record comes
 *    from the drawer's own optimistic/fallback path — the surface under test here.
 *
 * The real-network halves (a real vault write behind the upload, the turn body reaching the
 * real /turn validator) are proven on the #1000 harness by
 * tests/uat/specs/1133-chat-attachments.uat.spec.ts.
 */

const UPLOAD_ID = "11111111-1111-4111-8111-111111111111";

type CapturedUpload = { readonly mime: string; readonly name: string; readonly bytes: number };

/** Mock the upload endpoint like the real route: 201 + { attachment } from the headers. */
async function mockUpload(page: Page, uploads: CapturedUpload[]) {
  await page.route("**/api/chat/attachments", async (route) => {
    const request = route.request();
    const mime = request.headers()["x-jarvis-mime-type"] ?? "";
    const name = decodeURIComponent(request.headers()["x-jarvis-file-name"] ?? "");
    const bytes = request.postDataBuffer()?.length ?? 0;
    uploads.push({ mime, name, bytes });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        attachment: { id: UPLOAD_ID, fileName: name, mimeType: mime, sizeBytes: bytes }
      })
    });
  });
}

/** Hold the SSE stream open with no records so the fallback path renders everything. */
async function holdStreamEmpty(page: Page) {
  await page.route("**/api/chat/stream*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache" },
      body: ""
    })
  );
}

async function openDrawer(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  return drawer;
}

test("attaching a file shows a ready chip and sends its id with the turn (#1133)", async ({
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
  await holdStreamEmpty(page);
  const uploads: CapturedUpload[] = [];
  await mockUpload(page, uploads);

  let turnBody: unknown;
  await page.route("**/api/chat/turn", async (route) => {
    turnBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        reply: "Looked at it",
        userMessageId: "user-1",
        assistantMessageId: "assistant-1"
      })
    });
  });

  const drawer = await openDrawer(page);

  // The visible paperclip button proxies a visually-hidden real <input type=file> —
  // setInputFiles drives the input directly (a native picker can't be automated).
  await drawer.locator(".chatd-attach__input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello attachment") // 16 bytes
  });

  const chip = drawer.locator(".chatd-attach__row .chatd-attach__chip");
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".chatd-attach__name")).toHaveText("notes.txt");
  // Ready state: the meta slot flips from "uploading…" to the formatted size and the
  // uploading modifier drops — only ready chips become sendable DTOs.
  await expect(chip.locator(".chatd-attach__meta")).toHaveText("16 B");
  await expect(chip).not.toHaveClass(/is-uploading/);
  expect(uploads).toEqual([{ mime: "text/plain", name: "notes.txt", bytes: 16 }]);

  const composerInput = drawer.getByLabel("Message Moss");
  await composerInput.fill("Look at this file");
  await composerInput.press("Enter");

  // The turn carries the server-issued attachment id, not the bytes. ChatDrawer now always
  // threads its surface through send routing (#1533), so the turn body carries `surface`.
  await expect
    .poll(() => turnBody)
    .toEqual({
      text: "Look at this file",
      attachmentIds: [UPLOAD_ID],
      surface: "drawer"
    });

  // Pending chips clear on send; the sent bubble re-renders the attachment as a sent chip.
  await expect(drawer.locator(".chatd-attach__row")).toHaveCount(0);
  const sentChips = drawer.locator(".chatd-attach__sent .chatd-attach__chip");
  await expect(sentChips).toHaveCount(1);
  await expect(sentChips.locator(".chatd-attach__name")).toHaveText("notes.txt");
  await expect(drawer.getByText("Looked at it")).toBeVisible();
});

test("pasting an image stages it as a pending chip (#1133)", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  await holdStreamEmpty(page);
  const uploads: CapturedUpload[] = [];
  await mockUpload(page, uploads);

  const drawer = await openDrawer(page);

  // Synthesize a clipboard paste carrying an image file onto the composer textarea —
  // Playwright has no native clipboard-image API, and this exercises the same React
  // onPaste handler a real Ctrl+V hits.
  await drawer.getByLabel("Message Moss").evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "screen.png", { type: "image/png" })
    );
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
    );
  });

  const chip = drawer.locator(".chatd-attach__row .chatd-attach__chip");
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".chatd-attach__name")).toHaveText("screen.png");
  await expect(chip.locator(".chatd-attach__meta")).toHaveText("4 B");
  expect(uploads).toEqual([{ mime: "image/png", name: "screen.png", bytes: 4 }]);
});

test("a failed upload marks the chip and keeps it out of the send (#1133)", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: []
  });
  await holdStreamEmpty(page);
  await page.route("**/api/chat/attachments", (route) =>
    route.fulfill({
      status: 415,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unsupported attachment type: text/plain" })
    })
  );
  let turnBody: unknown;
  await page.route("**/api/chat/turn", async (route) => {
    turnBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ reply: "ok", userMessageId: "u1", assistantMessageId: "a1" })
    });
  });

  const drawer = await openDrawer(page);
  await drawer.locator(".chatd-attach__input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("x")
  });

  const chip = drawer.locator(".chatd-attach__row .chatd-attach__chip");
  await expect(chip).toHaveClass(/is-error/);
  await expect(chip.locator(".chatd-attach__meta")).toHaveText("failed");

  // Errored chips never become DTOs — the turn goes out text-only, without attachmentIds.
  const composerInput = drawer.getByLabel("Message Moss");
  await composerInput.fill("just text");
  await composerInput.press("Enter");
  // ChatDrawer now always threads its surface through send routing (#1533).
  await expect.poll(() => turnBody).toEqual({ text: "just text", surface: "drawer" });
});

test("private mode hides the attach affordance (#1133)", async ({ page }) => {
  await mockApi(page, {
    authenticated: true,
    chatThreads: [],
    connectorAccounts: [],
    connectorProviders: createMockConnectorProviders(),
    notifications: [],
    tasks: [],
    // Server truth on mount: a private session is active — attachments are persistent
    // vault writes, so the whole affordance disappears (the server also rejects, 400).
    incognito: true
  });
  await page.route("**/api/chat/stream*", () => new Promise<void>(() => {}));

  const drawer = await openDrawer(page);
  await expect(drawer.getByRole("button", { name: "Start private chat" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(drawer.getByRole("button", { name: "Attach files" })).toHaveCount(0);
  await expect(drawer.locator(".chatd-attach__input")).toHaveCount(0);
});
