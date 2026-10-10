// tests/uat/specs/2942-midchat-tools.uat.spec.ts
//
// #2942: a chat session keeps the tool list it started with. When an integration is
// connected mid-conversation, the open conversation either picks up the new tools or
// tells the person to start a new chat.
//
// What this spec proves live, on the stack's default engine (ACP): the chat opens
// BEFORE the hub exists, the hub is connected mid-conversation through the real
// screen, and the same chat is asked to use a hub tool. The engine lists tools once
// per session, so the open conversation never sees the new tool: no approval card
// appears, the fixture records no call, and the light stays off. A new chat then
// runs the tool after one approval, proving the connection itself is good and the
// way out works.
//
// The refusal itself (a switched-off tool is refused; a post-session tool is refused
// with the start-a-new-chat hint) is pinned at the gateway by
// tests/unit/chat-midconversation-tool-refusal.test.ts. If a future engine re-lists
// mid-conversation, the hint path there is what carries the person to a new chat.
//
// Reuses the classifier fixture's faithful fake hub (real MCP over the real connect
// path) and the operator's own Codex sign-in with the cheapest model tier. Nothing is
// intercepted.
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import {
  FIXTURE_LIGHT_TOOL,
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

async function openIntegrations(page: Page): Promise<void> {
  await page.goto(`${requireUatBaseURL()}/settings?section=connections`);
  await expect(page.getByRole("heading", { name: "Connections" }).first()).toBeVisible();
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

async function openChat(page: Page): Promise<void> {
  await page.goto(`${requireUatBaseURL()}/today`);
  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  await startSideChat(page);
  // The new conversation starts its protocol session in the background; sending before it is
  // ready gets "Live chat is temporarily unavailable".
  await page.waitForTimeout(8_000);
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toBeEnabled();
}

type TurnResponse = Awaited<ReturnType<Page["waitForResponse"]>>;

// The turn POST answers only when the turn ends, and a turn that raises an approval card
// does not end until someone answers the card. So this returns the pending response and
// leaves awaiting it to the caller.
async function dispatchTurn(
  page: Page,
  text: string,
  responseTimeoutMs = 30_000
): Promise<{ readonly pending: Promise<TurnResponse> }> {
  // The settings tab takes focus while connecting; a backgrounded chat tab may not
  // dispatch the composer Enter, so foreground it before every turn.
  await page.bringToFront();
  const turnResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/chat/turn") &&
      response.request().method() === "POST",
    { timeout: responseTimeoutMs }
  );
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await composer.fill(text);
  await composer.press("Enter");
  return { pending: turnResponse };
}

async function sendTurn(
  page: Page,
  text: string,
  responseTimeoutMs = 30_000
): Promise<TurnResponse> {
  const response = await (await dispatchTurn(page, text, responseTimeoutMs)).pending;
  expect(response.status(), "chat turn POST").toBe(200);
  return response;
}

// Reading the full body waits for the turn to actually finish: waitForResponse fires on
// response headers, but a model turn keeps working long after that. Never use this for a
// turn that is expected to raise an approval card — the hold only releases when someone
// answers the card.
async function awaitTurnEnd(response: TurnResponse, timeoutMs = 300_000): Promise<void> {
  await expect.poll(() => response.json().then(() => true), { timeout: timeoutMs }).toBe(true);
}

const approvalCards = (page: Page) =>
  page.locator('[aria-label="Action request"]').getByRole("button", { name: "Approve" });

test("tools connected mid-conversation stay out of the open chat (#2942)", async ({
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
          "no real chat model is set up for this stack; refusing to fake the chat turn"
        );
      }
      await bringUpRealChatModel(page);
      // Every page load starts the drawer on Main and moves the server's drawer session there.
      // Load the settings tab now so connecting later cannot pull the open chat off its session.
      await openIntegrations(page);
    });

    await test.step("open a chat while no hub exists", async () => {
      await openChat(chat);
      // The hello forces the session (and its captured tool list) to exist first.
      await awaitTurnEnd(await sendTurn(chat, "hello"));
    });

    await test.step("connect the hub mid-conversation through the real screen", async () => {
      await page.getByRole("button", { name: "Add connection" }).click();
      await page.getByLabel("Name").fill(CONNECTION_NAME);
      await page.getByLabel("URL").fill(classifierMcpFixtureEndpointFor(requireUatProjectName()));
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.getByText(FIXTURE_LIGHT_TOOL).first()).toBeVisible({ timeout: 30_000 });
    });

    await test.step("the open chat cannot reach the new tool", async () => {
      // A tool-using turn needs several model round trips; the default 30 s wait is only
      // enough for a plain reply.
      await awaitTurnEnd(
        await sendTurn(
          chat,
          'Use the smart hub connection tool to turn the light named exactly "Porch light" on. Do it now, no questions.',
          180_000
        )
      );
      // The engine listed tools once, when the session started, so the new tool is not
      // offered and nothing is called: no approval card, no fixture call, light stays off.
      await expect(approvalCards(chat)).toHaveCount(0);
      // Soft observation for the run log (not an assertion): whether the engine even
      // reached the refusal hint, or stayed silent about the new tool.
      console.log(
        `hint visible in the open chat: ${(await chat.getByText(/Start a new chat/i).count()) > 0}`
      );
      expect(
        fixtureState().calls.filter((call) => call.tool === FIXTURE_LIGHT_TOOL),
        "the new tool never ran"
      ).toEqual([]);
      expect(
        fixtureState().devices.find((device) => device.name === "Porch light")?.on,
        "the light stayed off"
      ).toBe(false);
    });

    await test.step("a new chat runs the tool after one approval", async () => {
      await chat.bringToFront();
      await startSideChat(chat);
      await chat.waitForTimeout(8_000);
      // The fresh protocol session starts in the background; sending before the composer
      // is enabled dispatches nothing.
      await expect(chat.getByRole("textbox", { name: /^Message/ })).toBeEnabled();
      // Approve while the turn is still open. Awaiting the turn response first would
      // block until the approval hold expires unanswered.
      const turn = await dispatchTurn(
        chat,
        'Use the smart hub connection tool to turn the light named exactly "Porch light" on. Do it now, no questions.',
        600_000
      );
      // Approve in a loop until the effect lands: a single click can miss while the
      // card is still attaching.
      const porchOn = () =>
        fixtureState().devices.find((device) => device.name === "Porch light")?.on === true;
      const deadline = Date.now() + 180_000;
      while (!porchOn()) {
        if (Date.now() > deadline) {
          throw new Error("the light action never ran after approval");
        }
        const next = approvalCards(chat).first();
        if (!(await next.isVisible())) {
          await chat.waitForTimeout(1_000);
          continue;
        }
        await next.click({ timeout: 5_000 }).catch(() => undefined);
        await chat.waitForTimeout(1_000);
      }
      expect((await turn.pending).status(), "chat turn POST").toBe(200);
    });
  } finally {
    await chat.close();
  }
});
