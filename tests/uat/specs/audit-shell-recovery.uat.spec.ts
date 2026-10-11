import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";
import { requireUatBaseURL, requireUatProjectName } from "./real-chat-signin.js";
export const uatLevel = { level: "solo-admin", without: [] } as const;
test.use({ trace: "off", screenshot: "off", video: "off" });

// Read-only account recheck and unavailable module/registry states are mounted-unit covered.
// This real-stack proof covers interrupted onboarding, keyboard search and explicit module denial.
test("onboarding retries an actual outage and settings keyboard selection stays associated", async ({
  page
}) => {
  test.setTimeout(180_000);
  const project = requireUatProjectName();
  if (!project.startsWith("uat-")) throw new Error("Use the isolated UAT provisioner");
  let stopped = false;
  const control = (action: string) =>
    execFileSync(
      "docker",
      buildUatComposeArgs(project, [
        ...(action === "start" ? ["up", "-d", "--no-deps", "--no-recreate", "--wait"] : [action]),
        "jarv1s"
      ]),
      { stdio: "inherit" }
    );
  try {
    await page.goto(requireUatBaseURL());
    await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
    await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
    await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
    const skip = page.getByRole("button", { name: "Skip setup", exact: true });
    await expect(skip).toBeVisible();
    await skip.click();
    const confirm = page.getByRole("button", { name: "Skip anyway", exact: true });
    await expect(confirm).toBeVisible();
    control("stop");
    stopped = true;
    const failedRequest = page.waitForEvent("requestfailed", {
      predicate: (request) => new URL(request.url()).pathname === "/api/onboarding/skip"
    });
    await confirm.click();
    await failedRequest;
    await expect(page.getByRole("alert")).toContainText("Could not skip setup");
    await expect(page.getByRole("button", { name: "Retry skip", exact: true })).toBeVisible();
    control("start");
    stopped = false;
    const retried = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/onboarding/skip" &&
        response.request().method() === "POST"
    );
    await page.getByRole("button", { name: "Retry skip", exact: true }).click();
    expect((await retried).ok()).toBe(true);
    await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible();
    await page.goto(`${requireUatBaseURL()}/settings`);
    const search = page.getByRole("combobox", { name: "Search settings" });
    await search.fill("appearance");
    await expect(search).toHaveAttribute("aria-expanded", "true");
    const descendant = await search.getAttribute("aria-activedescendant");
    expect(descendant).toBeTruthy();
    await expect(page.locator(`[id="${descendant}"]`)).toHaveAttribute("role", "option");
    await search.press("Enter");
    await expect(search).toBeFocused();
    await expect(search).not.toHaveAttribute("aria-activedescendant", /.+/);
    await expect(page).toHaveURL(/section=appearance/);
    await page.request
      .patch("/api/me/modules/wellness", { data: { disabled: true } })
      .then((response) => expect(response.ok()).toBe(true));
    await page.goto(`${requireUatBaseURL()}/wellness?day=2026-10-11`);
    await expect(page).toHaveURL(/\/tasks$/);
  } finally {
    if (stopped) control("start");
    const restored = await page.request.patch("/api/me/modules/wellness", {
      data: { disabled: false }
    });
    expect(restored.ok(), "restore Wellness module enablement").toBe(true);
  }
});
