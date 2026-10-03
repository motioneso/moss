// tests/uat/specs/2942-midchat-tools.uat.spec.ts
//
// #2942: a chat session keeps the tool list it started with. When an integration is
// connected mid-conversation, the open conversation either picks up the new tools or
// tells the person to start a new chat. This spec proves the second half live: the
// chat opens BEFORE the new tools become usable, asks for one afterwards, and the
// person sees the start-a-new-chat hint. A new chat then runs the tool, proving the
// hint's advice works.
//
// Two tabs share one signed-in context. The settings tab holds the review dialog from
// preparing through approval without navigating (preparation drafts are transient and
// vanish if the dialog unmounts). The chat tab births its session after preparing but
// before approval, so its captured tool list predates the newly usable tools.
//
// Reuses the classifier fixture's faithful fake hub (real MCP over the real connect,
// discovery and approval paths) and the operator's own Codex sign-in with the cheapest
// model tier, like classifier-integrations.uat.spec.ts. Nothing is intercepted.
import { execFileSync } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { effectiveClassifierTools } from "../../../packages/integrations/src/classifier-settings.js";
import type { IntegrationDetail } from "../../../packages/shared/src/integrations-api.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import {
  FIXTURE_LIGHT_TOOL,
  FIXTURE_LIST_TOOL,
  classifierMcpFixtureContainerName,
  classifierMcpFixtureEndpointFor,
  CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT,
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

const CONNECTION_NAME = "UAT mid-chat hub";

function control<T>(method: "GET" | "POST", path: string, body?: unknown): T {
  const script =
    `fetch("http://127.0.0.1:${CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT}"+process.argv[2]+process.argv[3],` +
    `{method:process.argv[1],body:process.argv[4]||undefined}).then(r=>r.text()).then(t=>console.log(t))`;
  const out = execFileSync(
    "docker",
    [
      "exec",
      classifierMcpFixtureContainerName(requireUatProjectName()),
      "node",
      "-e",
      script,
      method,
      "",
      path,
      body === undefined ? "" : JSON.stringify(body)
    ],
    { encoding: "utf8" }
  );
  return JSON.parse(out) as T;
}

interface FixtureState {
  readonly devices: readonly { readonly name: string; readonly on: boolean }[];
  readonly calls: readonly FixtureCall[];
}

const fixtureState = () => control<FixtureState>("GET", "/__control/state");

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

async function apiJson<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.ok(), `GET ${path} -> ${response.status()}`).toBeTruthy();
  return (await response.json()) as T;
}

async function connectionDetail(page: Page): Promise<IntegrationDetail> {
  const found = (
    await apiJson<{ integrations: readonly { id: string; name: string }[] }>(
      page,
      "/api/integrations"
    )
  ).integrations.find((item) => item.name === CONNECTION_NAME);
  expect(found, `connection ${CONNECTION_NAME} exists`).toBeTruthy();
  return apiJson<IntegrationDetail>(page, `/api/integrations/${found!.id}`);
}

/** The real runtime menu resolver, over the setup the real API returns. */
function resolveMenu(detail: IntegrationDetail): string[] {
  return effectiveClassifierTools({
    enabled: detail.enabled,
    classifierEnabled: detail.classifierEnabled,
    lastError: detail.lastError,
    discoveredTools: detail.tools,
    enabledGroups: detail.enabledGroups,
    enabledTools: detail.enabledTools,
    mutedTools: detail.mutedTools,
    classifierPreparation: {
      version: 1,
      entries: Object.fromEntries(
        detail.classifierPreparation.map(({ toolName, state: _state, ...entry }) => [
          toolName,
          entry
        ])
      )
    }
  } as Parameters<typeof effectiveClassifierTools>[0]).map((entry) => entry.tool.name);
}

async function setSwitch(input: Locator, on: boolean): Promise<void> {
  if ((await input.isChecked()) === on) return;
  await input.locator("xpath=ancestor::label[1]").click();
  await expect(input).toBeChecked({ checked: on });
}

async function openIntegrations(page: Page): Promise<void> {
  await page.goto(`${requireUatBaseURL()}/settings?section=connections`);
  await expect(page.getByRole("heading", { name: "Connections" }).first()).toBeVisible();
}

async function openConnection(page: Page): Promise<void> {
  await openIntegrations(page);
  await expect(page.getByLabel(`Enable ${CONNECTION_NAME}`)).toBeAttached();
  await page.getByRole("button", { name: "Configure" }).click();
  await expect(page.getByText("Let the classifier use this connection").first()).toBeVisible();
}

async function openChat(page: Page): Promise<void> {
  await page.goto(`${requireUatBaseURL()}/today`);
  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  await page.getByRole("button", { name: "New chat" }).click();
  // The new conversation starts its protocol session in the background; sending before it is
  // ready gets "Live chat is temporarily unavailable".
  await page.waitForTimeout(8_000);
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toBeEnabled();
}

