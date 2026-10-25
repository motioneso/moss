import { expect, test, type Locator, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Classifier gate plan 1.3 (#2892), updated for Moss extensions phase 0. Proves the shipped
// Classifier settings row on the real Settings > AI providers screen: pick and clear a classifier,
// move the gate to Shadow and then straight to On with no review step, and that the row reads in
// light, dark and one park theme. The gate-Off chat control needs a real chat turn; this
// solo-admin seed has no chat-capable AI provider (#1121), so it is test.fixme'd with that citation.
export const uatLevel = { level: "solo-admin", without: [] } as const;

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
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
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

async function json(
  page: Page,
  path: string,
  init?: RequestInit
): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ path, init }) => {
      const response = await fetch(path, init);
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    { path, init }
  );
}

const classifierHeading = (page: Page) =>
  page.locator(".rt__name").filter({ hasText: "Decision model" }).first();

const decisionDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Choose a decision model" });

async function openDecisionDialog(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /^(Choose a model|Change model)$/ }).click();
  const dialog = decisionDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openAdvanced(dialog: Locator): Promise<Locator> {
  await dialog.getByRole("button", { name: /^Advanced/ }).click();
  return dialog.getByRole("group", { name: "Use in chat" });
}

async function selectClassifier(page: Page): Promise<void> {
  const dialog = await openDecisionDialog(page);
  await dialog.getByRole("radio", { name: "UAT Classifier Model" }).check();
  await dialog.getByRole("button", { name: "Save" }).click();
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
  await (await openAdvanced(dialog)).getByRole("button", { name, exact: true }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  expect((await saved).status()).toBe(200);
  await expect(dialog).toBeHidden();
}

async function expectGate(page: Page, name: string): Promise<void> {
  const dialog = await openDecisionDialog(page);
  const group = await openAdvanced(dialog);
  await expect(group.getByRole("button", { name, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
}

test("the Classifier settings row picks and clears a classifier and turns `on` straight away (#2892)", async ({
  page
}) => {
  test.setTimeout(240_000);
  await signIn(page);
  await openAssistantAndAiSettings(page);

  // A JSON-capable model under a sorting-bindable provider kind (Claude, created like the
  // #2842 spec) is what the Classifier row offers.
  await page.getByRole("button", { name: "Add provider" }).first().click();
  const addDialog = page.getByRole("dialog", { name: /Add a provider|Connect/ });
  await addDialog.getByRole("radio", { name: "Claude" }).check();
  await addDialog.getByRole("button", { name: "Next" }).click();
  await addDialog.getByRole("button", { name: /^Add/ }).click();
  // Adding a subscription provider opens its sign-in dialog; close it to reach the card.
  const addedSignIn = page.getByRole("dialog", { name: /^Sign in to / });
  await addedSignIn.waitFor({ timeout: 10_000 }).then(
    () => addedSignIn.getByRole("button", { name: "Close" }).click(),
    () => undefined
  );
  const ownerCard = page.locator(".prov").filter({ has: page.getByLabel("Remove Claude") });
  await expect(ownerCard).toBeVisible({ timeout: 30_000 });
  await ownerCard.getByRole("button", { name: "Add model", exact: true }).click();
  await ownerCard.getByLabel("Model id").fill("uat-classifier-model");
  await ownerCard.getByLabel("Display name").fill("UAT Classifier Model");
  await ownerCard.getByRole("checkbox", { name: "JSON" }).check();
  await ownerCard.getByRole("button", { name: "Add model", exact: true }).last().click();
  await expect(ownerCard.locator(".mdl__id", { hasText: "uat-classifier-model" })).toBeVisible({
    timeout: 30_000
  });

  // The row is named Decision model and starts empty, with no Use in chat control.
  await expect(classifierHeading(page)).toBeVisible();
  await expect(page.locator(".rt__name").filter({ hasText: "Sorting model" })).toHaveCount(0);
  await expect(page.getByText("Not chosen")).toBeVisible();
  await expect(page.getByRole("group", { name: "Use in chat" })).toHaveCount(0);
  // The dialog lists the model with nothing preselected, so Save waits and Advanced is hidden.
  const emptyDialog = await openDecisionDialog(page);
  await expect(emptyDialog.getByRole("radio", { name: "UAT Classifier Model" })).not.toBeChecked();
  await expect(emptyDialog.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(emptyDialog.getByRole("button", { name: /^Advanced/ })).toHaveCount(0);
  await emptyDialog.getByRole("button", { name: "Cancel" }).click();

  // Pick a decision model, reload, confirm it stuck from the saved record.
  await selectClassifier(page);
  await expectGate(page, "Off");
  await page.reload();
  await openAssistantAndAiSettings(page);
  await expect(page.getByRole("button", { name: "Change model" })).toBeVisible();

  // Clear it, reload, confirm the saved record is cleared.
  await page.getByRole("button", { name: "Use main model" }).click();
  await expect(page.getByText("Not chosen")).toBeVisible();
  await page.reload();
  await openAssistantAndAiSettings(page);
  await expect(page.getByText("Not chosen")).toBeVisible();

  // Re-pick, then Watch only. On is open straight away, with no review step.
  await selectClassifier(page);
  await setGate(page, "Watch only");
  await expect(page.getByText("Watch only").first()).toBeVisible();
  await expect(page.getByText("On opens after shadow review.")).toHaveCount(0);
  // Ruling 1: the row states the admin-wide reach of the gate.
  await expect(page.getByText(/every user's eligible messages/).first()).toBeVisible();
  await page.reload();
  await openAssistantAndAiSettings(page);
  await expectGate(page, "Watch only");

  // Watch only to On through the dialog. The save lands and survives a reload.
  await setGate(page, "On");
  const stored = await json(page, "/api/admin/runtime-config/chat.classifier_gate_mode");
  expect(stored.status).toBe(200);
  expect((stored.body.config as { value: string }).value).toBe("on");
  await page.reload();
  await openAssistantAndAiSettings(page);
  await expectGate(page, "On");

  // An inherited On mode must disclose its instance-wide reach before Save, even with Advanced closed.
  const inheritedDialog = await openDecisionDialog(page);
  await expect(inheritedDialog.getByRole("status")).toContainText("Use in chat: On.");
  await expect(inheritedDialog.getByRole("status")).toContainText(
    "Eligible chat messages from everyone who uses this Moss go to Claude."
  );
  await expect(inheritedDialog.getByRole("group", { name: "Use in chat" })).toHaveCount(0);
  await inheritedDialog.getByRole("button", { name: "Cancel", exact: true }).click();

  // The row reads in light, dark and one park theme.
  for (const theme of [
    { name: "light", mode: "light", park: null },
    { name: "dark", mode: "dark", park: null },
    { name: "sage", mode: "light", park: "sage" }
  ] as const) {
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-color-mode", t.mode);
      if (t.park) document.documentElement.setAttribute("data-theme", t.park);
      else document.documentElement.removeAttribute("data-theme");
    }, theme);
    await expect(classifierHeading(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Change model" })).toBeVisible();
    if (process.env.MOSS_UAT_CAPTURE_OFF !== "1") {
      await page.screenshot({
        path: test.info().outputPath(`classifier-row-${theme.name}.png`),
        fullPage: true
      });
    }
  }
});

test.fixme("an ordinary chat message is still answered by the main model while the gate is Off", async () => {
  // #1121: this solo-admin seed has no chat-capable AI provider to answer a chat turn.
});
