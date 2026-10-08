// #3065: deterministic model, real ACP/MCP, gateway, approval, act-as route and browser.
// ACP launch itself admits unverified context, so this is an APPROVED change, not clean auto-run
// proof. Only the provider's decisions are scripted; no app response is intercepted or replaced.
// The owner comes from a fresh solo-admin stack; the custom theme is saved through its real API.
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import type { AiAssistantActionDto, ListThemesResponse, MeResponse } from "@moss/shared";
import { buildUatComposeArgs, UAT_PORT_RANGE_SIZE, UAT_PORT_RANGE_START } from "../provisioner.js";
import { UAT_ADMIN_ID } from "../seed/admin.js";
import { requireUatBaseURL, requireUatProjectName, signInUatAdmin } from "./real-chat-signin.js";
import {
  APP_ACTION_PROMPT,
  APP_ACTION_REPLY,
  APP_ACTION_THEME,
  APP_ACTION_THEME_PATH,
  themePutEvidence
} from "./app-actions-fixture.js";

export const uatLevel = {
  level: "solo-admin",
  without: [],
  chatScript: "3065-app-actions"
} as const;

const NOTICE = "Moss read something from outside your account before asking this.";
const ACTION_CARD = '[role="region"][aria-label="Action request"]';

function readThemePuts() {
  const project = requireUatProjectName();
  if (!/^uat-\d+_[0-9a-f]{8}$/.test(project)) throw new Error("Expected an isolated UAT project");
  const log = execFileSync(
    "docker",
    buildUatComposeArgs(project, ["logs", "--no-color", "jarv1s"]),
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  return themePutEvidence(log);
}

async function openDrawer(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  await expect(page.locator("aside.chatd")).toBeVisible();
}

test("an approved app action changes a named theme once, without reload, across drawer interruption (#3065)", async ({
  page
}) => {
  test.setTimeout(300_000);
  const baseURL = new URL(requireUatBaseURL());
  expect(baseURL.protocol).toBe("http:");
  expect(baseURL.hostname).toBe("127.0.0.1");
  expect(Number(baseURL.port)).toBeGreaterThanOrEqual(UAT_PORT_RANGE_START);
  expect(Number(baseURL.port)).toBeLessThan(UAT_PORT_RANGE_START + UAT_PORT_RANGE_SIZE);
  expect(baseURL.username + baseURL.password + baseURL.search + baseURL.hash).toBe("");
  expect(baseURL.pathname).toBe("/");
  expect(requireUatProjectName()).toMatch(/^uat-\d+_[0-9a-f]{8}$/);
  expect(
    process.env.JARVIS_UAT_REAL_CHAT_CONFIGURED,
    "This proof needs no real model login"
  ).toBeFalsy();

  await test.step("sign in to the fresh owner and save a named custom theme through the API", async () => {
    await signInUatAdmin(page);
    const me = await page.request.get("/api/me");
    expect(me.ok()).toBe(true);
    expect(((await me.json()) as MeResponse).user.id).toBe(UAT_ADMIN_ID);
    const before = await page.request.get("/api/me/themes");
    expect(before.ok()).toBe(true);
    const themes = (await before.json()) as ListThemesResponse;
    expect(themes.custom, "A fresh owner must have no pre-existing custom themes").toEqual([]);
    expect(themes.activeId).toBe("light");

    const created = await page.request.put(`/api/me/themes/${APP_ACTION_THEME.id}`, {
      data: { name: APP_ACTION_THEME.name, tokens: APP_ACTION_THEME.tokens }
    });
    expect(created.status()).toBe(200);
    await page.goto(`${requireUatBaseURL()}/settings?section=appearance`);
    await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
  });

  const galleryCard = page.locator("article.theme-card").filter({ hasText: APP_ACTION_THEME.name });
  await expect(galleryCard).toBeVisible();
  await expect(galleryCard.getByRole("button", { name: "Apply", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(readThemePuts(), "Saving a custom theme must not activate it").toEqual([]);

  const pageIdentity = await page.evaluate(() => ({
    origin: performance.timeOrigin,
    url: location.href
  }));
  const requests: { method: string; path: string }[] = [];
  const documentRequests: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documentRequests.push(new URL(request.url()).pathname);
    }
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) requests.push({ method: request.method(), path });
  });

  await openDrawer(page);
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await expect(composer).toBeEnabled();
  const turnResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/chat/turn" &&
      response.request().method() === "POST",
    { timeout: 180_000 }
  );
  void turnResponse.catch(() => undefined);
  await composer.fill(APP_ACTION_PROMPT);
  await composer.press("Enter");

  const card = page.locator(ACTION_CARD).last();
  const actionRequestId =
    await test.step("the real gateway asks first and closing the drawer cannot authorize the PUT", async () => {
      await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible({
        timeout: 90_000
      });
      await expect(card).toContainText("Switch your theme");
      await expect(card.locator(".action-request-target")).toHaveText("Appearance");
      await expect(card.locator("dt")).toHaveText(["Theme"]);
      await expect(card.locator("dd")).toHaveText([APP_ACTION_THEME.name]);
      await expect(card).not.toContainText(APP_ACTION_THEME.id);
      await expect(card).not.toContainText(APP_ACTION_THEME_PATH);
      await expect(card).toContainText(NOTICE);
      const id = await card.getAttribute("data-action-request-id");
      expect(id).toBeTruthy();
      if (!id) throw new Error("The real approval card has no action request id");
      const pendingResponse = await page.request.get("/api/ai/assistant-actions");
      expect(pendingResponse.ok()).toBe(true);
      const pending = (await pendingResponse.json()) as { actions: AiAssistantActionDto[] };
      expect(pending.actions.find((action) => action.id === id)?.toolName).toBe("app.callAction");
      expect(readThemePuts()).toEqual([]);
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

      await page.getByRole("button", { name: "Close chat", exact: true }).click();
      await expect(page.locator("aside.chatd")).toBeHidden();
      expect(readThemePuts()).toEqual([]);
      await openDrawer(page);
      await expect(card).toHaveAttribute("data-action-request-id", id);
      await expect(card).toContainText(NOTICE);
      await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
      return id;
    });

  await test.step("two same-task Approve clicks resolve one action and refresh the current page", async () => {
    // Two synchronous UI clicks deliberately precede React's pending-state rerender.
    await card.getByRole("button", { name: "Approve", exact: true }).evaluate((button) => {
      if (!(button instanceof HTMLButtonElement)) throw new Error("Approve must be a button");
      button.click();
      button.click();
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", APP_ACTION_THEME.id, {
      timeout: 15_000
    });
    await expect(galleryCard).toHaveAttribute("aria-current", "true");
    await expect(galleryCard.getByText("Current", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()
        )
      )
      .toBe(APP_ACTION_THEME.tokens.paper);
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe("rgb(20, 37, 28)");
    const response = await turnResponse;
    expect(response.status()).toBe(200);
    await expect(
      page.locator("aside.chatd").getByText(APP_ACTION_REPLY, { exact: true })
    ).toBeVisible();
    await expect
      .poll(() => readThemePuts())
      .toEqual([
        {
          requestId: expect.any(String),
          method: "PUT",
          path: APP_ACTION_THEME_PATH,
          statusCode: 200
        }
      ]);
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" &&
          request.path === `/api/chat/action-requests/${actionRequestId}/resolve`
      )
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.method === "POST" && request.path === "/api/chat/turn")
    ).toHaveLength(1);
    // The theme write is internal server.inject, never a browser-side settings mutation.
    expect(
      requests.filter(
        (request) => request.method === "PUT" && request.path === APP_ACTION_THEME_PATH
      )
    ).toEqual([]);
    expect(
      requests.some((request) => request.method === "GET" && request.path === "/api/me/themes")
    ).toBe(true);
  });

  await test.step("reopening the completed chat retains the theme and does not replay the write", async () => {
    await page.getByRole("button", { name: "Close chat", exact: true }).click();
    await openDrawer(page);
    await expect(
      page.locator("aside.chatd").getByText(APP_ACTION_REPLY, { exact: true })
    ).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", APP_ACTION_THEME.id);
    expect(readThemePuts()).toHaveLength(1);
    expect(
      documentRequests,
      "Theme refresh and drawer reopen must not reload the document"
    ).toEqual([]);
    expect(
      await page.evaluate(() => ({ origin: performance.timeOrigin, url: location.href }))
    ).toEqual(pageIdentity);
  });

  // Only bounded assertion evidence is retained: never screenshots, credentials or raw app logs.
  const evidence = {
    scriptedProvider: uatLevel.chatScript,
    path: "chat drawer → ACP → MCP app.callAction → gateway approval → act-as theme route",
    outsideContentApproval: true,
    theme: APP_ACTION_THEME.name,
    themePuts: readThemePuts(),
    documentNavigations: documentRequests.length
  };
  console.log(`APP_ACTIONS_EVIDENCE ${JSON.stringify(evidence)}`);
  await test.info().attach("3065-app-action-evidence", {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: "application/json"
  });
});
