// tests/uat/specs/classifier-integrations.uat.spec.ts
//
// Plan 2b.6 (#2936): the real integrations screen, end to end, for the classifier gate's setup.
// A faithful fake tool server (tests/uat/fixtures/classifier-mcp-fixture-server.ts) speaks real
// MCP, so the product's own connect, discovery and call paths run. Everything the user does
// here goes through the screen: connect, curate tools, switch the classifier on, prepare with
// the default model, edit and approve a draft, opt in only selected tools.
//
// Shadow mode (plan 3.5) is not merged. This spec proves persisted setup and the real menu
// resolver (effectiveClassifierTools, the function the runtime menu is built from) over the
// setup the real API returns. It is not end-to-end shadow proof.
//
// Preparation runs on the operator's own Codex sign-in and the cheapest model tier
// (real-chat-signin.ts). With no sign-in the spec fails loudly rather than faking the model.
import { execFileSync } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { effectiveClassifierTools } from "../../../packages/integrations/src/classifier-settings.js";
import {
  INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE,
  type IntegrationDetail
} from "../../../packages/shared/src/integrations-api.js";
import {
  UAT_ADMIN_EMAIL,
  UAT_ADMIN_PASSWORD,
  UAT_SECOND_OWNER_EMAIL,
  UAT_SECOND_OWNER_PASSWORD
} from "../seed/admin.js";
import {
  FIXTURE_LIGHT_TOOL,
  FIXTURE_LIST_TOOL,
  FIXTURE_STATUS_TOOL,
  FIXTURE_UNLOCK_TOOL,
  classifierMcpFixtureContainerName,
  classifierMcpFixtureEndpointFor,
  CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT,
  type FixtureCall,
  type FixtureTool
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

// ---- fixture control (the host cannot route to the stack network, so go through the container) ----

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
  readonly toolListRequests: number;
  readonly tools: readonly FixtureTool[];
}
const fixtureState = () => control<FixtureState>("GET", "/__control/state");

// ---- sign-in and API helpers ----

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(requireUatBaseURL());
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
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

async function listIntegrations(page: Page) {
  return (
    await apiJson<{ integrations: readonly { id: string; name: string }[] }>(
      page,
      "/api/integrations"
    )
  ).integrations;
}

async function connectionDetail(page: Page): Promise<IntegrationDetail> {
  const found = (await listIntegrations(page)).find((item) => item.name === CONNECTION_NAME);
  expect(found, `connection ${CONNECTION_NAME} exists`).toBeTruthy();
  return apiJson<IntegrationDetail>(page, `/api/integrations/${found!.id}`);
}

interface ModelActivityEntry {
  readonly id: string;
  readonly kind: string;
  readonly action: string;
  readonly outcome: string;
}

async function modelCalls(page: Page): Promise<readonly ModelActivityEntry[]> {
  return (
    await apiJson<{ entries: readonly ModelActivityEntry[] }>(
      page,
      "/api/ai/model-activity?limit=200"
    )
  ).entries;
}

// Setup calls are the structured worker calls; chat turns and other kinds are not counted.
async function modelCallCount(page: Page): Promise<number> {
  return (await modelCalls(page)).filter((entry) => entry.kind === "structured").length;
}

/** The real runtime resolver, run over the setup the real API returns for this connection. */
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

// The switch input is visually hidden, so flip it through its label.
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
  // The owner has exactly one connection, so one Configure button.
  await page.getByRole("button", { name: "Configure" }).click();
  await expect(page.getByText("Let the classifier use this connection").first()).toBeVisible();
}

