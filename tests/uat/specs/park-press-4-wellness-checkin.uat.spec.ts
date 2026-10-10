import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { buildUatComposeArgs } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

// Park Press check 4 (PR 3348): Wellness check-in focus and pending-save guards, and the
// Wellness export entry. A save is really held pending by pausing the app container, and a save
// really fails by stopping it. No Moss response is intercepted or rewritten.
export const uatLevel = { level: "admin+data", without: [] } as const;

const execFileAsync = promisify(execFile);

function baseURL(): string {
  const value = process.env.JARVIS_UAT_BASE_URL;
  if (!value) throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  return value;
}

function uatProject(): string {
  const project = process.env.JARVIS_UAT_PROJECT_NAME;
  if (!project?.startsWith("uat-")) throw new Error("Refusing non-UAT target");
  return project;
}

async function composeApp(action: "stop" | "start" | "pause" | "unpause"): Promise<void> {
  await execFileAsync("docker", buildUatComposeArgs(uatProject(), [action, "postgres"]), {
    maxBuffer: 1_000_000
  });
  console.log(`[check4] app container ${action} done`);
}

async function waitHealthy(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return (await page.request.get(`${baseURL()}/health/ready`, { timeout: 3000 })).status();
        } catch {
          return 0;
        }
      },
      { timeout: 120_000, intervals: [1000] }
    )
    .toBe(200);
}

async function signIn(page: Page): Promise<void> {
  await page.goto(baseURL());
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip setup" });
  const menu = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(skip.or(menu).first()).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
  await expect(menu).toBeVisible();
}

async function activeDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return "none";
    return `${el.tagName.toLowerCase()}|${(el.textContent ?? "").trim().slice(0, 40)}`;
  });
}

async function openCheckin(page: Page) {
  const start = page.getByRole("button", { name: "Start check-in" });
  const again = page.getByRole("button", { name: "Check in again" });
  await expect(start.or(again).first()).toBeVisible({ timeout: 30_000 });
  await start.or(again).first().click();
  const dialog = page.getByRole("dialog", { name: "How are you feeling right now?" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function listCheckins(page: Page): Promise<number> {
  const response = await page.request.get(`${baseURL()}/api/wellness/checkins`);
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { checkins: unknown[] }).checkins.length;
}

test("Wellness check-in: focus after the chosen control disappears (LN02, LN03)", async ({
  page
}) => {
  test.setTimeout(240_000);
  await signIn(page);
  await page.goto(`${baseURL()}/wellness`);
  const dialog = await openCheckin(page);

  // Search path: keyboard-pick a specific feeling from the results list. The list vanishes.
  const search = dialog.getByLabel("Search feelings");
  await search.fill("anx");
  const firstResult = dialog.locator(".wl-search__item").first();
  await expect(firstResult).toBeVisible();
  await search.press("Tab");
  await expect(firstResult).toBeFocused();
  await firstResult.press("Enter");
  await expect(dialog.getByRole("heading", { name: "Where do you feel it?" })).toBeVisible();
  await expect(dialog.locator(".wl-search__item")).toHaveCount(0);
  const afterSearch = await activeDescription(page);
  console.log(`[check4] focus after search pick: ${afterSearch}`);
  expect(afterSearch.startsWith("h3|Where do you feel it?")).toBe(true);

  // Core-then-shade path: pick a core by search, then a shade by keyboard on the radio group.
  await search.fill("sad");
  const coreResult = dialog.locator(".wl-search__item", { hasText: /^Sad$/ }).first();
  await search.press("Tab");
  await expect(coreResult.or(dialog.locator(".wl-search__item").first())).toBeFocused();
  await page.keyboard.press("Enter");
  const shadeHeading = dialog.getByRole("heading", { name: /Which shade of/ });
  await expect(shadeHeading).toBeVisible();
  const afterCore = await activeDescription(page);
  console.log(`[check4] focus after core pick: ${afterCore}`);
  expect(afterCore.startsWith("h3|Which shade of")).toBe(true);

  // Real keyboard path: Tab from the focused heading into the shade group, then Space.
  await page.keyboard.press("Tab");
  console.log(`[check4] focus after Tab into shades: ${await activeDescription(page)}`);
  await expect(
    dialog.getByRole("radiogroup", { name: /Shade of/ }).locator("input:focus")
  ).toHaveCount(1);
  await page.keyboard.press("Space");
  await expect(dialog.getByRole("heading", { name: "Where do you feel it?" })).toBeVisible();
  await expect(shadeHeading).toHaveCount(0);
  const afterShade = await activeDescription(page);
  console.log(`[check4] focus after shade pick: ${afterShade}`);
  expect(afterShade.startsWith("h3|Where do you feel it?")).toBe(true);
  expect(afterShade.startsWith("body")).toBe(false);
});

test("Wellness check-in: failed save keeps the draft; pending save cannot be dismissed (LN02)", async ({
  page
}) => {
  test.setTimeout(420_000);
  await signIn(page);
  await page.goto(`${baseURL()}/wellness`);
  const before = await listCheckins(page);
  const dialog = await openCheckin(page);

  const search = dialog.getByLabel("Search feelings");
  await search.fill("anx");
  await search.press("Tab");
  await page.keyboard.press("Enter");
  const note = dialog.getByRole("textbox").last();
  await note.fill("Draft note that must survive a failed save");
  const save = dialog.getByRole("button", { name: "Save check-in" });
  await expect(save).toBeEnabled();

  // Genuine failure: the app is stopped, so the save request cannot be answered.
  await composeApp("stop");
  try {
    await save.click();
    await expect(dialog.getByRole("alert")).toContainText("Couldn't save your check-in", {
      timeout: 60_000
    });
    await expect(note).toHaveValue("Draft note that must survive a failed save");
    await expect(dialog).toBeVisible();
  } finally {
    await composeApp("start");
  }
  await waitHealthy(page);

  // Genuine pending: the app is paused, so the request hangs with no answer.
  await composeApp("pause");
  let unpaused = false;
  try {
    await save.click();
    await expect(dialog.getByRole("button", { name: "Saving…" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Close check-in" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();
    console.log("[check4] pending save: Escape, backdrop, Close and Cancel did not dismiss");
    await composeApp("unpause");
    unpaused = true;
  } finally {
    if (!unpaused) await composeApp("unpause");
  }
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(() => listCheckins(page), { timeout: 30_000 }).toBe(before + 1);
});

test("Wellness export entry is reachable by keyboard (LN07)", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.goto(`${baseURL()}/wellness`);
  const exportButton = page.getByRole("button", { name: "Export", exact: true });
  await expect(exportButton).toBeVisible({ timeout: 30_000 });
  await exportButton.focus();
  await exportButton.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Export for a clinician" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(exportButton).toBeFocused();
});
