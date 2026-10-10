import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

export const uatLevel = { level: "bare", without: [] } as const;

// Park Press check 5: starts on an empty instance, signs up the owner through the real screen,
// then exercises the companion link request page. No response is altered. The "Mac" is a plain
// HTTP client of the real pairing route.
test.use({ trace: "off", screenshot: "off", video: "off" });

const LONG_DEVICE_NAME = "Ben's extraordinarily long-named MacBook Pro 16-inch Space Black";

test("fresh owner signs up on the real screen and the link request page tells states apart", async ({
  page
}) => {
  test.setTimeout(180_000);
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) throw new Error("UAT project environment is not set");

  // ---- Real sign-up screen on an empty instance ----
  await page.goto(baseURL);
  await expect(page.getByRole("heading", { name: "Create owner account" })).toBeVisible({
    timeout: 30_000
  });
  await page.getByLabel("Name").fill("Fresh Owner");
  await page.getByLabel("Email").fill("fresh-owner@example.test");
  await page.getByLabel("Password").fill("fresh-owner-password-1");
  await page.locator("form.auth-form").getByRole("button", { name: "Create account" }).click();
  // A new owner lands on first-run setup, which proves the account was created and signed in.
  await expect(page.getByRole("complementary", { name: "Onboarding progress" })).toBeVisible({
    timeout: 30_000
  });

  // Setup is optional; skipping it through the real button reaches the app shell.
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "Skip anyway" }).click();
  await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible({
    timeout: 30_000
  });

  // ---- A Mac asks to link, with the longest allowed name ----
  const verifier = randomUUID() + randomUUID();
  const created = await fetch(`${baseURL}/api/companion/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceName: LONG_DEVICE_NAME,
      platform: "macos",
      appVersion: "1.0.0",
      osVersion: "15.0",
      verifierHash: createHash("sha256").update(verifier).digest("base64url")
    })
  });
  expect(created.status).toBe(200);
  const approvalPath = ((await created.json()) as { approvalPath: string }).approvalPath;
  const code = new URLSearchParams(new URL(approvalPath, baseURL).hash.slice(1)).get("code");
  expect(code).toBeTruthy();

  // The link a Mac opens is a full navigation by design.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(new URL(approvalPath, baseURL).toString());
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeEnabled({ timeout: 30_000 });
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  console.log(`PARK_PRESS_FRESH_OWNER long-name sideways=${sideways}`);
  expect(sideways).toBeLessThanOrEqual(0);

  // ---- Changed behaviour: an invalid code is an alert with no retry ----
  await page.goto(`${baseURL}/link/trail-marker#code=not-a-real-code`);
  await expect(page.getByRole("alert")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Check request again" })).toHaveCount(0);

  // ---- Approve, then reopen: closed is shown as connected, not as an error ----
  await page.goto(new URL(approvalPath, baseURL).toString());
  await expect(approve).toBeEnabled({ timeout: 30_000 });
  await approve.click();
  await page.goto(new URL(approvalPath, baseURL).toString());
  await expect(page.getByRole("heading", { name: "That Mac is connected" })).toBeVisible({
    timeout: 30_000
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Check request again" })).toHaveCount(0);
  console.log("PARK_PRESS_FRESH_OWNER signup-real-screen invalid-vs-closed ok");
});
