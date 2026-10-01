import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

// #2689 slice 4: a held back tool update shows an amber notice with the reason and a Retry
// button, and Retry calls the admin-only check route. The UAT instance has no tool runner, so the
// provider list answer is replaced in the browser. This proves the screen and the button wiring,
// not the server-side check (that is covered by the live proof on a dev instance).
test("held back tool update shows a notice and Retry asks for a new check", async ({ page }) => {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");

  const provider = {
    id: "00000000-0000-4000-8000-0000000026a9",
    providerKind: "anthropic",
    displayName: "Claude",
    acpAgentId: "claude",
    baseUrl: null,
    status: "active",
    authMethod: "cli",
    hasCredential: false,
    cliAvailable: true,
    executionMode: "interactive",
    isInstanceDefault: false,
    revokedAt: null,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    cliTools: {
      version: "2.1.282",
      state: "held_back",
      candidateVersion: "2.1.290",
      reason: "couldn't use Moss's tools in a test chat"
    }
  };
  await page.route("**/api/ai/providers", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { providers: [provider] } })
      : route.continue()
  );
  let retried = false;
  await page.route("**/api/ai/providers/*/cli-check", (route) => {
    retried = true;
    return route.fulfill({
      json: { provider: { ...provider, cliTools: { version: "2.1.282", state: "current" } } }
    });
  });

  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();

  // Wait for the signed-in screen so the sign-in request finishes before moving on.
  await expect(page.locator(".jds-masthead__eyebrow")).toBeVisible();

  await page.goto(`${baseURL}/settings?section=aiproviders`);
  await expect(page.getByText("Version 2.1.290 held back")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => retried).toBe(true);
});
