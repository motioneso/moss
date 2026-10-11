import { expect, test, type Locator, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";

// #2907 (plan 3.5) live-path proof. Drives the real chat screen with the real classifier gate
// wired in, against two test-only classifier origins seeded by the provisioner:
//
// - "UAT Classifier Fixture Model" answers the gate's choice questions (tests/uat/fixtures/
//   classifier-fixture-server.ts), so shadow records a real would-handle decision that matches the
//   default model's first tool call.
// - "UAT Classifier Unreachable Model" points at a closed port, so shadow records a decline.
//
// Also proves: gate Off makes no classifier request; the default model still answers with the
// original text; the shadow decision is never executed and no approval card is raised. Timeout,
// malformed answers, attachments, oversize messages and cooldowns stay in the focused unit tests
// (tests/unit/chat-classifier-shadow-runner.test.ts, tests/unit/chat-classifier-gate.test.ts).
export const uatLevel = {
  level: "admin+data",
  without: [],
  withoutNewsJsonBinding: true,
  chatScript: "classifier-shadow",
  withClassifierFixture: true
} as const;

function requireBaseURL(): string {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return baseURL;
}

function requireProject(): string {
  const project = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!project) throw new Error("JARVIS_UAT_PROJECT_NAME must be set by run-uat.ts");
  return project;
}

async function signIn(page: Page): Promise<void> {
  await page.goto(requireBaseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skipSetup.or(userMenu).first()).toBeVisible({ timeout: 30_000 });
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    try {
      await page.getByRole("button", { name: "Skip anyway" }).click({ timeout: 5_000 });
    } catch {
      // No confirmation dialog on this instance.
    }
  }
  await expect(userMenu).toBeVisible({ timeout: 30_000 });
}

async function openAssistantAndAiSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "AI providers" }).click();
}

const classifierSelect = (page: Page) => page.getByLabel("Classifier model", { exact: true });
const gateButton = (page: Page, name: string) =>
  page.getByRole("group", { name: "Gate state" }).getByRole("button", { name });

async function chooseClassifier(page: Page, label: string): Promise<void> {
  // Wait for the binding save before navigating away, or the next screen can load before the
  // classifier selection has landed and the gate keeps its previous classifier.
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/ai/services/sorting/binding") &&
      response.request().method() === "PUT",
    { timeout: 30_000 }
  );
  await classifierSelect(page).selectOption({ label });
  expect((await saved).status()).toBe(200);
  await expect(classifierSelect(page)).toHaveValue(/^model:/);
}

async function setGate(page: Page, name: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith(
        "/api/admin/runtime-config/chat.classifier_gate_mode"
      ) && response.request().method() === "PUT",
    { timeout: 30_000 }
  );
  await gateButton(page, name).click();
  expect((await saved).status()).toBe(200);
  await expect(gateButton(page, name)).toHaveAttribute("aria-pressed", "true");
}

async function openChat(page: Page): Promise<Locator> {
  await page.locator(".topbar-actions button").click();
  const drawer = page.locator("aside.chatd");
  await expect(drawer).toBeVisible();
  return drawer;
}

async function sendMessage(page: Page, drawer: Locator, message: string): Promise<number> {
  const turnResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/chat/turn") &&
      response.request().method() === "POST",
    { timeout: 180_000 }
  );
  const composer = drawer.getByLabel("Message Moss");
  await composer.fill(message);
  await composer.press("Enter");
  const response = await turnResponse;
  return response.status();
}

function shadowCount(project: string): number {
  return Number(
    execUatSql(project, "select count(*)::int::text from app.chat_classifier_shadow_records").trim()
  );
}

/** The newest shadow row: decision|reason|module|tool|comparison|model_tool. */
function newestShadowRow(project: string): string[] {
  const row = execUatSql(
    project,
    "select decision || '|' || coalesce(reason,'') || '|' || coalesce(module_id,'') || '|' || " +
      "coalesce(tool_name,'') || '|' || comparison_status || '|' || coalesce(model_tool_id,'') " +
      "from app.chat_classifier_shadow_records order by created_at desc, id desc limit 1"
  ).trim();
  return row.split("|");
}

function approvalCardCount(project: string): number {
  return Number(
    execUatSql(project, "select count(*)::int::text from app.ai_assistant_action_requests").trim()
  );
}

async function waitForShadowCount(project: string, expected: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (shadowCount(project) >= expected) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  expect(shadowCount(project)).toBeGreaterThanOrEqual(expected);
}

const FIXTURE_MESSAGE = "uatfix what is on my calendar today?";
const DEAD_MESSAGE = "uatdead check the calendar please";
const OFF_MESSAGE = "uatoff what is on my calendar this week?";

test("shadow records a would-handle match without executing or raising a card, and the default reply is unchanged (#2907)", async ({
  page
}) => {
  test.setTimeout(420_000);
  const project = requireProject();
  await signIn(page);

  // Pick the fixture classifier and turn the gate to Shadow through the real settings row.
  await openAssistantAndAiSettings(page);
  await chooseClassifier(page, "UAT Classifier Fixture Model");
  await setGate(page, "Shadow");

  const cardsBefore = approvalCardCount(project);

  // 1. Fixture classifier: shadow records a real decision that matches the model's tool call.
  await page.goto(requireBaseURL());
  let drawer = await openChat(page);
  expect(await sendMessage(page, drawer, FIXTURE_MESSAGE)).toBe(200);
  await expect(drawer.getByText("You have events on your calendar today.")).toBeVisible({
    timeout: 60_000
  });
  await waitForShadowCount(project, 1);

  const wouldHandle = newestShadowRow(project);
  expect(wouldHandle[0]).toBe("would_handle");
  expect(wouldHandle[2]).toBe("calendar");
  expect(wouldHandle[3]).toBe("listVisibleEvents");
  expect(wouldHandle[4]).toBe("match");
  expect(wouldHandle[5]).toBe("calendar.listvisibleevents");
  // Shadow never executed the gate's pick and never raised a card.
  expect(approvalCardCount(project)).toBe(cardsBefore);

  // 2. Unreachable classifier: the gate declines and the default model answers unchanged.
  await openAssistantAndAiSettings(page);
  await chooseClassifier(page, "UAT Classifier Unreachable Model");
  await page.goto(requireBaseURL());
  drawer = await openChat(page);
  expect(await sendMessage(page, drawer, DEAD_MESSAGE)).toBe(200);
  await expect(drawer.getByText("I checked.")).toBeVisible({ timeout: 60_000 });
  await waitForShadowCount(project, 2);
  const declined = newestShadowRow(project);
  expect(declined[0]).toBe("failed");
  expect(["classifier_error", "timeout"]).toContain(declined[1]);
  expect(approvalCardCount(project)).toBe(cardsBefore);

  // 3. Gate Off: no further classifier request, so no new shadow record.
  await openAssistantAndAiSettings(page);
  await setGate(page, "Off");
  const beforeOff = shadowCount(project);
  await page.goto(requireBaseURL());
  drawer = await openChat(page);
  expect(await sendMessage(page, drawer, OFF_MESSAGE)).toBe(200);
  await expect(drawer.getByText("All set.")).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(4_000);
  expect(shadowCount(project)).toBe(beforeOff);
});