test("classifier setup on the real integrations screen (#2936)", async ({ page, browser }) => {
  test.setTimeout(900_000);
  let firstOwnerConnectionId = "";
  let callsBeforeReconnect = 0;

  await test.step("sign in and bring up the real default model (cheapest tier)", async () => {
    await signIn(page, UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD);
    if (!process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED) {
      throw new Error(
        "no Codex sign-in was copied into this stack; refusing to fake the preparation step"
      );
    }
    await bringUpRealChatModel(page);
  });

  await test.step("connect through the real screen", async () => {
    await openIntegrations(page);
    await page.getByRole("button", { name: "Add connection" }).click();
    await page.getByLabel("Name").fill(CONNECTION_NAME);
    await page.getByLabel("URL").fill(classifierMcpFixtureEndpointFor(requireUatProjectName()));
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByText(FIXTURE_LIGHT_TOOL).first()).toBeVisible({ timeout: 30_000 });
    const detail = await connectionDetail(page);
    firstOwnerConnectionId = detail.id;
    expect(detail.tools.map((tool) => tool.name).sort()).toEqual(
      [FIXTURE_LIGHT_TOOL, FIXTURE_LIST_TOOL, FIXTURE_STATUS_TOOL, FIXTURE_UNLOCK_TOOL].sort()
    );
  });

  await test.step("starting state: classifier off, nothing prepared, nothing eligible", async () => {
    const detail = await connectionDetail(page);
    expect(detail.classifierEnabled).toBe(false);
    expect(detail.classifierPreparation).toEqual([]);
    expect(resolveMenu(detail)).toEqual([]);
  });

  await test.step("curate: switch one tool off for ordinary chat", async () => {
    await openConnection(page);
    await setSwitch(page.getByLabel(`Enable ${FIXTURE_STATUS_TOOL}`), false);
    await expect
      .poll(async () => (await connectionDetail(page)).mutedTools)
      .toContain(FIXTURE_STATUS_TOOL);
  });

  let callsBeforePrepare = 0;
  let callsAfterPrepare = 0;

  await test.step("turn the classifier on and read the disclosure before preparing", async () => {
    await setSwitch(page.getByLabel("Let the classifier use this connection"), true);
    await expect.poll(async () => (await connectionDetail(page)).classifierEnabled).toBe(true);
    for (const text of Object.values(INTEGRATION_CLASSIFIER_PREPARATION_DISCLOSURE)) {
      await expect(page.getByText(text).first()).toBeVisible();
    }
    await expect(
      page.getByText("Messages and device names go to the classifier provider.")
    ).toBeVisible();
    // Switching on alone prepares nothing and makes nothing eligible.
    expect((await connectionDetail(page)).classifierPreparation).toEqual([]);
    expect(resolveMenu(await connectionDetail(page))).toEqual([]);
  });

  await test.step("prepare with the default model: one batch of drafts, nothing stored yet", async () => {
    callsBeforePrepare = await modelCallCount(page);
    await page.getByRole("button", { name: /^Prepare \d+ tools?$/ }).click();
    await expect(page.getByText("Review required")).toBeVisible({ timeout: 240_000 });
    callsAfterPrepare = await modelCallCount(page);
    // One batch: one call per tool still on (three), none for the muted tool.
    expect(callsAfterPrepare - callsBeforePrepare, "one preparing batch").toBe(3);
    // Drafts are transient: nothing is persisted, nothing is eligible.
    const detail = await connectionDetail(page);
    expect(detail.classifierPreparation).toEqual([]);
    expect(resolveMenu(detail)).toEqual([]);
    // The muted tool is not drafted.
    await expect(page.getByText(FIXTURE_STATUS_TOOL).first()).toBeVisible();
    await expect(page.getByLabel(`Risk for ${FIXTURE_STATUS_TOOL}`)).toHaveCount(0);
  });

  await test.step("edit and approve: choose risks, opt in only the selected tools", async () => {
    const editedDescription = "Turn one named light on or off. Owner edited.";
    await page
      .getByLabel(`Description the classifier sees for ${FIXTURE_LIGHT_TOOL}`)
      .fill(editedDescription);
    await page.getByLabel(`Risk for ${FIXTURE_LIGHT_TOOL}`).selectOption("write");
    await page.getByLabel(`Risk for ${FIXTURE_LIST_TOOL}`).selectOption("read");
    await setSwitch(page.getByLabel(`Classifier may use ${FIXTURE_LIGHT_TOOL}`), true);
    await setSwitch(page.getByLabel(`Classifier may use ${FIXTURE_LIST_TOOL}`), true);
    // The unlock tool says it is read-only. The owner leaves its risk unchosen, so the hint
    // alone cannot qualify it.
    await page.getByRole("button", { name: "Approve reviewed tools" }).click();
    await expect
      .poll(async () => (await connectionDetail(page)).classifierPreparation.length)
      .toBe(2);

    const detail = await connectionDetail(page);
    const byName = new Map(detail.classifierPreparation.map((entry) => [entry.toolName, entry]));
    expect(byName.get(FIXTURE_LIGHT_TOOL)).toMatchObject({
      optIn: true,
      reviewedRisk: "write",
      description: editedDescription,
      state: "current"
    });
    expect(byName.get(FIXTURE_LIST_TOOL)).toMatchObject({ optIn: true, reviewedRisk: "read" });
    // Unknown risk and the muted tool are not stored at all.
    expect(byName.has(FIXTURE_UNLOCK_TOOL)).toBe(false);
    expect(byName.has(FIXTURE_STATUS_TOOL)).toBe(false);
    // The real menu resolver offers exactly the two opted-in, reviewed tools.
    expect(resolveMenu(detail).sort()).toEqual([FIXTURE_LIGHT_TOOL, FIXTURE_LIST_TOOL].sort());
    await expect(page.getByText("Approved").first()).toBeVisible();
    // Approving never ran a device action or the listing tool.
    expect(fixtureState().calls).toEqual([]);
  });

  await test.step("reload keeps the saved setup", async () => {
    await openConnection(page);
    await expect(page.getByText("Approved").first()).toBeVisible();
    expect(resolveMenu(await connectionDetail(page)).length).toBe(2);
  });

  await test.step("reconnecting with unchanged configuration prepares nothing again", async () => {
    callsBeforeReconnect = await modelCallCount(page);
    expect(callsBeforeReconnect, "approving made no model call").toBe(callsAfterPrepare);
    const listRequestsBefore = fixtureState().toolListRequests;
    // Rediscover from the server.
    await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
    await expect.poll(() => fixtureState().toolListRequests).toBeGreaterThan(listRequestsBefore);
    // Classifier off then on.
    const classifierSwitch = page.getByLabel("Let the classifier use this connection");
    await setSwitch(classifierSwitch, false);
    await expect.poll(async () => (await connectionDetail(page)).classifierEnabled).toBe(false);
    expect(resolveMenu(await connectionDetail(page))).toEqual([]);
    await setSwitch(classifierSwitch, true);
    await expect.poll(async () => (await connectionDetail(page)).classifierEnabled).toBe(true);
    // Connection off then on.
    await openIntegrations(page);
    const connectionSwitch = page.getByLabel(`Enable ${CONNECTION_NAME}`);
    await setSwitch(connectionSwitch, false);
    await expect.poll(async () => (await connectionDetail(page)).enabled).toBe(false);
    await setSwitch(connectionSwitch, true);
    await expect.poll(async () => (await connectionDetail(page)).enabled).toBe(true);

    const detail = await connectionDetail(page);
    expect(detail.classifierPreparation.every((entry) => entry.state === "current")).toBe(true);
    expect(resolveMenu(detail).sort()).toEqual([FIXTURE_LIGHT_TOOL, FIXTURE_LIST_TOOL].sort());
    expect(await modelCallCount(page), "no new setup model call").toBe(callsBeforeReconnect);
  });

  await test.step("a second owner sees and reaches nothing of the first owner's setup", async () => {
    const context = await browser.newContext();
    try {
      const other = await context.newPage();
      await signIn(other, UAT_SECOND_OWNER_EMAIL, UAT_SECOND_OWNER_PASSWORD);
      expect(await listIntegrations(other)).toEqual([]);
      const base = `/api/integrations/${firstOwnerConnectionId}`;
      expect((await other.request.get(base)).status()).toBe(404);
      const forgedSave = await other.request.put(
        `${base}/classifier/tools/${FIXTURE_UNLOCK_TOOL}`,
        {
          data: {
            optIn: true,
            reviewedRisk: "read",
            description: "x",
            arguments: {},
            replyTemplate: "{status}",
            reviewedFingerprint: "x"
          }
        }
      );
      expect(forgedSave.status()).toBe(404);
      expect((await other.request.post(`${base}/classifier/prepare`, { data: {} })).status()).toBe(
        404
      );
      expect(
        (await other.request.patch(base, { data: { classifierEnabled: false } })).status()
      ).toBe(404);
    } finally {
      await context.close();
    }
    // The first owner's setup is untouched.
    expect(resolveMenu(await connectionDetail(page)).length).toBe(2);
  });

  await test.step("the server changes: setup shows as changed and the classifier pauses on it", async () => {
    const changed = fixtureState().tools.map((tool) =>
      tool.name === FIXTURE_LIST_TOOL
        ? { ...tool, description: "List every device, with rooms." }
        : tool
    );
    changed.push({
      name: "dim_light",
      description: "Set a light's brightness.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, level: { type: "number" } },
        required: ["name", "level"]
      }
    });
    control("POST", "/__control/tools", changed);
    await openConnection(page);
    await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
    await expect
      .poll(async () => (await connectionDetail(page)).tools.map((tool) => tool.name))
      .toContain("dim_light");
    const detail = await connectionDetail(page);
    const states = Object.fromEntries(
      detail.classifierPreparation.map((e) => [e.toolName, e.state])
    );
    expect(states[FIXTURE_LIST_TOOL]).toBe("stale");
    expect(states[FIXTURE_LIGHT_TOOL]).toBe("current");
    // The changed tool drops out of the menu at once. The new tool is not stored and not offered.
    expect(resolveMenu(detail)).toEqual([FIXTURE_LIGHT_TOOL]);
    expect(detail.classifierPreparation.some((entry) => entry.toolName === "dim_light")).toBe(
      false
    );
    await openConnection(page);
    await expect(
      page.getByText("The connection changed its tools. The classifier is paused here.")
    ).toBeVisible();
  });

  await test.step("preparing again costs another default model request, then review restores it", async () => {
    const before = await modelCallCount(page);
    await page.getByRole("button", { name: "Review changes" }).first().click();
    await expect(page.getByText("Review required")).toBeVisible({ timeout: 240_000 });
    // One call per tool the screen drafts again.
    const drafted = await page.getByText("Draft", { exact: true }).count();
    expect(drafted, "tools drafted again").toBeGreaterThan(0);
    const callEntries = (await modelCalls(page)).filter((entry) => entry.kind === "structured");
    expect(callEntries.length - before, "re-preparing model calls").toBe(drafted);
    // Old approval is still the saved one until the owner approves the new draft.
    expect(resolveMenu(await connectionDetail(page))).toEqual([FIXTURE_LIGHT_TOOL]);
    await page.getByLabel(`Risk for ${FIXTURE_LIST_TOOL}`).selectOption("read");
    await setSwitch(page.getByLabel(`Classifier may use ${FIXTURE_LIST_TOOL}`), true);
    await page.getByRole("button", { name: "Approve reviewed tools" }).click();
    await expect
      .poll(async () => resolveMenu(await connectionDetail(page)).sort())
      .toEqual([FIXTURE_LIGHT_TOOL, FIXTURE_LIST_TOOL].sort());
    // The new tool is still off.
    expect(resolveMenu(await connectionDetail(page))).not.toContain("dim_light");
  });

  await test.step("an empty tool list removes eligibility", async () => {
    control("POST", "/__control/tools", []);
    await openConnection(page);
    await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
    await expect.poll(async () => (await connectionDetail(page)).tools.length).toBe(0);
    expect(resolveMenu(await connectionDetail(page))).toEqual([]);
    control("POST", "/__control/reset");
    await page.getByRole("button", { name: "Refresh", exact: true }).first().click();
    await expect.poll(async () => (await connectionDetail(page)).tools.length).toBeGreaterThan(0);
  });

  // Ordinary chat keeps its own approval rules. The classifier setup above must not change them.
  const askChat = async (text: string) => {
    await page.goto(`${requireUatBaseURL()}/today`);
    await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
    // A chat session keeps the tool list it started with, so use a fresh one.
    await page.getByRole("button", { name: "New chat" }).click();
    // The new conversation starts its protocol session in the background; sending before it is
    // ready gets "Live chat is temporarily unavailable".
    // The page shows no ready signal for this background start, so give it a bounded settle.
    await page.waitForTimeout(8_000);
    const composer = page.getByRole("textbox", { name: /^Message/ });
    await expect(composer).toBeEnabled();
    await composer.fill(text);
    await composer.press("Enter");
  };
  const porch = () => fixtureState().devices.find((d) => d.name === "Porch light");
  const lightCalls = () => fixtureState().calls.filter((c) => c.tool === FIXTURE_LIGHT_TOOL);
  const approveButton = () =>
    page.locator('[aria-label="Action request"]').getByRole("button", { name: "Approve" });

  await test.step("ordinary chat still asks before a connection action in normal mode", async () => {
    control("POST", "/__control/reset");
    await askChat(
      'Use the smart hub connection tool to turn the light named exactly "Porch light" on. Do it now, no questions.'
    );
    await approveButton().first().waitFor({ timeout: 180_000 });
    expect(lightCalls()).toEqual([]);
    // The model may look up devices first, which is its own request. Read each card before
    // approving it: only the device listing and the light action are allowed.
    const deadline = Date.now() + 180_000;
    while (porch()?.on !== true) {
      if (Date.now() > deadline) throw new Error("the light action never ran after approval");
      const next = approveButton().first();
      if (!(await next.isVisible())) {
        await page.waitForTimeout(1_000);
        continue;
      }
      const card = await next
        .locator('xpath=ancestor::*[@aria-label="Action request"][1]')
        .innerText();
      if (card.includes(FIXTURE_LIGHT_TOOL)) {
        expect(porch()?.on, "the light is still off before its card is approved").toBe(false);
      } else {
        expect(card, "unexpected approval card").toContain(FIXTURE_LIST_TOOL);
      }
      await next.click({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000);
    }
  });

  await test.step("YOLO mode runs the same action with no approval card", async () => {
    const admin = await page.request.get("/api/admin/yolo");
    expect(admin.ok()).toBeTruthy();
    const adminUser = (
      (await admin.json()) as {
        users: readonly { id: string; email: string }[];
      }
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
    await askChat(
      'Use the smart hub connection tool to turn the light named exactly "Porch light" off. Do it now, no questions.'
    );
    await expect.poll(() => porch()?.on, { timeout: 180_000 }).toBe(false);
    await expect(approveButton()).toHaveCount(0);
    await page.request.put("/api/me/yolo", { data: { enabled: false } });
    // Across both chat steps only the listing and the light tool ran. The unlock never did.
    const toolsCalled = new Set(fixtureState().calls.map((c) => c.tool));
    expect([...toolsCalled].every((t) => t === FIXTURE_LIGHT_TOOL || t === FIXTURE_LIST_TOOL)).toBe(
      true
    );
    expect(toolsCalled.has(FIXTURE_UNLOCK_TOOL)).toBe(false);
  });
});
