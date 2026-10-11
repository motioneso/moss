import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Classifier gate plan 1.3 (#2892). Proves the shipped Classifier settings row on the real
// Settings > AI providers screen: pick and clear a classifier, change the allowed gate state,
// confirm `on` is refused before the release gate, and that the row reads in light, dark and one
// park theme. The "default chat is unchanged" half needs a real chat turn; the UAT harness has no
// chat-capable AI provider at any seed level (#1121), so it is test.fixme'd with that citation.
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

const classifierSelect = (page: Page) => page.getByLabel("Classifier model", { exact: true });
const classifierHeading = (page: Page) =>
  page.locator(".rt__name").filter({ hasText: "Classifier" }).first();
const gateButton = (page: Page, name: string) =>
  page.getByRole("group", { name: "Gate state" }).getByRole("button", { name });

async function selectClassifier(page: Page): Promise<void> {
  await classifierSelect(page).selectOption({ label: "UAT Classifier Model" });
  await expect(classifierSelect(page)).toHaveValue(/^model:/);
}

test("the Classifier settings row picks and clears a classifier and gates `on` (#2892)", async ({
  page
}) => {
  test.setTimeout(240_000);
  await signIn(page);
  await openAssistantAndAiSettings(page);

  // A JSON-capable model under a sorting-bindable provider kind (Anthropic CLI, created like the
  // #2842 spec) is what the Classifier row offers.
  await page.getByRole("button", { name: "Add provider" }).click();
  await page.getByRole("button", { name: "Anthropic", exact: true }).click();
  const ownerCard = page.locator(".prov").filter({ has: page.getByLabel("Remove Anthropic") });
  await expect(ownerCard).toBeVisible({ timeout: 30_000 });
  await ownerCard.getByRole("button", { name: "Add model", exact: true }).click();
  await ownerCard.getByLabel("Model id").fill("uat-classifier-model");
  await ownerCard.getByLabel("Display name").fill("UAT Classifier Model");
  await ownerCard.getByRole("checkbox", { name: "JSON" }).check();
  await ownerCard.getByRole("button", { name: "Add model", exact: true }).last().click();
  await expect(ownerCard.locator(".mdl__id", { hasText: "uat-classifier-model" })).toBeVisible({
    timeout: 30_000
  });

  // The row is renamed and shows the approved disclosure control.
  await expect(classifierHeading(page)).toBeVisible();
  await expect(page.locator(".rt__name").filter({ hasText: "Sorting model" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Gate state" })).toBeVisible();
  await expect(gateButton(page, "Off")).toHaveAttribute("aria-pressed", "true");
  // No classifier chosen yet: the mockup keeps the gate unusable.
  await expect(gateButton(page, "Shadow")).toBeDisabled();

  // Pick a classifier, reload, confirm it stuck from the saved record.
  await selectClassifier(page);
  await expect(gateButton(page, "Shadow")).toBeEnabled();
  await page.reload();
  await openAssistantAndAiSettings(page);
  await expect(classifierSelect(page)).toHaveValue(/^model:/);

  // Clear it, reload, confirm the saved record is cleared.
  await classifierSelect(page).selectOption({ label: "Use main model" });
  await expect(classifierSelect(page)).toHaveValue("");
  await page.reload();
  await openAssistantAndAiSettings(page);
  await expect(classifierSelect(page)).toHaveValue("");

  // Re-pick, then the allowed gate state: Shadow. `On` stays unusable before the release gate.
  await selectClassifier(page);
  await gateButton(page, "Shadow").click();
  await expect(gateButton(page, "Shadow")).toHaveAttribute("aria-pressed", "true");
  await expect(gateButton(page, "On")).toBeDisabled();
  await expect(gateButton(page, "On")).toHaveAttribute(
    "title",
    "Available after shadow results are reviewed"
  );
  // Ruling 1: the row states the admin-wide reach of the gate.
  await expect(page.getByText(/every user's eligible messages/)).toBeVisible();
  await page.reload();
  await openAssistantAndAiSettings(page);
  await expect(gateButton(page, "Shadow")).toHaveAttribute("aria-pressed", "true");

  // A forged `on` write is refused (409) and does not change the stored record.
  const refused = await json(page, "/api/admin/runtime-config/chat.classifier_gate_mode", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "on" })
  });
  expect(refused.status).toBe(409);
  const stored = await json(page, "/api/admin/runtime-config/chat.classifier_gate_mode");
  expect(stored.status).toBe(200);
  expect((stored.body.config as { value: string }).value).toBe("shadow");

  // The row reads in light, dark and one park theme; screenshots are bounded evidence.
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
    await expect(page.getByRole("group", { name: "Gate state" })).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`classifier-row-${theme.name}.png`),
      fullPage: true
    });
  }
});

test.fixme("an ordinary chat message is still answered by the main model while the gate is unreleased", async () => {
  // #1121: no UAT seed level can drive a real chat turn to a model reply, so this cannot execute
  // yet. The gate's live chat proof lands with slice 4.3.
});
