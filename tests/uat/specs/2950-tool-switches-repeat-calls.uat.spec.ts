// tests/uat/specs/2950-tool-switches-repeat-calls.uat.spec.ts
//
// #2950: a connection's tool rows carry one on/off switch each, and Moss never blocks an
// integration tool for repeating an identical call. Runs on the real stack with a real MCP tool
// server (the 2b.6 fixture) and the real default chat model. Chat is asked to call the read-only
// listing tool twice with no arguments, and the fixture's own call log must show both calls.
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import {
  FIXTURE_LIST_TOOL,
  CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT,
  classifierMcpFixtureContainerName,
  classifierMcpFixtureEndpointFor,
  type FixtureCall
} from "../fixtures/classifier-mcp-fixture-server.js";
import {
  bringUpRealChatModel,
  requireUatBaseURL,
  requireUatProjectName
} from "./real-chat-signin.js";

export const uatLevel = {
  level: "multi-user",
  without: [],
  withoutNewsJsonBinding: true,
  withClassifierMcpFixture: true
} as const;

const CONNECTION_NAME = "UAT smart hub";
const SHOT_DIR = process.env.UAT_2950_SHOT_DIR ?? "/tmp/design-tool-switches";

function fixtureCalls(): readonly FixtureCall[] {
  const script =
    `fetch("http://127.0.0.1:${CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT}/__control/state")` +
    `.then(r=>r.text()).then(t=>console.log(t))`;
  const out = execFileSync(
    "docker",
    ["exec", classifierMcpFixtureContainerName(requireUatProjectName()), "node", "-e", script],
    { encoding: "utf8" }
  );
  return (JSON.parse(out) as { calls: readonly FixtureCall[] }).calls;
}

function setFixtureTools(tools: readonly unknown[]): void {
  const script =
    `fetch("http://127.0.0.1:${CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT}/__control/tools",` +
    `{method:"POST",body:${JSON.stringify(JSON.stringify(tools))}}).then(r=>r.text()).then(t=>console.log(t))`;
  execFileSync(
    "docker",
    ["exec", classifierMcpFixtureContainerName(requireUatProjectName()), "node", "-e", script],
    { encoding: "utf8" }
  );
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireUatBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible({ timeout: 30_000 });
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

async function openConnection(page: Page): Promise<void> {
  await page.goto(`${requireUatBaseURL()}/settings?section=connections`);
  await expect(page.getByLabel(`Enable ${CONNECTION_NAME}`)).toBeAttached();
  await page.getByRole("button", { name: "Configure" }).click();
  await expect(page.getByLabel(`Enable ${FIXTURE_LIST_TOOL}`)).toBeAttached();
}

// The drawer keeps its last conversation; a fresh chat comes from the Conversations overlay.
// Sending waits until the drawer's clear is acknowledged and the old replies have left.
async function startSideChat(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open conversations" }).click();
  const cleared = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === "/api/chat/clear" &&
      url.searchParams.get("surface") === "drawer"
    );
  });
  await page.getByRole("button", { name: "New side chat", exact: true }).click();
  expect((await cleared).status()).toBe(204);
  await expect(page.locator(".chatd-msg:not(.chatd-msg--me) .chatd-bubble")).toHaveCount(0);
}

