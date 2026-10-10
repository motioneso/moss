// tests/uat/specs/2984-connection-page.uat.spec.ts
//
// #2984 R2.5a: the full-width connection page on the real stack. A real MCP tool server (the
// 2b.6 fixture, with two sending tools and a reset tool added) is connected through Settings,
// the worker sorts every tool with the real default chat model, and the page shows the tools
// grouped by what they do. The owner allows the sending group to send without asking, undoes
// one tool, asks first for all again, and turns a group off and on. Every change is read back
// from the API. Screenshots at 1440x900 and 390x844 back the spacing check.
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
  defaultFixtureTools
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
const NOTIFY_TOOL = "send_phone_notification";
const EMAIL_TOOL = "email_hub_report";
const RESET_TOOL = "factory_reset_hub";
const SHOT_DIR = process.env.UAT_2984_SHOT_DIR ?? "/tmp/build-2984-r25";
const SIZES = [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }]
] as const;

function setFixtureTools(tools: unknown): void {
  const script =
    `fetch("http://127.0.0.1:${CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT}/__control/tools",` +
    `{method:"POST",body:${JSON.stringify(JSON.stringify(tools))}}).then(r=>r.text())`;
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

async function connectionId(page: Page): Promise<string> {
  const list = (await (
    await page.request.get("/api/integrations")
  ).json()) as ListIntegrationsResponse;
  const id = list.integrations.find((row) => row.name === CONNECTION_NAME)?.id;
  if (!id) throw new Error(`no connection named ${CONNECTION_NAME}`);
  return id;
}

async function readDetail(page: Page): Promise<IntegrationDetail> {
  const id = await connectionId(page);
  return (await (await page.request.get(`/api/integrations/${id}`)).json()) as IntegrationDetail;
}

function sortOf(detail: IntegrationDetail, name: string): IntegrationClassifierToolSort {
  const sort = detail.classifierTools.find((tool) => tool.toolName === name);
  if (!sort) throw new Error(`no sort for ${name}`);
  return sort;
}

/**
 * Spacing check on the live layout: within every control strip, two neighbours on the same line
 * sit at least 8px apart, and no visible text in the page renders below 11px.
 */
async function assertNoCrowding(page: Page, label: string): Promise<void> {
  const problems = await page.evaluate(() => {
    const found: string[] = [];
    const strips = document.querySelectorAll(
      ".intg-tools__acts, .intg-tools__ctl, .intg__controls, .intg__acts, .intg-tools__bar"
    );
    for (const strip of strips) {
      const kids = [...strip.children]
        .map((el) => ({ el, r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && r.height > 0);
      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i]!.r;
          const b = kids[j]!.r;
          const sameLine = a.top < b.bottom && b.top < a.bottom;
          if (!sameLine) continue;
          const gap = Math.max(b.left - a.right, a.left - b.right);
          if (gap < 7.5) {
            found.push(
              `${strip.className}: "${kids[i]!.el.textContent}" and "${kids[j]!.el.textContent}" ${gap.toFixed(1)}px`
            );
          }
        }
      }
    }
    for (const row of document.querySelectorAll(".intg-tools .set-row")) {
      const text = row.querySelector(".set-row__main");
      const control = row.querySelector(".set-row__control");
      if (!text || !control) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      const words = [...range.getClientRects()].filter((r) => r.width > 0);
      const marks = [...control.querySelectorAll(".jds-badge, button, input, label")]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0);
      for (const a of words) {
        for (const b of marks) {
          const sameLine = a.top < b.bottom && b.top < a.bottom;
          const gap = Math.max(b.left - a.right, a.left - b.right);
          if (sameLine && gap < 7.5) {
            found.push(`tool row "${text.textContent}" touches its controls ${gap.toFixed(1)}px`);
          }
        }
      }
    }
    const root = document.querySelector(".set2") ?? document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim()) continue;
      const rect = parent.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const size = Number.parseFloat(getComputedStyle(parent).fontSize);
      if (size < 11) found.push(`text "${node.textContent.trim()}" at ${size}px`);
    }
    return found;
  });
  expect(problems, `crowding at ${label}`).toEqual([]);
}

