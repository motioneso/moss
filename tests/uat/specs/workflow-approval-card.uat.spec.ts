import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "solo-admin",
  without: [],
  withWorkflowApprovalFixture: true
} as const;

test("owner reaches a live workflow approval card and resumes the run (#2015)", async ({
  page
}) => {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skipSetup = page.getByRole("button", { name: "Skip setup" });
  const userMenu = page.locator(".jds-usermenu__trigger");
  await expect(skipSetup.or(userMenu).first()).toBeVisible();
  if (await skipSetup.isVisible()) {
    await skipSetup.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(userMenu).toBeVisible();
  await page.getByRole("button", { name: "Chat with Moss" }).click();
  await page
    .getByRole("region", { name: "Workflow approval" })
    .getByRole("button", {
      name: "Approve"
    })
    .click();
  await expect(page.getByRole("region", { name: "Workflow approval" })).toContainText("Approved");
});
