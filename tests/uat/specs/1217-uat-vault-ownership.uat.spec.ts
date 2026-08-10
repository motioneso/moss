import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #1217 — regression: the compose `seed` service ran as root (no `user:` override, no `USER`
// directive in the Dockerfile), so tests/uat/seed/chunks/notes.ts's vault mkdir
// (VaultContextRunner.withVaultContext, packages/vault/src/vault-context.ts) created the seeded
// actor's vault directory root-owned. start-jarv1s.ts's prepareRuntimeDirs chowns only the
// top-level /data/vaults, and only BEFORE seed ever runs (tests/uat/provisioner.ts starts jarv1s
// before the seed step), so it can never reclaim ownership of content seed creates afterward —
// any later write into that actor's vault (e.g. a chat attachment upload) hit EACCES.
//
// This must run at `admin+data`, NOT `solo-admin`: solo-admin returns before any data chunk runs
// (tests/uat/seed/levels.ts), so it never seeds vault content and the actor's vault dir is
// created lazily by the API itself — already correctly owned — meaning solo-admin never exercises
// this bug at all (1133-chat-attachments.uat.spec.ts is solo-admin for unrelated reasons; do not
// reuse or change its level). Only admin+data/multi-user run seedNotesChunk.
export const uatLevel = { level: "admin+data", without: [] } as const;

const FILE_BODY = "1217 vault ownership regression proof";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// #1112: admin+data seeds the onboarding chunk as complete, so a freshly-logged-in owner lands
// directly on AppShell — no wizard to dismiss.
test("a seeded admin+data actor can upload a chat attachment into their vault (#1217)", async ({
  page
}) => {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  // Scoped to the form: the auth-mode segmented control has its own "Sign in" tab button with
  // the same accessible name as the submit button (apps/web/src/auth/auth-screen.tsx).
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();

  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(userMenu).toBeVisible();

  // Name-agnostic: the accessible name is `Chat with ${assistantName}` (persona-driven, not a
  // fixed literal), so these locate by stable DOM handles instead — .topbar-actions holds
  // exactly one button (the chat toggle), and aside.chatd is the drawer element itself.
  await page.locator(".topbar-actions button").click();
  const drawer = page.locator("aside.chatd");
  await expect(drawer).toBeVisible();

  // Drive the visually-hidden real <input type=file> directly — the paperclip button only
  // proxies a click to it, and a native picker can't be automated (see 1133-chat-attachments).
  const uploadResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/chat/attachments") && response.request().method() === "POST"
  );
  await drawer.locator(".chatd-attach__input").setInputFiles({
    name: "uat-1217-vault-proof.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(FILE_BODY)
  });

  // The real assertion for #1217: writing into this seeded admin+data actor's vault must
  // succeed (201), not fail with a permission error from a root-owned vault directory.
  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.status()).toBe(201);
  const { attachment } = (await uploadResponse.json()) as {
    attachment: { id: string; fileName: string; sizeBytes: number };
  };
  expect(attachment.id).toMatch(UUID_RE);
  expect(attachment.fileName).toBe("uat-1217-vault-proof.txt");
  expect(attachment.sizeBytes).toBe(FILE_BODY.length);
});
