import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

// Park Press check 6, reduced motion. Playwright's reducedMotion: "reduce" emulates the OS
// "reduce motion" setting inside Chromium (prefers-reduced-motion: reduce). It is browser
// emulation, not a real OS setting. Real seeded data, real routes, no Moss response is altered.
test.use({ trace: "off", screenshot: "off", video: "off", reducedMotion: "reduce" });

interface MotionReport {
  readonly elements: number;
  readonly maxTransitionMs: number;
  readonly maxAnimationMs: number;
  readonly worst: string;
}

function toMs(value: string): number {
  return Math.max(
    0,
    ...value.split(",").map((part) => {
      const v = part.trim();
      if (v.endsWith("ms")) return parseFloat(v);
      if (v.endsWith("s")) return parseFloat(v) * 1000;
      return 0;
    })
  );
}

/** Longest computed transition and animation among an element, its descendants and pseudos. */
async function motionOf(target: Locator): Promise<MotionReport> {
  const raw = await target.evaluate((root) => {
    const all = [root, ...Array.from(root.querySelectorAll("*"))];
    const rows: Array<{ n: string; t: string; a: string }> = [];
    for (const el of all) {
      for (const pseudo of [null, "::before", "::after"]) {
        const s = getComputedStyle(el, pseudo);
        rows.push({
          n: `${el.tagName.toLowerCase()}.${(el as HTMLElement).className || ""}${pseudo ?? ""}`,
          t: s.transitionDuration,
          a: s.animationName === "none" ? "0s" : s.animationDuration
        });
      }
    }
    return { count: all.length, rows };
  });
  let maxT = 0;
  let maxA = 0;
  let worst = "";
  for (const row of raw.rows) {
    const t = toMs(row.t);
    const a = toMs(row.a);
    if (t > maxT) {
      maxT = t;
      worst = `transition ${row.n}`;
    }
    if (a > maxA) {
      maxA = a;
      worst = `animation ${row.n}`;
    }
  }
  return { elements: raw.count, maxTransitionMs: maxT, maxAnimationMs: maxA, worst };
}

const sampled: string[] = [];
async function expectNoMotion(label: string, target: Locator): Promise<void> {
  const report = await motionOf(target);
  console.log(`PARK_PRESS_REDUCED_MOTION sample="${label}" ${JSON.stringify(report)}`);
  sampled.push(label);
  expect(
    report.maxTransitionMs,
    `${label}: longest transition (${report.worst})`
  ).toBeLessThanOrEqual(1);
  expect(
    report.maxAnimationMs,
    `${label}: longest animation (${report.worst})`
  ).toBeLessThanOrEqual(1);
}

async function activeInside(page: Page, scope: Locator): Promise<boolean> {
  const handle = await scope.elementHandle();
  if (!handle) return false;
  return page.evaluate(
    ([root]) =>
      !!root && document.activeElement !== document.body && root.contains(document.activeElement),
    [handle] as const
  );
}

async function visibleFocusRing(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return false;
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
    const shadow = s.boxShadow !== "none";
    return outline || shadow;
  });
}

