import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1133 — chat attachments against a real, prod-shaped instance (no mocks: the upload below
// writes real bytes into the seeded owner's vault via POST /api/chat/attachments, and the turn
// hits the real /api/chat/turn validator).
//
// SCOPE NOTE: the UAT harness has no chat-capable AI provider at any seed level (the only
// seeded provider is a fake one bound solely to module.news — see
// runtime-context.uat.spec.ts's file header; gap tracked in #1121). So a real model can never
// answer the turn here. This file proves everything deterministically observable without a
// model reply: the real upload round-trip (201 + server-issued UUID + byte-accurate metadata),
// the composer chip lifecycle, the turn body carrying the id, and the real server's
// unsupported-type rejection. The engine-side read (`chat.readAttachment` manifest + media
// pass-through) is proven by tests/unit/chat-attachment-tool.test.ts and
// tests/integration/chat-attachments-turn.test.ts; the full model-reads-the-file exchange is
// deferred to #1121's scriptable chat engine (fixme below).
export const uatLevel = { level: "solo-admin", without: [] } as const;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }
  return baseURL;
}

// Mirrors runtime-context.uat.spec.ts's signIn(): `solo-admin` seeds return before the
// onboarding chunk, so login can land on the first-run wizard — skip it only when shown, so
// this stays idempotent across the shared, non-reset UAT DB.
async function signIn(page: Page) {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  // Scoped to the form: the auth-mode segmented control has its own "Sign in" tab button
  // with the same accessible name as the submit button.
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
  await drawer.getByRole("button", { name: "Send" }).click();

  // The turn body carries the server-issued id (never bytes) into the REAL /turn handler.
  // Its attachment gates (UUID shape, ownership resolution, incognito, count cap) all sit
  // BEFORE engine dispatch, so passing them and reaching the no-model rejection proves the
  // wiring end-to-end minus the model itself.
  await expect
    .poll(() => turnBody)
    .toEqual({
      text: "Please read this file.",
      attachmentIds: [attachment.id]
    });

  // No chat-capable model is seeded (see file header), so the deterministic terminal state is
  // the connect-a-provider empty state — same anchor runtime-context.uat.spec.ts asserts.
  // `.first()`: the drawer renders this copy twice at once (thread area + composer).
  await expect(page.getByText("Connect a provider to start chatting").first()).toBeVisible();

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

// #1121: the full exchange — model receives the <attachments> manifest, calls
// chat.readAttachment, and answers about the file's content — needs a real (or scriptable)
// chat-capable engine, which no UAT seed level provisions. The tool read path is proven at
// unit level (tests/unit/chat-attachment-tool.test.ts: text render+cap, image media
// pass-through, ownership) and the manifest/turn wiring by
// tests/integration/chat-attachments-turn.test.ts. Deferred until #1121 lands.
test.fixme("model reads an attached file and answers about its content (#1121)", async () => {});
