import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import {
  bringUpRealChatModel,
  readUatJson,
  requireUatBaseURL,
  requireUatProjectName,
  signInUatAdmin
} from "./real-chat-signin.js";

export const uatLevel = { level: "solo-admin", without: [] } as const;

async function openChat(page: Page) {
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  return drawer;
}

test("real caller remains editable and recoverable through provider disable and restore (#3191)", async ({
  page
}) => {
  test.setTimeout(600_000);
  expect(process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED).toBe("1");
  const project = requireUatProjectName();
  const baseURL = requireUatBaseURL();
  // Install the unchanged checkout package through the existing disposable UAT activation path.
  execFileSync("pnpm", ["build:external:finance"], { stdio: "inherit" });
  execFileSync(
    "docker",
    buildUatComposeArgs(project, [
      "cp",
      "external-modules/finance",
      "jarv1s:/data/modules/finance"
    ]),
    { stdio: "inherit" }
  );
  await restartUatStack(project, baseURL);
  await signInUatAdmin(page);
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Instance modules" }).click();
  const enable = page.getByRole("checkbox", { name: "Enable Finance", exact: true });
  await expect(enable).not.toBeChecked();
  await page.locator("label.jds-switch", { has: enable }).click();
  await expect(enable).toBeChecked();
  await restartUatStack(project, baseURL);
  await page.reload();
  const model = await bringUpRealChatModel(page);
  expect(model.tier).toBe("economy");
  const providers = (await readUatJson(await page.request.get("/api/ai/providers"))) as {
    providers: readonly { id: string; status: string }[];
  };
  const active = providers.providers.filter((provider) => provider.status === "active");
  expect(active.length).toBeGreaterThan(0);

  let drawer = await openChat(page);
  const original = "UAT 3191 saved unsent Main draft. Reply briefly when I send this.";
  const edited = "UAT 3191 recovered Main draft. Reply briefly: draft recovered.";
  const seedCompleted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/chat/turn",
    { timeout: 120_000 }
  );
  await drawer
    .getByLabel("Message Moss")
    .fill("UAT 3191. Reply briefly: ready for draft recovery.");
  await drawer.getByLabel("Message Moss").press("Enter");
  const seed = (await readUatJson(await seedCompleted)) as { reply: string };
  expect(seed.reply.trim().length).toBeGreaterThan(0);
  await expect(drawer.getByText(seed.reply, { exact: true }).last()).toBeVisible();
  await drawer.getByRole("button", { name: "Close chat" }).click();
  await page.locator('nav[aria-label="Main"]').getByRole("link", { name: "Finance" }).click();
  await page.getByRole("button", { name: "Connect with your assistant" }).click();
  drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer.getByLabel("Message Moss")).toHaveValue("Connect my bank account");
  await drawer.getByLabel("Message Moss").fill(original);
  const threads = (await readUatJson(
    await page.request.get("/api/chat/threads?surface=drawer")
  )) as {
    threads: readonly { id: string; isMain: boolean }[];
  };
  const main = threads.threads.find((thread) => thread.isMain);
  expect(main).toBeDefined();

  try {
    for (const provider of active) {
      await readUatJson(
        await page.request.patch(`/api/ai/providers/${provider.id}`, {
          data: { status: "disabled" }
        })
      );
    }
    const unavailable = (await readUatJson(
      await page.request.get("/api/ai/capability-route/chat")
    )) as { route: { available: boolean } };
    expect(unavailable.route.available).toBe(false);
    // A reload reads persisted configuration and the actual saved draft, without response rewriting.
    await page.reload();
    drawer = await openChat(page);
    await expect(drawer.getByText("Not connected", { exact: true })).toBeVisible();
    await expect(drawer.getByLabel("Message Moss")).toHaveValue(original);
    await expect(drawer.getByLabel("Message Moss")).toBeEnabled();
    await drawer.getByLabel("Message Moss").fill("");
    await expect(drawer.getByLabel("Message Moss")).toHaveCount(0);
    await expect(
      drawer.getByRole("link", { name: "Connect a provider", exact: true })
    ).toBeVisible();
    await drawer.getByRole("button", { name: "Close chat" }).click();
    let callerTurns = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/chat/turn") {
        callerTurns += 1;
      }
    });
    await page.getByRole("button", { name: "Connect with your assistant" }).click();
    await expect(drawer.getByLabel("Message Moss")).toHaveValue("Connect my bank account");
    await expect(drawer.getByLabel("Message Moss")).toBeEnabled();
    expect(callerTurns).toBe(0);
    await drawer.getByLabel("Message Moss").fill(edited);
    await page.reload();
    drawer = await openChat(page);
    await expect(drawer.getByLabel("Message Moss")).toHaveValue(edited);
    console.log(
      "[3191 assertion] real Finance caller supplied unsent editable text while persisted providers were disabled; explicit clear won and edited Main draft recovered after reload"
    );
  } finally {
    for (const provider of active) {
      await readUatJson(
        await page.request.patch(`/api/ai/providers/${provider.id}`, {
          data: { status: "active" }
        })
      );
    }
  }

  await page.reload();
  drawer = await openChat(page);
  await expect(drawer.getByLabel("Message Moss")).toHaveValue(edited);
  const completed = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/chat/turn",
    { timeout: 120_000 }
  );
  await drawer.getByLabel("Message Moss").press("Enter");
  const response = await completed;
  const result = (await readUatJson(response)) as { reply: string };
  expect(result.reply.trim().length).toBeGreaterThan(0);
  await expect(drawer.getByText(result.reply, { exact: true }).last()).toBeVisible();
  const history = (await readUatJson(
    await page.request.get(`/api/chat/threads/${main!.id}/messages?surface=drawer`)
  )) as { messages: readonly { body: string }[] };
  expect(history.messages.filter((message) => message.body === edited)).toHaveLength(1);
  expect(history.messages.some((message) => message.body === original)).toBe(false);
  expect(history.messages.some((message) => message.body === "Connect my bank account")).toBe(
    false
  );
  console.log(
    "[3191 assertion] restored configured economy provider completed the edited draft once in its original Main"
  );
});