test("reduced motion: sampled controls drop motion and keep focus and status feedback", async ({
  page
}) => {
  test.setTimeout(420_000);
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!projectName || !baseURL) throw new Error("UAT project environment is not set");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(baseURL);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
    true
  );
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const menuButton = page.getByRole("button", { name: /^Account menu(?:,|$)/ });
  await expect(menuButton).toBeVisible({ timeout: 30_000 });

  // ---- Menu (account menu) ----
  await menuButton.click();
  const menu = page.getByRole("menu").first();
  await expect(menu).toBeVisible();
  await expectNoMotion("account menu open", menu);
  expect(await activeInside(page, menu), "focus moved into the open menu").toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(menuButton).toBeFocused();
  expect(await visibleFocusRing(page), "focus ring visible after menu closes").toBe(true);

  // ---- Task dialog (modal) ----
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Tasks" }).click();
  const opener = page.getByRole("button", { name: /^Open Review PR backlog/ }).first();
  await expect(opener).toBeVisible({ timeout: 30_000 });
  await opener.focus();
  await page.keyboard.press("Enter");
  const taskDialog = page.getByRole("dialog", { name: "Task details" });
  await expect(taskDialog).toBeVisible();
  await expect(taskDialog.getByRole("textbox", { name: "Task title" })).toHaveValue(
    /Review PR backlog/
  );
  await expectNoMotion("task details dialog open", taskDialog);
  expect(await activeInside(page, taskDialog), "focus inside the task dialog").toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(opener).toBeFocused();

  // ---- Wellness: modal, feeling selection ----
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Wellness" })
    .click();
  await page.getByRole("button", { name: "Start check-in" }).click();
  const checkin = page.getByRole("dialog");
  await expect(checkin.getByText("How are you feeling right now?")).toBeVisible();
  await expectNoMotion("wellness check-in dialog open", checkin);
  await checkin.locator(".wl-dial__seg", { hasText: "Happy" }).click();
  const shades = checkin.getByRole("radiogroup", { name: "Shade of Happy", exact: true });
  await expect(shades).toBeVisible();
  await expectNoMotion("wellness shade options", shades);
  await shades.getByRole("radio", { name: "Joy", exact: true }).click();
  await expect(
    checkin.getByText("Body sensations that come with “Joy.”", { exact: false })
  ).toBeVisible();
  // End state reached without waiting on motion, and focus did not fall to the page body.
  expect(await activeInside(page, checkin), "focus stays inside after choosing a feeling").toBe(
    true
  );
  await expectNoMotion("wellness detail fields after selection", checkin);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // ---- Phone navigation ----
  await page.setViewportSize({ width: 390, height: 844 });
  const openNav = page.getByRole("button", { name: "Open navigation" });
  await expect(openNav).toBeVisible();
  await openNav.click();
  const closeNav = page.getByRole("button", { name: "Close navigation" });
  await expect(closeNav).toBeVisible();
  const navRegion = page.getByRole("navigation", { name: "Main" });
  await expectNoMotion("phone navigation open", navRegion);
  // The product leaves focus on the opener when the drawer opens (it does not move it inside).
  // Record where focus is, and assert it is not lost to the page body.
  const navFocus = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el && el !== document.body
      ? `${el.tagName.toLowerCase()}[aria-label="${el.getAttribute("aria-label") ?? ""}"]`
      : "body";
  });
  console.log(`PARK_PRESS_REDUCED_MOTION nav-open-focus=${navFocus}`);
  expect(navFocus, "focus not lost to the page body while the drawer is open").not.toBe("body");
  await closeNav.click();
  await expect(closeNav).toBeHidden();
  const afterClose = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el && el !== document.body ? (el.getAttribute("aria-label") ?? el.tagName) : "body";
  });
  console.log(`PARK_PRESS_REDUCED_MOTION nav-close-focus=${afterClose}`);
  await page.setViewportSize({ width: 1280, height: 800 });

  // ---- Progress and retry status: companion link request, with a genuinely stopped server ----
  const verifier = randomUUID() + randomUUID();
  const created = await fetch(`${baseURL}/api/companion/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      deviceName: "Reduced motion example Mac",
      platform: "macos",
      appVersion: "1.0.0",
      osVersion: "15.0",
      verifierHash: createHash("sha256").update(verifier).digest("base64url")
    })
  });
  expect(created.status).toBe(200);
  const approvalPath = ((await created.json()) as { approvalPath: string }).approvalPath;
  await page.goto(new URL(approvalPath, baseURL).toString());
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeEnabled({ timeout: 30_000 });
  execFileSync("docker", buildUatComposeArgs(projectName, ["stop", "jarv1s"]), {
    stdio: "inherit"
  });
  try {
    await page.getByRole("button", { name: "Decline", exact: true }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Couldn't confirm your answer");
    await expectNoMotion("companion failure status", alert);
    const retry = page.getByRole("button", { name: "Check request again" });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(page.getByRole("alert")).toContainText("Couldn't check this request");
    await expectNoMotion("companion retry status", page.getByRole("alert"));
  } finally {
    await restartUatStack(projectName, baseURL);
  }
  await page.getByRole("button", { name: "Check request again" }).click();
  await expect(approve).toBeEnabled({ timeout: 30_000 });

  console.log(`PARK_PRESS_REDUCED_MOTION_SAMPLED ${JSON.stringify(sampled)}`);
});
