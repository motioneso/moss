import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { signInUatAdmin } from "./real-chat-signin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withApiKeyChatProvider: true
} as const;

// Live proof: asking Moss in chat to always sort a merchant saves a rule with no approval
// prompt, and the chat reply states what was done. Real module install, real model, no
// network interception.
const SHOTS = process.env.JARVIS_UAT_SHOT_DIR ?? "/tmp/finance-rule-proof";

test("chat merchant rule saves without asking and says what it did", async ({ page }) => {
  test.setTimeout(900_000);
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!projectName || !baseURL) throw new Error("UAT env not set by run-uat.ts");

  execFileSync("pnpm", ["build:external:finance"], { stdio: "inherit" });
  execFileSync(
    "docker",
    buildUatComposeArgs(projectName, [
      "cp",
      "external-modules/finance",
      "jarv1s:/data/modules/finance"
    ]),
    { stdio: "inherit" }
  );
  await restartUatStack(projectName, baseURL);

  await signInUatAdmin(page);
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Instance modules" }).click();
  const enableSwitch = page.getByRole("checkbox", { name: "Enable Finance", exact: true });
  await page.locator("label.jds-switch", { has: enableSwitch }).click();
  await expect(enableSwitch).toBeChecked();
  await restartUatStack(projectName, baseURL);

  await page.reload();
  await page.locator('nav[aria-label="Main"]').getByRole("link", { name: "Finance" }).click();
  await expect(page).toHaveURL(/\/m\/finance/);
  await page.screenshot({ path: `${SHOTS}/0-finance.png` });

  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  const turn = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/chat/turn",
    { timeout: 300_000 }
  );
  const ask = "Please always put Blue Bottle Coffee in the Dining & coffee category from now on.";
  await drawer.getByLabel("Message Moss").fill(ask);
  await drawer.getByLabel("Message Moss").press("Enter");
  const body = (await (await turn).json()) as { reply?: string };
  console.log(`[finance-rule reply] ${JSON.stringify(body.reply)}`);
  await page.waitForTimeout(2_000);
  await page.screenshot({ path: `${SHOTS}/1-chat-reply.png` });

  // No approval card was raised.
  await expect(drawer.getByRole("button", { name: /^(Approve|Allow)/ })).toHaveCount(0);
  const reply = body.reply ?? "";
  expect(reply).toMatch(/blue bottle/i);
  expect(reply).toMatch(/dining/i);
  expect(reply).toMatch(/future|automatic/i);
  expect(reply).toMatch(/no existing|not changed|unchanged|weren't changed|were not changed/i);
  expect(reply).toMatch(/settings|undo|activity|merchant rules/i);
});
