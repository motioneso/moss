import { expect, test, type Page } from "@playwright/test";
import type { ListChatThreadMessagesResponse } from "@moss/shared";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { bringUpRealChatModel, readUatJson } from "./real-chat-signin.js";

// #1133 — chat attachments against a real, prod-shaped instance (no mocks: the upload below
// writes real bytes into the seeded owner's vault via POST /api/chat/attachments, and the turn
// hits the real /api/chat/turn validator).
//
// The turn gets its reply from the scripted chat model (fixture
// chat-scripts/1133-chat-attachments.json). It is set up the same way as
// 1533-chat-surface-live-path.uat.spec.ts, so the drawer always has a usable chat model and the
// composer, with its attach control, stays up for the whole test.
//
// This file proves: the real upload round-trip (201 + server-issued UUID + byte-accurate
// metadata), the composer chip lifecycle, the turn body carrying the id, the scripted reply, and
// the real server's unsupported-type rejection. The engine-side read (`chat.readAttachment`
// manifest + media pass-through) is proven by tests/unit/chat-attachment-tool.test.ts and
// tests/integration/chat-attachments-turn.test.ts.
export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "1133-chat-attachments"
} as const;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

// Skips the first-run wizard only when it shows, so this stays idempotent across the shared,
// non-reset UAT DB.
async function signIn(page: Page) {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  // Scoped to the form: the auth-mode segmented control has its own "Sign in" tab button
  // with the same accessible name as the submit button.
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
  if (process.env.JARVIS_UAT_REQUIRE_REAL_CHAT) {
    test.setTimeout(300_000);
    await bringUpRealChatModel(page);
  }
}

const FILE_BODY = "attachment uat proof body"; // 25 bytes
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("attaching a file really uploads to the vault and the turn carries its id (#1133)", async ({
  page
}) => {
  await signIn(page);

  let turnBody: unknown;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/chat/turn")) {
      turnBody = request.postDataJSON();
    }
  });

  // Name-agnostic: the accessible name is `Chat with ${assistantName}` (persona-driven, not a
  // fixed literal), so these locate by stable DOM handles instead — .topbar-actions holds
  // exactly one button (the chat toggle), and aside.chatd is the drawer element itself.
  await page.locator(".topbar-actions button").click();
  const drawer = page.locator("aside.chatd");
  await expect(drawer).toBeVisible();
  // A fresh chat per run: a reopened chat resumes the scripted conversation at a later turn.
  await drawer.getByRole("button", { name: "Open conversations" }).click();
  await drawer.getByRole("button", { name: "New side chat", exact: true }).click();

  // Drive the visually-hidden real <input type=file> directly — the paperclip button only
  // proxies a click to it, and a native picker can't be automated.
  const uploadResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/chat/attachments") && response.request().method() === "POST"
  );
  await drawer.locator(".chatd-attach__input").setInputFiles({
    name: "uat-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(FILE_BODY)
  });

  // Real server round-trip: 201 + a server-issued UUID + byte-accurate metadata proves the
  // bytes landed in the owner's vault store (packages/chat/src/attachments-routes.ts).
  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.status()).toBe(201);
  const { attachment } = (await uploadResponse.json()) as {
    attachment: { id: string; fileName: string; mimeType: string; sizeBytes: number };
  };
  expect(attachment.id).toMatch(UUID_RE);
  expect(attachment.fileName).toBe("uat-note.txt");
  expect(attachment.mimeType).toBe("text/plain");
  expect(attachment.sizeBytes).toBe(FILE_BODY.length);

  // Chip lifecycle: uploading… → ready (formatted size), never error.
  const chip = drawer.locator(".chatd-attach__row .chatd-attach__chip");
  await expect(chip).toHaveCount(1);
  await expect(chip.locator(".chatd-attach__name")).toHaveText("uat-note.txt");
  await expect(chip.locator(".chatd-attach__meta")).toHaveText(`${FILE_BODY.length} B`);
  await expect(chip).not.toHaveClass(/is-error/);

  await drawer.locator(".chatd-input textarea").fill("Please read this file.");
  const turnResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/api/chat/turn"),
    { timeout: 120_000 }
  );
  await drawer.getByRole("button", { name: "Send" }).click();

  // The turn body carries the server-issued id (never bytes) into the real /turn handler.
  // That handler checks each id and the private-chat rule before the model runs.
  await expect
    .poll(() => turnBody)
    .toEqual({
      text: "Please read this file.",
      attachmentIds: [attachment.id],
      surface: "drawer"
    });

  // The scripted reply proves the turn reached the engine and the answer came back to the drawer.
  // The first turn in a chat starts the scripted provider cold, which takes several seconds, so
  // this waits longer than the default 10s.
  const body = (await readUatJson(await turnResponse)) as { reply: string };
  if (process.env.JARVIS_UAT_REQUIRE_REAL_CHAT) {
    expect(body.reply.trim()).not.toBe("");
    await expect(
      drawer.locator(".chatd-msg:not(.chatd-msg--me) .chatd-bubble").last()
    ).toBeVisible();
  } else {
    expect(body.reply).toBe("Received the attached file.");
    await expect(drawer.getByText("Received the attached file.")).toBeVisible({ timeout: 60_000 });
  }

  // Pending chips cleared on send — the staged upload doesn't linger in the composer.
  await expect(drawer.locator(".chatd-attach__row")).toHaveCount(0);
});

