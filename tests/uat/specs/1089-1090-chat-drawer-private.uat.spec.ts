import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "1105-drawer-private"
} as const;

const FIRST_MESSAGE = "UAT-1105 first persisted message";
const CONTINUATION_MESSAGE = "UAT-1105 continue in resumed thread";
const ACTIVATION_MESSAGE = "UAT-1105 send during activation";
const AFTER_ACTIVATION_MESSAGE = "UAT-1105 after activation";
const SCRIPTED_REPLY = "Scripted UAT-1105 reply.";
const clearPath = (url: URL): boolean => url.pathname.endsWith("/api/chat/clear");
const turnPath = (url: URL): boolean => url.pathname.endsWith("/api/chat/turn");

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();
}

async function openChat(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  const drawer = page.getByRole("dialog", { name: "Chat with Moss" });
  await expect(drawer).toBeVisible();
  return drawer;
}

async function sendAndAwaitReply(drawer: Locator, message: string): Promise<void> {
  const composer = drawer.getByLabel("Message Moss");
  await composer.fill(message);
  await composer.press("Enter");
  await expect(drawer.getByText(SCRIPTED_REPLY)).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
}

test.describe.configure({ mode: "serial" });

test("resuming a History thread while private clears the stale privateMode flag (#1090)", async ({
  page
}) => {
  await signIn(page);
  const drawer = await openChat(page);

  await sendAndAwaitReply(drawer, FIRST_MESSAGE);
  await drawer.getByRole("button", { name: "Start private chat" }).click();
  await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Start private chat" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await shot(page, "1090-private-active");

  await drawer.getByRole("button", { name: "Show chat history" }).click();
  const threadRow = drawer.getByRole("button", { name: new RegExp(FIRST_MESSAGE) });
  await expect(threadRow).toBeVisible();
  await threadRow.click();

  await expect(drawer.getByText(FIRST_MESSAGE)).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Start private chat" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
  await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toHaveCount(0);
  await shot(page, "1090-resumed-persisted");

  await sendAndAwaitReply(drawer, CONTINUATION_MESSAGE);
  await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toHaveCount(0);
});

test("private activation blocks send until the server confirms, then allows it (#1089)", async ({
  page
}) => {
  let clearRoute: Route | undefined;
  let releaseClear: (() => void) | undefined;
  const clearHeld = new Promise<void>((resolve) => {
    releaseClear = resolve;
  });
  let turnRequests = 0;

  await page.route(clearPath, async (route) => {
    clearRoute = route;
    await clearHeld;
    await route.continue();
  });
  await page.route(turnPath, async (route) => {
    turnRequests += 1;
    await route.continue();
  });

  try {
    await signIn(page);
    const drawer = await openChat(page);
    await drawer.getByRole("button", { name: "Start private chat" }).click();

    await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toHaveCount(0);
    await drawer.getByLabel("Message Moss").fill(ACTIVATION_MESSAGE);
    await drawer.getByLabel("Message Moss").press("Enter");
    await expect.poll(() => turnRequests, { timeout: 2_000 }).toBe(0);

    expect(clearRoute).toBeDefined();
    releaseClear?.();
    await expect(drawer.locator(".chatd-private").filter({ hasText: "not saved" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Start private chat" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await shot(page, "1089-private-activation-confirmed");

    await sendAndAwaitReply(drawer, AFTER_ACTIVATION_MESSAGE);
    await expect.poll(() => turnRequests).toBe(1);
  } finally {
    await page.unroute(clearPath);
    await page.unroute(turnPath);
  }
});
