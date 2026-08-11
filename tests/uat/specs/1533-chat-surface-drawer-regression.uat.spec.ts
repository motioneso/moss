// tests/uat/specs/1533-chat-surface-drawer-regression.uat.spec.ts
//
// #1533 live-path proof, step 7: "Without a module mounted, open the ordinary drawer and send a
// harmless prompt. Confirm the default stream/send remain on `drawer` and the reply appears
// normally. Start/end a private chat once to confirm the drawer-only control remains functional."
// No module is installed in this spec — it proves the pre-#1533 drawer path is unaffected.
import { expect, test, type Page } from "@playwright/test";

import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "admin+data",
  without: [],
  chatScript: "phase1-smoke"
} as const;

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
  await expect(page.locator(".jds-usermenu__trigger")).toBeVisible();
}

test("chat surface routing: drawer-only regression, no module mounted (#1533)", async ({ page }) => {
  test.setTimeout(300_000);

  const streamRequestUrls: string[] = [];
  const turnRequestSurfaces: Array<string | undefined> = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("/api/chat/stream")) {
      streamRequestUrls.push(url);
    } else if (url.includes("/api/chat/turn") && request.method() === "POST") {
      try {
        const body = request.postDataJSON() as { surface?: string };
        turnRequestSurfaces.push(body?.surface);
      } catch {
        turnRequestSurfaces.push(undefined);
      }
    }
  });

  await test.step("Sign in, open the ordinary drawer (no module mounted)", async () => {
    await signIn(page);
    await page.locator(".topbar-actions button").click();
    await expect(page.locator(".topbar-actions button")).toHaveAttribute("aria-pressed", "true");
  });

  await test.step("Send a harmless prompt; reply appears with no approval card, no reload", async () => {
    const composer = page.getByRole("textbox", { name: /^Message/ });
    await composer.fill("What are my goals?");
    await composer.press("Enter");

    await expect(page.getByText("Here are your goals.")).toBeVisible({ timeout: 60_000 });

    // read-risk tools (goals.list) always auto-run per resolvePolicy — no card should ever appear.
    await expect(page.locator('[role="region"][aria-label="Action request"]')).toHaveCount(0);

    await expect
      .poll(() => streamRequestUrls.length > 0, { timeout: 10_000, message: "no /api/chat/stream request observed" })
      .toBe(true);
    const streamUrl = new URL(streamRequestUrls[streamRequestUrls.length - 1]!, requireBaseURL());
    // Absent (default drawer) or the literal "drawer" — both mean the default surface, never a
    // module hash.
    const surfaceParam = streamUrl.searchParams.get("surface");
    expect(surfaceParam === null || surfaceParam === "drawer", "stream must stay on the default drawer surface").toBe(
      true
    );

    await expect
      .poll(() => turnRequestSurfaces.length > 0, { timeout: 10_000, message: "no /api/chat/turn POST observed" })
      .toBe(true);
    const lastTurnSurface = turnRequestSurfaces[turnRequestSurfaces.length - 1];
    expect(
      lastTurnSurface === undefined || lastTurnSurface === "drawer",
      "turn POST must stay on the default drawer surface"
    ).toBe(true);
  });

  await test.step("Start then end a private chat; the drawer-only control still works", async () => {
    const privateToggle = page.getByRole("button", { name: "Start private chat" });
    await privateToggle.click();
    await expect(privateToggle).toHaveAttribute("aria-pressed", "true");

    await page.locator(".chatd-private").getByRole("button", { name: "End" }).click();
    await expect(privateToggle).toHaveAttribute("aria-pressed", "false");
  });
});