test("the real server rejects an unsupported attachment type with 415 (#1133)", async ({
  page
}) => {
  await signIn(page);

  // The composer's client-side whitelist blocks .zip before any request is made, so to prove
  // the SERVER's own whitelist (the actual security boundary) we call the endpoint directly
  // with the session cookie — same technique as runtime-context.uat.spec.ts's manifest check.
  const result = await page.evaluate(async () => {
    const response = await fetch("/api/chat/attachments", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/octet-stream",
        "x-jarvis-mime-type": "application/zip",
        "x-jarvis-file-name": encodeURIComponent("payload.zip")
      },
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    });
    return { status: response.status, body: (await response.json()) as { error?: string } };
  });
  expect(result.status).toBe(415);
  expect(result.body.error).toContain("Unsupported attachment type");
});

// #3343: only the attachment contains the phrase; a real reply must recover it through the tool.
test("model reads an attached file and answers about its content (#3343)", async ({ page }) => {
  test.skip(!process.env.JARVIS_UAT_REQUIRE_REAL_CHAT, "requires installed real-model proof");
  await signIn(page);
  await page.locator(".topbar-actions button").click();
  const drawer = page.locator("aside.chatd");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Open conversations" }).click();
  await drawer.getByRole("button", { name: "New side chat", exact: true }).click();
  await drawer.locator(".chatd-attach__input").setInputFiles({
    name: "content-proof.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("The validation phrase is cobalt otter 47.")
  });
  await expect(drawer.locator(".chatd-attach__chip")).not.toHaveClass(/is-uploading|is-error/);
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/chat/turn"),
    { timeout: 120_000 }
  );
  await drawer
    .getByLabel("Message Moss")
    .fill("Read the attached file and tell me its validation phrase.");
  await drawer.getByRole("button", { name: "Send", exact: true }).click();
  const body = (await readUatJson(await response)) as { reply: string; assistantMessageId: string };
  expect(body.reply).toContain("cobalt otter 47");
  await expect(drawer.locator(".chatd-msg:not(.chatd-msg--me) .chatd-bubble").last()).toContainText(
    "cobalt otter 47"
  );
  const privacy = (await readUatJson(
    await page.request.get("/api/chat/privacy?surface=drawer")
  )) as { threadId: string };
  const history = (await readUatJson(
    await page.request.get(`/api/chat/threads/${privacy.threadId}/messages?surface=drawer`)
  )) as ListChatThreadMessagesResponse;
  const answer = history.messages.find((message) => message.id === body.assistantMessageId)!;
  expect(answer).toBeDefined();
  expect(
    answer.activity.some(
      (entry) =>
        entry.kind === "tool" &&
        entry.toolName?.includes("readAttachment") &&
        entry.outcome === "executed"
    )
  ).toBe(true);
});
