// tests/uat/specs/1883-vault-search-dependency-failure.uat.spec.ts
//
// #1883 live-path proof: when the embedding provider notes.search depends on cannot be reached,
// the assistant must show the user a plain, fixed message instead of the raw MCP error text, and
// that raw text (upstream_connection_refused / ECONNREFUSED / fetch failed / the closed host and
// port) must never reach the visible chat transcript. This chat script runs with
// JARVIS_EMBED_PROVIDER=local and a NODE_OPTIONS preload (tests/uat/fixtures/embedding-refused.mjs)
// that points the real embedding library at a closed local port, so notes.search hits a real
// connection failure, not a simulated one. The scripted chat provider only advances past the tool
// call once it has checked the MCP result against the fixture's exact expectedError string
// (tests/uat/fixtures/scripted-provider/claude-main.ts) — so a passing run here is proof the real
// failure was classified correctly, not just that the assistant said something safe.
//
// No action-audit assertion: notes.search is a read tool, and the gateway's audit recording
// (packages/ai/src/gateway/gateway.ts, the "run" branch around its `risk !== "read"` check) only
// runs for non-read tools — a read tool never gets an audit row on this path at all, regardless of
// outcome. Confirmed while building this spec and ruled on by the coordinator: no product logging
// or test-only audit seam should be added just to give this spec something to poll. The chat
// transcript is the only live-path proof surface here.
//
// withoutNewsJsonBinding: true is load-bearing, not cosmetic (same reasoning as
// tests/uat/specs/1533-chat-surface-live-path.uat.spec.ts's own header): admin+data's default
// seedAiProviderChunk creates a second active admin-owned assistant provider for the News JSON
// binding, which combined with this spec's own scripted-chat provider leaves two active providers
// and no default, so chat has no usable model and Enter never sends a turn at all.
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "1883-vault-search-dependency-failure"
} as const;

const CHAT_MESSAGE = "Please search my notes for UAT-1883-VAULT-SEARCH.";
const SAFE_REPLY = "I couldn't search your notes right now - that service looks unavailable.";
// The exact raw-detail strings that must never reach the visible chat transcript.
const LEAKED_DETAIL_MARKERS = [
  "upstream_connection_refused",
  "ECONNREFUSED",
  "fetch failed",
  "127.0.0.1:65534"
];

async function signIn(page: Page): Promise<void> {
  await page.goto(process.env.JARVIS_UAT_BASE_URL ?? "");
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();
}

test("a real vault-search dependency failure shows a safe reply and never leaks the raw error (#1883)", async ({
  page
}) => {
  test.setTimeout(300_000);

  await test.step("sign in", async () => {
    if (!process.env.JARVIS_UAT_BASE_URL) {
      throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
    }
    await signIn(page);
  });

  await test.step("ask the assistant to search notes", async () => {
    await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
    const composer = page.getByRole("textbox", { name: /^Message/ });
    await composer.fill(CHAT_MESSAGE);
    await composer.press("Enter");
  });

  await test.step("the assistant replies with the fixed, safe message", async () => {
    // The scripted provider only reaches this reply after checking the real MCP result against
    // the fixture's exact expectedError string — a failure there fails the run before this point.
    await expect(
      page.getByText(SAFE_REPLY),
      "the assistant's fixed safe reply must reach the chat transcript"
    ).toBeVisible({ timeout: 60_000 });
  });

  await test.step("no raw error detail is anywhere in the visible chat", async () => {
    const chatText = (await page.locator("body").innerText()) ?? "";
    for (const marker of LEAKED_DETAIL_MARKERS) {
      expect(chatText, `raw error detail "${marker}" must not be visible in chat`).not.toContain(
        marker
      );
    }
  });
});
