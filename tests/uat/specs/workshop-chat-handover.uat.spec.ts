import { expect, test, type Page, type Response } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Workshop Phase A — the real-chat half of the Live-Path Gate.
//
// tests/uat/specs/workshop-project-entry.uat.spec.ts proves the direct entry screens: create,
// retry after a lost acknowledgement, message retention, narrow widths. What it CANNOT prove is
// the chat handover, because workshop.buildModule executes ONLY inside a live chat turn — the
// REST create route is a different entry point and never exercises the tool, its structured
// result, or the browser card that renders it.
//
// The tool declares executionPolicy "auto" with selfOperationGrant "granted_at_install", so a
// correct run must NOT raise a confirmation card: installing Workshop is what grants saving a
// project from chat. That also keeps this spec clear of #1720 (an Approve only counts while the
// turn's in-process waiter is alive), which still blocks every confirm-gated tool.
//
// Like 926-food-real-chat, this runs only when the operator supplied a real chat token, and
// stays skipped on every default/CI run so the gate remains credential-free.
export const uatLevel = { level: "solo-admin", without: [] } as const;

const REAL_CHAT_CONFIGURED = Boolean(process.env.JARVIS_UAT_REAL_CHAT_ENV_FILE);

const MODEL_DISCOVERY_DEADLINE_MS = 60_000;
const POLL_INITIAL_INTERVAL_MS = 500;
const POLL_MAX_INTERVAL_MS = 4_000;

const PROJECT_TITLE_HINT = "Garden watering reminders";
const CARD = '[role="region"][aria-label="Action request"]';

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL || !process.env.JARVIS_UAT_PROJECT_NAME?.startsWith("uat-")) {
    throw new Error("Run through the isolated UAT provisioner");
  }
  return baseURL;
}

// solo-admin returns before the onboarding chunk, so login can land on the first-run wizard.
// Skip it only when shown, keeping this idempotent across the shared, non-reset DB.
async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skip.or(userMenu).first()).toBeVisible({ timeout: 30_000 });
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
}

// #1121: the provisioner has already persisted the operator's OAuth token into the cli-auth
// volume, so begin settles to "ready" rather than handing back an authorization URL. Install
// must run first — token persistence and binary install are separate steps.
async function bringUpRealModel(page: Page): Promise<void> {
  const install = await page.request.post("/api/onboarding/provider-install", {
    data: { providerKind: "anthropic" }
  });
  expect(install.ok(), `provider-install -> ${install.status()}`).toBeTruthy();
  expect((await install.json()).installState).toBe("installed");

  const begin = await page.request.post("/api/onboarding/provider-login/begin", {
    data: { providerKind: "anthropic" }
  });
  expect(begin.ok(), `provider-login/begin -> ${begin.status()}`).toBeTruthy();
  expect(
    (await begin.json()).status,
    "the pre-seeded token should authenticate the anthropic CLI non-interactively"
  ).toBe("ready");

  // Discovery runs asynchronously after login settles. Bounded exponential backoff, never a
  // fixed sleep.
  const deadline = Date.now() + MODEL_DISCOVERY_DEADLINE_MS;
  let interval = POLL_INITIAL_INTERVAL_MS;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const body = (await (await page.request.get("/api/ai/models")).json()) as {
      models: readonly { status: string; capabilities: readonly string[] }[];
    };
    last = body.models;
    if (body.models.some((m) => m.status === "active" && m.capabilities.includes("chat"))) return;
    await page.waitForTimeout(Math.min(interval, Math.max(0, deadline - Date.now())));
    interval = Math.min(interval * 2, POLL_MAX_INTERVAL_MS);
  }
  throw new Error(
    `no chat-capable active model after ${MODEL_DISCOVERY_DEADLINE_MS}ms: ${JSON.stringify(last)}`
  );
}

// #1720: the turn POST is handed back still in flight rather than awaited, matching
// 926-food-real-chat. Nothing here needs to approve a card, but awaiting the turn before
// asserting on the transcript would hide a card if one were wrongly raised.
async function sendMessage(page: Page, text: string): Promise<{ turnSettled: Promise<Response> }> {
  await page.getByRole("button", { name: /^(Chat with |Open chat$)/ }).click();
  const turnSettled = page.waitForResponse(
    (response) =>
      response.url().includes("/api/chat/turn") && response.request().method() === "POST",
    { timeout: 300_000 }
  );
  const composer = page.getByRole("textbox", { name: /^Message/ });
  await composer.fill(text);
  await composer.press("Enter");
  return { turnSettled };
}

test("a real model saves a Workshop project from chat and offers a link to open it", async ({
  page
}) => {
  test.skip(
    !REAL_CHAT_CONFIGURED,
    "no real-chat token configured for this run (JARVIS_UAT_REAL_CHAT_ENV_FILE unset)"
  );
  // A cold provider probe, async model discovery and a real model round-trip run serially.
  test.setTimeout(900_000);

  await signIn(page);
  await bringUpRealModel(page);

  const before = await page.request.get("/api/workshop/projects");
  expect(before.status()).toBe(200);
  const countBefore = ((await before.json()) as { projects: readonly unknown[] }).projects.length;

  const { turnSettled } = await sendMessage(
    page,
    `Please start a new Workshop project called "${PROJECT_TITLE_HINT}". ` +
      "I want something that reminds me when each plant in my garden needs watering."
  );

  // The card the browser renders from the tool's structured result. Its href is computed from
  // the saved project's own id, so a visible "Open project" button already proves the tool ran,
  // committed, and streamed a destination the browser was willing to trust.
  const savedNotice = page.getByRole("status").filter({ hasText: "Project saved:" });
  await expect(savedNotice).toBeVisible({ timeout: 300_000 });
  await expect(
    page.getByText("Your request is saved privately. Planning has not started.")
  ).toBeVisible();

  const openProject = page.getByRole("link", { name: "Open project", exact: true });
  await expect(openProject).toBeVisible();
  const destination = await openProject.getAttribute("href");
  expect(destination).toMatch(/^\/workshop\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);

  const turn = await turnSettled;
  expect(turn.ok(), "the chat turn must settle").toBe(true);

  // Installing Workshop is what grants saving a project from chat, so this must never interrupt.
  expect(
    await page.locator(`${CARD}:has(button:text-is("Approve"))`).count(),
    "saving a Workshop project is granted at install and must not raise a confirmation card"
  ).toBe(0);

  // Exactly one project was saved — a chat turn must not create duplicates on retries inside it.
  const after = await page.request.get("/api/workshop/projects");
  expect(after.status()).toBe(200);
  const projects = ((await after.json()) as { projects: readonly { id: string }[] }).projects;
  expect(projects).toHaveLength(countBefore + 1);
  expect(projects.map((project) => `/workshop/${project.id}`)).toContain(destination);

  // The link goes where it says it goes, and the saved request is on the project's own screen.
  await openProject.click();
  await expect(page).toHaveURL(new RegExp(`${destination}$`));
  await expect(page.getByText("No plan yet", { exact: true })).toBeVisible();
  await expect(page.getByText(/water/i).first()).toBeVisible();
});
