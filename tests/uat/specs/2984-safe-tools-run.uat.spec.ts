// tests/uat/specs/2984-safe-tools-run.uat.spec.ts
//
// #2984 R2.3 (spec 8.3): outside YOLO, with the classifier off, a connected tool the owner's
// sort marks safe runs in ordinary chat with no approval card, and a Sensitive one still asks.
// Runs on the real stack with a real MCP tool server (the 2b.6 fixture), the real tool sort in
// the worker, and the real default chat model. The fixture's own call log is the proof of what
// reached the service.
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import type {
  IntegrationClassifierToolSort,
  IntegrationDetail,
  ListIntegrationsResponse
} from "../../../packages/shared/src/integrations-api.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import {
  CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT,
  FIXTURE_LIGHT_TOOL,
  classifierMcpFixtureContainerName,
  classifierMcpFixtureEndpointFor,
  defaultFixtureTools,
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
const SLUG = "uat-smart-hub";
const RESET_TOOL = "factory_reset_hub";
const ACTION_CARD = '[role="region"][aria-label="Action request"]';
const SHOT_DIR = process.env.UAT_2984_SHOT_DIR ?? "/tmp/build-2984-r23";

function fixture(path: string, body?: unknown): string {
  const init =
    body === undefined ? "" : `,{method:"POST",body:${JSON.stringify(JSON.stringify(body))}}`;
  const script =
    `fetch("http://127.0.0.1:${CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT}${path}"${init})` +
    `.then(r=>r.text()).then(t=>console.log(t))`;
  return execFileSync(
    "docker",
    ["exec", classifierMcpFixtureContainerName(requireUatProjectName()), "node", "-e", script],
    { encoding: "utf8" }
  );
}

function callsTo(tool: string): readonly FixtureCall[] {
  const state = JSON.parse(fixture("/__control/state")) as { calls: readonly FixtureCall[] };
  return state.calls.filter((call) => call.tool === tool);
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireUatBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skipSetup.or(userMenu).first()).toBeVisible({ timeout: 30_000 });
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

async function sortedTools(page: Page): Promise<Map<string, IntegrationClassifierToolSort>> {
  const list = (await (
    await page.request.get("/api/integrations")
  ).json()) as ListIntegrationsResponse;
  const id = list.integrations.find((row) => row.name === CONNECTION_NAME)?.id;
  if (!id) return new Map();
  const detail = (await (
    await page.request.get(`/api/integrations/${id}`)
  ).json()) as IntegrationDetail;
  return new Map(detail.classifierTools.map((tool) => [tool.toolName, tool]));
}

/** One fresh real chat that asks for one tool call. Returns the drawer for screenshots. */
async function askInNewChat(page: Page, message: string): Promise<void> {
  await page.goto(`${requireUatBaseURL()}/today`);
  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  await page.getByRole("button", { name: "New chat" }).click();
  // The page shows no ready signal for the background protocol start; give it a bounded settle.
  await page.waitForTimeout(20_000);
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toBeEnabled();
  await composer.fill(message);
  await composer.press("Enter");
}

test("a sorted-safe connected tool runs with no card and a Sensitive one asks (#2984)", async ({
  page
}) => {
  test.setTimeout(900_000);

  await test.step("sign in, real default model, connect the tool server with a reset tool", async () => {
    await signIn(page);
    if (!process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED) {
      throw new Error("no Codex sign-in was copied into this stack; refusing to fake the model");
    }
    await bringUpRealChatModel(page);
    fixture("/__control/tools", [
      ...defaultFixtureTools(),
      {
        name: RESET_TOOL,
        description: "Erase every device, automation and setting on the hub permanently.",
        inputSchema: { type: "object", properties: {} },
        annotations: { destructiveHint: true }
      }
    ]);
    await page.goto(`${requireUatBaseURL()}/settings?section=connections`);
    await page.getByRole("button", { name: "Add connection" }).click();
    await page.getByLabel("Name").fill(CONNECTION_NAME);
    await page.getByLabel("URL").fill(classifierMcpFixtureEndpointFor(requireUatProjectName()));
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText(FIXTURE_LIGHT_TOOL).first()).toBeVisible({ timeout: 30_000 });
  });

  await test.step("the worker sorts every tool with the real model", async () => {
    await expect
      .poll(
        async () => {
          const tools = await sortedTools(page);
          return [FIXTURE_LIGHT_TOOL, RESET_TOOL].map((name) => tools.get(name)?.status ?? "none");
        },
        { timeout: 300_000, intervals: [5_000] }
      )
      .toEqual(["current", "current"]);
    const tools = await sortedTools(page);
    console.log(
      "2984 sorts:",
      JSON.stringify([...tools.values()].map((t) => [t.toolName, t.risk, t.asksFirst]))
    );
    expect(tools.get(FIXTURE_LIGHT_TOOL)).toMatchObject({ asksFirst: false });
    expect(tools.get(RESET_TOOL)).toMatchObject({ risk: "destructive", asksFirst: true });
  });

  await test.step("YOLO off: the light tool runs in chat with no approval card", async () => {
    const yolo = await page.request.put("/api/me/yolo", { data: { enabled: false } });
    expect(yolo.ok() || yolo.status() === 403, `PUT /api/me/yolo -> ${yolo.status()}`).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    let ran = false;
    for (let attempt = 1; attempt <= 3 && !ran; attempt++) {
      const before = callsTo(FIXTURE_LIGHT_TOOL).length;
      await askInNewChat(
        page,
        `Call the tool named exactly "${SLUG}.${FIXTURE_LIGHT_TOOL}" once with name "Kitchen light" ` +
          "and on true. Do it now, no questions."
      );
      ran = await expect
        .poll(() => callsTo(FIXTURE_LIGHT_TOOL).length - before, { timeout: 120_000 })
        .toBeGreaterThanOrEqual(1)
        .then(() => true)
        .catch(() => false);
      await expect(page.locator(ACTION_CARD)).toHaveCount(0);
    }
    expect(ran, "the light call reached the service without a card").toBe(true);
    await page.waitForTimeout(5_000);
    await expect(page.locator(ACTION_CARD)).toHaveCount(0);
    await page.screenshot({ path: `${SHOT_DIR}/2984-safe-runs-desktop.png` });
  });

  await test.step("YOLO off: the Sensitive reset tool asks and never reaches the service", async () => {
    for (const [name, size] of [
      ["desktop", { width: 1440, height: 900 }],
      ["phone", { width: 390, height: 844 }]
    ] as const) {
      await page.setViewportSize(size);
      let asked = false;
      for (let attempt = 1; attempt <= 3 && !asked; attempt++) {
        await askInNewChat(
          page,
          `Call the tool named exactly "${SLUG}.${RESET_TOOL}" once with no arguments. ` +
            "Do it now, no questions."
        );
        asked = await expect(
          page.locator(ACTION_CARD).last().getByRole("button", { name: "Approve" })
        )
          .toBeVisible({ timeout: 180_000 })
          .then(() => true)
          .catch(() => false);
      }
      expect(asked, `the reset tool asked first at ${name} width`).toBe(true);
      await page.screenshot({ path: `${SHOT_DIR}/2984-sensitive-asks-${name}.png` });
      expect(callsTo(RESET_TOOL)).toHaveLength(0);
    }
  });
});
