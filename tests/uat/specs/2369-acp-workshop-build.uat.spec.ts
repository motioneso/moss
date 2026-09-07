import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// #2369 slice 1 phase 5 (closes #2369): the slice live-path proof — a real
// project, a real build command through the outside agent, and a real approval
// card answered by a person, end to end on dev.
//
// Preconditions owned by the harness: the dev runner is up with the socket
// path configured, and the household Claude login is stored so the adapter can
// launch. Without the login the turn fails closed (no reply, no card) and this
// spec fails saying so instead of hanging.
export const uatLevel = { level: "solo-admin", without: [] } as const;

test("Workshop build through the outside agent with an answered approval card", async ({
  page
}) => {
  test.setTimeout(180_000);
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL || !process.env.JARVIS_UAT_PROJECT_NAME?.startsWith("uat-")) {
    throw new Error("Run through the isolated UAT provisioner");
  }
  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  await expect(skip.or(page.locator(".jds-usermenu__trigger")).first()).toBeVisible({
    timeout: 30_000
  });
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }

  // Pick the outside agent through the real admin control, not the API.
  await page.goto(`${baseURL}/settings?section=aiproviders`);
  const agentSelect = page.getByLabel("Agent for Workshop builds", { exact: true });
  await expect(agentSelect).toBeVisible({ timeout: 30_000 });
  await agentSelect.selectOption({ label: "Claude Code (outside agent)" });
  await expect(page.getByText("Agent choice saved")).toBeVisible({ timeout: 15_000 });

  // A real project with a real first message.
  await page.getByRole("link", { name: "The Workshop", exact: true }).click();
  await page.getByRole("link", { name: "New project", exact: true }).click();
  await page.getByLabel("Your idea", { exact: true }).fill("Prove the outside build agent works.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Prove the outside build agent works.", { exact: true })).toBeVisible(
    {
      timeout: 60_000
    }
  );

  // Ask for one trivial build. The save stays open while the agent works.
  const startedAt = Date.now();
  await page
    .getByLabel("Add to your project")
    .fill("Please run the command `echo acp-proof-ok` as a build and tell me what it showed.");
  await page.getByRole("button", { name: "Send", exact: true }).click();

  // The approval card lands in the project conversation itself, carrying the
  // whole command and the sandbox sentence. Answer it there like a person would.
  const conversation = page.getByRole("region", { name: "Project conversation" });
  const card = conversation.getByRole("region", { name: "Action request" });
  try {
    await card.waitFor({ timeout: 120_000 });
  } catch {
    throw new Error(
      "Approval card never appeared: the outside agent did not start (household Claude " +
        "login missing on the runner?) or the turn died before its first tool call. Failing " +
        "here loudly, as this spec promises, instead of timing out on a later step."
    );
  }
  await expect(card).toContainText("echo acp-proof-ok");
  await expect(card).toContainText("not sandboxed");
  // Moss reply bubbles carry the avatar; the person's own bubbles do not. The
  // person's message also contains the command words, so a bare text search
  // passes whether or not the build ever ran — count the agent's bubbles.
  const replies = conversation.locator(".chatd-msg:not(.chatd-msg--me)");
  const repliesBefore = await replies.count();
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByText("Approved")).toBeVisible({ timeout: 30_000 });

  // The reply lands in the project feed once the turn finishes: one more Moss
  // bubble, and it answers with what the command showed rather than echoing
  // the person's own words back.
  await page.reload();
  await expect
    .poll(async () => replies.count(), { timeout: 120_000 })
    .toBeGreaterThan(repliesBefore);
  const lastReply = replies.last();
  await expect(lastReply).toContainText("acp-proof-ok");
  await expect(lastReply).not.toContainText("Please run the command");
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(`workshop outside-agent build proof took ${seconds}s`);
});
