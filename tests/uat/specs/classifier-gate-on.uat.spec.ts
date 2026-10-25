import { expect, test, type Locator, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { execUatSql } from "./job-search-board-sql.js";

// Moss extensions phase 0 live-path proof. The classifier gate turns On straight from Off and from
// Shadow through the real Settings row with no shadow review recorded, and a chat request is then
// answered through the gate.
//
// Disclosed stand-ins, both seeded by the UAT provisioner:
// - "UAT Classifier Fixture Model" answers the gate's choice questions
//   (tests/uat/fixtures/classifier-fixture-server.ts) and prefers the calendar listing tool.
// - The main chat model is the scripted backend (chat script "classifier-shadow"). When the gate
//   answers, the scripted reply never appears.
// The general calendar seed installs a fake Google account. A live read correctly marks that
// account as a gap, so this proof uses the ordinary empty calendar on its throwaway instance.
export const uatLevel = {
  level: "admin+data",
  without: ["calendar"],
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

const decisionDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Choose a decision model" });

async function openDecisionDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /^(Choose a model|Change model)$/ }).click();
  const dialog = decisionDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function chooseClassifier(page: Page, label: string): Promise<void> {
  // Wait for the binding save before navigating away, or the next screen can load before the
  // choice has landed.
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/ai/services/sorting/binding") &&
      response.request().method() === "PUT",
    { timeout: 30_000 }
  );
  const dialog = await openDecisionDialog(page);
  await dialog.getByRole("radio", { name: label }).check();
  await dialog.getByRole("button", { name: "Save" }).click();
  expect((await saved).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Change model" })).toBeVisible();
}

async function setGate(page: Page, name: string): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith(
        "/api/admin/runtime-config/chat.classifier_gate_mode"
      ) && response.request().method() === "PUT",
    { timeout: 30_000 }
  );
  const dialog = await openDecisionDialog(page);
  await dialog.getByRole("button", { name: /^Advanced/ }).click();
  await dialog.getByRole("group", { name: "Use in chat" }).getByRole("button", { name }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  expect((await saved).status()).toBe(200);
  await expect(dialog).toBeHidden();
}

async function expectGate(page: Page, name: string): Promise<void> {
  const dialog = await openDecisionDialog(page);
  await dialog.getByRole("button", { name: /^Advanced/ }).click();
  await expect(
    dialog.getByRole("group", { name: "Use in chat" }).getByRole("button", { name })
  ).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
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

function reviewCount(project: string): number {
  return Number(
    execUatSql(project, "select count(*)::int::text from app.chat_classifier_shadow_reviews").trim()
  );
}

/** The newest assistant message's gate stamp as kind|module|outcome. */
function newestAssistantOrigin(project: string): string {
  return execUatSql(
    project,
    "select coalesce(model_metadata->'origin'->>'kind','') || '|' || " +
      "coalesce(model_metadata->'origin'->>'moduleId','') || '|' || " +
      "coalesce(model_metadata->'origin'->>'outcome','') " +
      "from app.chat_messages where role = 'assistant' order by created_at desc, id desc limit 1"
  ).trim();
}

function newestGateReply(project: string): string {
  return execUatSql(
    project,
    "select body from app.chat_messages where role = 'assistant' and " +
      "model_metadata->'origin'->>'kind' = 'classifier_gate' order by created_at desc, id desc limit 1"
  ).trim();
}

const FIXTURE_MESSAGE = "uatfix what is on my calendar today?";
const SCRIPTED_REPLY = "You have events on your calendar today.";

test("the classifier gate turns On with no shadow review and answers a chat request (phase 0)", async ({
  page
}) => {
  test.setTimeout(300_000);
  const project = requireProject();
  await signIn(page);
  await openAssistantAndAiSettings(page);
  await chooseClassifier(page, "UAT Classifier Fixture Model");

  // Off to On, then Shadow, then On again. No review row exists at any point.
  await expectGate(page, "Off");
  expect(reviewCount(project)).toBe(0);
  await setGate(page, "On");
  await setGate(page, "Watch only");
  await setGate(page, "On");
  await expect(page.getByText("On opens after shadow review.")).toHaveCount(0);

  // The saved On survives a reload.
  await page.reload();
  await openAssistantAndAiSettings(page);
  await expectGate(page, "On");
  expect(reviewCount(project)).toBe(0);

  // A chat request is answered through the gate, not by the scripted main model.
  await page.goto(requireBaseURL());
  const drawer = await openChat(page);
  expect(await sendMessage(page, drawer, FIXTURE_MESSAGE)).toBe(200);
  await expect
    .poll(() => newestAssistantOrigin(project), { timeout: 30_000 })
    .toBe("classifier_gate|calendar|executed-success");
  const reply = newestGateReply(project);
  expect(reply.length).toBeGreaterThan(0);
  const firstWords = reply
    .split("\n")[0]!
    .replace(/[*_`#>]/g, "")
    .trim()
    .slice(0, 24);
  await expect(drawer).toContainText(firstWords);
  await expect(drawer.getByText(SCRIPTED_REPLY)).toHaveCount(0);
  expect(reviewCount(project)).toBe(0);
});