test("tool rows have one switch and repeated identical calls reach the service (#2950)", async ({
  page
}) => {
  test.setTimeout(900_000);

  await test.step("sign in, bring up the real default model, connect the tool server", async () => {
    await signIn(page);
    if (!process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED) {
      throw new Error("no Codex sign-in was copied into this stack; refusing to fake the model");
    }
    await bringUpRealChatModel(page);
    await page.goto(`${requireUatBaseURL()}/settings?section=connections`);
    await page.getByRole("button", { name: "Add connection" }).click();
    await page.getByLabel("Name").fill(CONNECTION_NAME);
    await page.getByLabel("URL").fill(classifierMcpFixtureEndpointFor(requireUatProjectName()));
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText(FIXTURE_LIST_TOOL).first()).toBeVisible({ timeout: 30_000 });
  });

  for (const [name, size] of [
    ["desktop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }]
  ] as const) {
    await test.step(`tool rows at ${name} width: one on/off switch each`, async () => {
      await page.setViewportSize(size);
      await openConnection(page);
      const enableSwitches = page.locator('input[aria-label^="Enable "]');
      // Four tools plus the connection's own switch outside the list.
      await expect(page.getByLabel(/repeated/i)).toHaveCount(0);
      const rows = page.locator(".set-row").filter({
        has: page.getByLabel(`Enable ${FIXTURE_LIST_TOOL}`)
      });
      await expect(rows).toHaveCount(1);
      await expect(rows.locator("input[type=checkbox]")).toHaveCount(1);
      expect(await enableSwitches.count()).toBeGreaterThanOrEqual(4);
      // Put the row at the top of the viewport so no fixed corner button sits over it.
      await rows.evaluate((el) => {
        const top = el.getBoundingClientRect().top + window.scrollY - 120;
        window.scrollTo(0, top);
      });
      if (process.env.MOSS_UAT_CAPTURE_OFF !== "1")
        await rows.screenshot({ path: `${SHOT_DIR}/2950-${name}-tool-row.png` });
    });
  }

  await test.step("YOLO on, then an identical read is requested twice in chat", async () => {
    const admin = await page.request.get("/api/admin/yolo");
    expect(admin.ok()).toBeTruthy();
    const adminUser = (
      (await admin.json()) as { users: readonly { id: string; email: string }[] }
    ).users.find((u) => u.email === UAT_ADMIN_EMAIL);
    expect(adminUser).toBeTruthy();
    for (const [path, body] of [
      ["/api/admin/yolo/instance", { enabled: true }],
      [`/api/admin/yolo/users/${adminUser!.id}`, { allowed: true }],
      ["/api/me/yolo", { enabled: true }]
    ] as const) {
      const response = await page.request.put(path, { data: body });
      expect(response.ok(), `PUT ${path} -> ${response.status()}`).toBeTruthy();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const listCalls = () => fixtureCalls().filter((c) => c.tool === FIXTURE_LIST_TOOL);
    // A chat session keeps the tool list it started with, and a session whose background start
    // raced the connection can miss the hub's tools. Each attempt is a fresh real chat, and the
    // proof needs two identical calls inside ONE attempt, so one call per chat never passes.
    let proven: readonly FixtureCall[] = [];
    for (let attempt = 1; attempt <= 3 && proven.length < 2; attempt++) {
      const before = listCalls().length;
      await page.goto(`${requireUatBaseURL()}/today`);
      await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
      await startSideChat(page);
      // The page shows no ready signal for the background protocol start; give it a bounded settle.
      await page.waitForTimeout(20_000);
      const composer = page.getByRole("textbox", { name: /^Message/ });
      await expect(composer).toBeEnabled();
      await composer.fill(
        `Call the tool named exactly "uat-smart-hub.${FIXTURE_LIST_TOOL}" twice in a row, both times with no ` +
          "arguments and without any other tool in between. Do both calls now, no questions."
      );
      await composer.press("Enter");
      await expect
        .poll(() => listCalls().length - before, { timeout: 90_000 })
        .toBeGreaterThanOrEqual(2)
        .catch(() => undefined);
      proven = listCalls().slice(before);
    }
    expect(
      proven.length,
      "two list calls reached the service within one chat"
    ).toBeGreaterThanOrEqual(2);
    expect(proven.map((c) => c.args)).toEqual(proven.map(() => ({})));
    await page.request.put("/api/me/yolo", { data: { enabled: false } });
  });
  // More than the live-tool threshold makes Moss group the list. The test tool server serves a
  // longer list and Moss discovers it through the real Refresh button.
  await test.step("grouped list at both widths: one switch per row", async () => {
    const groups = ["light", "lock", "sensor"];
    setFixtureTools(
      groups.flatMap((group) =>
        Array.from({ length: 12 }, (_, i) => ({
          name: `${group}_${String(i + 1).padStart(2, "0")}`,
          description: `Read the ${group} number ${i + 1}.`,
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true }
        }))
      )
    );
    await openConnection(page);
    await page
      .getByRole("button", { name: /^(Check for new tools|Check again)$/ })
      .first()
      .click();
    await expect(page.getByLabel("Enable light_01")).toBeAttached({ timeout: 30_000 });
    await expect(page.getByLabel(/repeated/i)).toHaveCount(0);
    for (const [name, size] of [
      ["desktop", { width: 1440, height: 900 }],
      ["phone", { width: 390, height: 844 }]
    ] as const) {
      await page.setViewportSize(size);
      const row = page.locator(".set-row").filter({ has: page.getByLabel("Enable light_01") });
      await expect(row).toHaveCount(1);
      await expect(row.locator("input[type=checkbox]")).toHaveCount(1);
      await row.evaluate((el) =>
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 160)
      );
      if (process.env.MOSS_UAT_CAPTURE_OFF !== "1")
        await row.locator("xpath=..").screenshot({ path: `${SHOT_DIR}/2950-grouped-${name}.png` });
    }
  });
});