async function sendTurn(page: Page, text: string): Promise<void> {
  // The settings tab takes focus during approval; a backgrounded chat tab may not
  // dispatch the composer Enter, so foreground it before every turn.
  await page.bringToFront();
  const turnResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/chat/turn") &&
      response.request().method() === "POST"
  );
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await composer.fill(text);
  await composer.press("Enter");
  const response = await turnResponse;
  expect(response.status(), "chat turn POST").toBe(200);
  // waitForResponse fires on response headers, but a model turn keeps working long
  // after that. Reading the full body waits for the turn to actually finish, so the
  // next turn never lands while one is still in flight (the UI then sends nothing).
  await expect.poll(() => response.json().then(() => true), { timeout: 300_000 }).toBe(true);
}

test("mid-conversation tools tell the person to start a new chat (#2942)", async ({
  page,
  context
}) => {
  test.setTimeout(900_000);
  const chat = await context.newPage();
  try {
    await test.step("sign in and bring up the real default model (cheapest tier)", async () => {
      await signIn(page);
      if (!process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED) {
        throw new Error(
          "no Codex sign-in was copied into this stack; refusing to fake the chat turn"
        );
      }
      await bringUpRealChatModel(page);
    });

    await test.step("connect through the real screen and prepare, approving nothing yet", async () => {
      await openIntegrations(page);
      await page.getByRole("button", { name: "Add connection" }).click();
      await page.getByLabel("Name").fill(CONNECTION_NAME);
      await page.getByLabel("URL").fill(classifierMcpFixtureEndpointFor(requireUatProjectName()));
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.getByText(FIXTURE_LIGHT_TOOL).first()).toBeVisible({ timeout: 30_000 });
      // Drafts are transient: preparing stores nothing and makes nothing eligible, so the
      // hub tools are still unusable when the chat below opens. The dialog stays mounted
      // from here through approval — navigating away would drop the drafts.
      await openConnection(page);
      await setSwitch(page.getByLabel("Let the classifier use this connection"), true);
      await page.getByRole("button", { name: /^Prepare \d+ tools?$/ }).click();
      await expect(page.getByText("Review required")).toBeVisible({ timeout: 240_000 });
      expect(resolveMenu(await connectionDetail(page))).toEqual([]);
    });

    await test.step("open a chat while the hub tools are still unusable", async () => {
      await openChat(chat);
      // The hello forces the session (and its captured tool list) to exist before approval.
      await sendTurn(chat, "hello");
    });

    await test.step("approve the hub tools mid-conversation", async () => {
      await page.getByLabel(`Risk for ${FIXTURE_LIGHT_TOOL}`).selectOption("write");
      await page.getByLabel(`Risk for ${FIXTURE_LIST_TOOL}`).selectOption("read");
      await setSwitch(page.getByLabel(`Classifier may use ${FIXTURE_LIGHT_TOOL}`), true);
      await setSwitch(page.getByLabel(`Classifier may use ${FIXTURE_LIST_TOOL}`), true);
      await page.getByRole("button", { name: "Approve reviewed tools" }).click();
      await expect
        .poll(async () => resolveMenu(await connectionDetail(page)).sort())
        .toEqual([FIXTURE_LIGHT_TOOL, FIXTURE_LIST_TOOL].sort());
    });

    await test.step("the open chat shows the start-a-new-chat hint, and the light stays off", async () => {
      await sendTurn(
        chat,
        'Use the smart hub connection tool to turn the light named exactly "Porch light" on. Do it now, no questions.'
      );
      // The session predates the approval, so the call is refused with the hint — the tool
      // never runs and the person sees the way out in the chat itself.
      await expect(chat.getByText(/Start a new chat/i).first()).toBeVisible({ timeout: 180_000 });
      expect(
        fixtureState().calls.filter((call) => call.tool === FIXTURE_LIGHT_TOOL),
        "the refused tool never ran"
      ).toEqual([]);
      expect(
        fixtureState().devices.find((device) => device.name === "Porch light")?.on,
        "the light stayed off"
      ).toBe(false);
    });

    await test.step("a new chat runs the tool after one approval", async () => {
      await chat.bringToFront();
      await chat.getByRole("button", { name: "New chat" }).click();
      await chat.waitForTimeout(8_000);
      await sendTurn(
        chat,
        'Use the smart hub connection tool to turn the light named exactly "Porch light" on. Do it now, no questions.'
      );
      const approve = chat
        .locator('[aria-label="Action request"]')
        .getByRole("button", { name: "Approve" })
        .first();
      await approve.waitFor({ timeout: 180_000 });
      await approve.click({ timeout: 5_000 }).catch(() => undefined);
      await expect
        .poll(() => fixtureState().devices.find((device) => device.name === "Porch light")?.on, {
          timeout: 180_000
        })
        .toBe(true);
    });
  } finally {
    await chat.close();
  }
});