test("the connection page groups sorted tools and controls sending without asking (#2984)", async ({
  page
}) => {
  test.setTimeout(900_000);

  await test.step("sign in, real default model, connect the tool server", async () => {
    await signIn(page);
    if (!process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED) {
      throw new Error("no real chat model is set up for this stack; refusing to fake the model");
    }
    await bringUpRealChatModel(page);
    setFixtureTools([
      ...defaultFixtureTools(),
      {
        name: NOTIFY_TOOL,
        description: "Send a push notification to the owner's phone.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string", description: "The text to send." } }
        },
        annotations: { openWorldHint: true }
      },
      {
        name: EMAIL_TOOL,
        description: "Email a status report about the hub to any email address.",
        inputSchema: {
          type: "object",
          properties: { to: { type: "string", description: "The address to email." } }
        },
        annotations: { openWorldHint: true }
      },
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

  await test.step("the open page picks up the finished sort without a reload", async () => {
    // Connecting opens the new connection's page; it must fill in once the worker sorts,
    // with no navigation. The marker would vanish on any reload.
    await expect(page.getByRole("button", { name: "Back to connections" })).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { __r25Stayed?: boolean }).__r25Stayed = true;
    });
    const titles = page.locator(".intg-tools .pane__cardtitle");
    console.log(
      "2984 R2.5 sorted when the page opened:",
      (await titles.filter({ hasText: "Sends things out" }).count()) > 0
    );
    await expect(titles.filter({ hasText: "Sends things out" })).toHaveCount(1, {
      timeout: 300_000
    });
    await expect(page.getByText("Not sorted yet", { exact: true })).toHaveCount(0, {
      timeout: 60_000
    });
    expect(
      await page.evaluate(
        () => (window as unknown as { __r25Stayed?: boolean }).__r25Stayed === true
      )
    ).toBe(true);
    const detail = await readDetail(page);
    console.log(
      "2984 R2.5 sorts:",
      JSON.stringify(detail.classifierTools.map((t) => [t.toolName, t.risk, t.asksFirst]))
    );
    expect(sortOf(detail, NOTIFY_TOOL).risk).toBe("outbound");
    expect(sortOf(detail, EMAIL_TOOL).risk).toBe("outbound");
  });

  const toolsMeta = (on: number, total: number) =>
    page.getByText(`${on} of ${total} on`, { exact: true });

  await test.step("the page fills the settings area, with the rail and grouped tools", async () => {
    await expect(page.getByRole("button", { name: "Back to connections" })).toBeVisible();
    await expect(page.getByRole("heading", { name: CONNECTION_NAME })).toBeVisible();
    await expect(page.locator(".set2--wide")).toHaveCount(1);

    const rail = page.getByRole("complementary", { name: "Connection" });
    await expect(rail.getByText("Connected", { exact: true })).toBeVisible();
    await expect(rail.getByText("Tool server", { exact: true })).toBeVisible();
    await expect(rail.getByRole("button", { name: "Check for new tools" })).toBeVisible();

    const detail = await readDetail(page);
    const asking = detail.classifierTools.filter((tool) => tool.asksFirst).length;
    await expect(toolsMeta(detail.tools.length, detail.tools.length)).toBeVisible();
    await expect(page.getByText("YOLO mode skips the asking.", { exact: false })).toBeVisible();
    const titles = page.locator(".intg-tools .pane__cardtitle");
    await expect(titles.filter({ hasText: "Sends things out" })).toHaveCount(1);
    await expect(titles.filter({ hasText: "Sensitive" })).toHaveCount(1);
    await expect(page.getByText("Asks first", { exact: true })).toHaveCount(asking);

    for (const [name, size] of SIZES) {
      await page.setViewportSize(size);
      await assertNoCrowding(page, name);
      await page.screenshot({ path: `${SHOT_DIR}/2984-r25-page-${name}.png`, fullPage: true });
    }
    await page.setViewportSize(SIZES[0][1]);
  });

  await test.step("Send all without asking confirms, then allows the whole group", async () => {
    await page.getByRole("button", { name: "Send all without asking" }).click();
    const confirm = page.getByRole("group", { name: "Send all without asking" });
    await expect(
      confirm.getByText("Let chat send with these 2 tools without checking with you?")
    ).toBeVisible();
    for (const [name, size] of SIZES) {
      await page.setViewportSize(size);
      await assertNoCrowding(page, `${name} confirm`);
      await confirm.screenshot({ path: `${SHOT_DIR}/2984-r25-confirm-${name}.png` });
    }
    await page.setViewportSize(SIZES[0][1]);
    await confirm.getByRole("button", { name: "Allow" }).click();
    await expect(page.getByText("Sends without asking", { exact: true })).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Ask first for all" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send all without asking" })).toHaveCount(0);
    const detail = await readDetail(page);
    expect(sortOf(detail, NOTIFY_TOOL)).toMatchObject({
      sendWithoutAsking: true,
      asksFirst: false
    });
    expect(sortOf(detail, EMAIL_TOOL)).toMatchObject({ sendWithoutAsking: true, asksFirst: false });
  });

  await test.step("one tool goes back to asking, and the group shows both links", async () => {
    await page.getByRole("button", { name: `More for ${EMAIL_TOOL}` }).click();
    await page.getByRole("menuitem", { name: /Ask before sending/ }).click();
    await expect(page.getByText("Sends without asking", { exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Send all without asking" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ask first for all" })).toBeVisible();
    expect(sortOf(await readDetail(page), EMAIL_TOOL)).toMatchObject({
      sendWithoutAsking: false,
      asksFirst: true
    });
    for (const [name, size] of SIZES) {
      await page.setViewportSize(size);
      await assertNoCrowding(page, `${name} mixed`);
      await page.screenshot({ path: `${SHOT_DIR}/2984-r25-mixed-${name}.png`, fullPage: true });
    }
    await page.setViewportSize(SIZES[0][1]);
  });

  await test.step("Ask first for all puts every sending tool back to asking", async () => {
    await page.getByRole("button", { name: "Ask first for all" }).click();
    await expect(page.getByText("Sends without asking", { exact: true })).toHaveCount(0);
    const detail = await readDetail(page);
    expect(sortOf(detail, NOTIFY_TOOL).sendWithoutAsking).toBe(false);
    expect(sortOf(detail, EMAIL_TOOL).sendWithoutAsking).toBe(false);
  });

  await test.step("Turn all off and Turn all on switch a whole group", async () => {
    const before = await readDetail(page);
    const sensitive = before.classifierTools
      .filter((tool) => tool.risk === "destructive")
      .map((tool) => tool.toolName);
    const group = page.locator(".pane__card", { hasText: "Always asks you before it runs." });
    await group.getByRole("button", { name: "Turn all off" }).click();
    await expect(group.getByRole("button", { name: "Turn all on" })).toBeVisible();
    expect([...(await readDetail(page)).mutedTools].sort()).toEqual([...sensitive].sort());
    await group.getByRole("button", { name: "Turn all on" }).click();
    await expect(group.getByRole("button", { name: "Turn all off" })).toBeVisible();
    expect((await readDetail(page)).mutedTools).toEqual([]);
  });

  await test.step("Back to connections returns to the list with the settings menu", async () => {
    await page.getByRole("button", { name: "Back to connections" }).click();
    await expect(page.getByRole("button", { name: "Add connection" })).toBeVisible();
    await expect(page.locator(".set2--wide")).toHaveCount(0);
  });
});
