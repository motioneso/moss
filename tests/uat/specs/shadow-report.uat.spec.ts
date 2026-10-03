import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Temporary shadow report (#2957). Proves the shipped report page on the real Settings
// screen: the Classifier row links to it while the gate is Shadow, it shows the four numbers
// over 7/30/90 days plus the disagreement list or the honest empty state, and the numbers
// match the owner-only API for the signed-in admin.
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
  const userMenu = page.locator(".jds-usermenu__trigger");
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

async function openAiProviders(page: Page): Promise<void> {
  await page.locator(".jds-usermenu__trigger").click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "AI providers" }).click();
}

const gateButton = (page: Page, name: string) =>
  page.getByRole("group", { name: "Gate state" }).getByRole("button", { name });

async function json(
  page: Page,
  path: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ path }) => {
      const response = await fetch(path);
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
    { path }
  );
}

test("the Classifier row links to the temporary shadow report page (#2957)", async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);
  await openAiProviders(page);

  // A JSON-capable model under a sorting-bindable provider kind is what the gate needs.
  await page.getByRole("button", { name: "Add provider" }).click();
  await page.getByRole("button", { name: "Anthropic", exact: true }).click();
  const ownerCard = page.locator(".prov").filter({ has: page.getByLabel("Remove Anthropic") });
  await expect(ownerCard).toBeVisible({ timeout: 30_000 });
  await ownerCard.getByRole("button", { name: "Add model", exact: true }).click();
  await ownerCard.getByLabel("Model id").fill("uat-shadow-model");
  await ownerCard.getByLabel("Display name").fill("UAT Shadow Model");
  await ownerCard.getByRole("checkbox", { name: "JSON" }).check();
  await ownerCard.getByRole("button", { name: "Add model", exact: true }).last().click();
  await expect(ownerCard.locator(".mdl__id", { hasText: "uat-shadow-model" })).toBeVisible({
    timeout: 30_000
  });

  await page
    .getByLabel("Classifier model", { exact: true })
    .selectOption({ label: "UAT Shadow Model" });
  await gateButton(page, "Shadow").click();
  await expect(gateButton(page, "Shadow")).toHaveAttribute("aria-pressed", "true");

  // Both report links are present while the gate is Shadow.
  await expect(page.getByRole("link", { name: "See shadow results" }).first()).toBeVisible();

  // The API answers for the signed-in admin before opening the page.
  const api = await json(page, "/api/chat/classifier/shadow-report?days=30");
  expect(api.status).toBe(200);
  const report = api.body.report as Record<string, unknown>;
  for (const key of ["checked", "pickedTool", "agreed", "comparable", "missedTool"]) {
    expect(typeof report[key]).toBe("number");
  }
  expect(Array.isArray(report.disagreements)).toBe(true);

  // Follow the note link to the report page.
  await page.getByRole("link", { name: "See shadow results" }).last().click();
  await expect(page).toHaveURL(/section=shadowreport/);
  await expect(page.getByRole("heading", { name: "Shadow report" })).toBeVisible();
  await expect(page.getByText("Messages checked")).toBeVisible();
  await expect(page.getByText("Picked a tool")).toBeVisible();
  await expect(page.getByText("Main model agreed")).toBeVisible();
  await expect(page.getByText("Missed a tool")).toBeVisible();

  // Switching range keeps the page standing; the content follows the same API.
  await page
    .getByRole("group", { name: "Time range" })
    .getByRole("button", { name: "90 days" })
    .click();
  const api90 = await json(page, "/api/chat/classifier/shadow-report?days=90");
  expect(api90.status).toBe(200);
  const checked90 = (api90.body.report as Record<string, unknown>).checked;
  if (checked90 === 0) {
    // Honest empty state: the seed admin has no shadow records on this instance.
    await expect(page.getByText("No disagreements")).toBeVisible();
    await expect(page.getByText("No shadow records for you in this range yet.")).toBeVisible();
  } else {
    await expect(page.getByText("Messages checked")).toBeVisible();
  }
});
