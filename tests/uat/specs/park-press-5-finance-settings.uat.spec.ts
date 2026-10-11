import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { buildUatComposeArgs, restartUatStack } from "../provisioner.js";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

// Park Press check 5 (PR 3349), Finance limit settings. Seeded admin signed in through the real screen, Finance
// installed from its built package and enabled through Admin / Setup > Instance modules, then
// reached through the module's header settings link. Failed reads and failed saves are made by
// really stopping the server container. No Moss response is intercepted or rewritten.
test.use({ trace: "off", screenshot: "off", video: "off" });

test("Finance limit settings: unknown reads lock writes, failed saves keep confirmed values, retry only reads", async ({
  page
}) => {
  test.setTimeout(480_000);
  const projectName = process.env.JARVIS_UAT_PROJECT_NAME;
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!projectName || !baseURL) throw new Error("UAT project environment is not set");
  const compose = (args: string[], stdio: "inherit" | "pipe" = "inherit") =>
    execFileSync("docker", buildUatComposeArgs(projectName, args), { stdio, encoding: "utf8" });

  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: /^Account menu(?:,|$)/ })).toBeVisible();

  // ---- Install the repaired package and enable it through the real admin screen ----
  execFileSync("pnpm", ["build:external:finance"], { stdio: "inherit" });
  compose(["cp", "external-modules/finance", "jarv1s:/data/modules/finance"]);
  await restartUatStack(projectName, baseURL);
  await page.reload();
  await page.getByRole("button", { name: /^Account menu(?:,|$)/ }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Admin / Setup" }).click();
  await page.getByRole("button", { name: "Instance modules" }).click();
  const enable = page.getByRole("checkbox", { name: "Enable Finance", exact: true });
  await expect(enable).not.toBeChecked();
  await page.locator("label.jds-switch", { has: enable }).click();
  await expect(enable).toBeChecked();
  await restartUatStack(projectName, baseURL);
  await page.reload();

  // The package this instance actually loaded.
  const loadedManifest = JSON.parse(
    compose(["exec", "-T", "jarv1s", "cat", "/data/modules/finance/jarvis.module.json"], "pipe")
  ) as { version: string };
  console.log(`PARK_PRESS_FINANCE_VERSION_LOADED=${loadedManifest.version}`);
  expect(loadedManifest.version).toBe("0.6.9");

  // ---- Reach Settings through the module's header settings link ----
  const nav = page.locator('nav[aria-label="Main"]');
  await nav.getByRole("link", { name: "Finance" }).click();
  await expect(page.getByRole("link", { name: "Finance settings" })).toBeVisible({
    timeout: 30_000
  });
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/api/ai/action-policy"))
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    if (request.method() !== "GET" && request.url().includes("/api/finance"))
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const openSettings = async () =>
    page.getByRole("link", { name: "Finance settings", exact: true }).click();
  await openSettings();
  const settings = page.locator('section[aria-label="Finance settings"]');
  await expect(settings).toBeVisible();
  const limit = page.getByLabel("Moss can move up to, per move");
  await expect(limit).toBeEnabled();
  const confirmed = await limit.inputValue();
  expect(confirmed).toMatch(/^\$\d+$/);

  // ---- A failed save keeps the last confirmed value ----
  compose(["stop", "jarv1s"]);
  try {
    await limit.fill("$777");
    await limit.press("Enter");
    await expect(
      settings.getByText("Couldn't save the limit. Put back to the old amount.")
    ).toBeVisible();
    await expect(limit).toHaveValue(confirmed);

    // ---- Unknown read (server really down): remount Settings, writes locked ----
    await nav.getByRole("link", { name: "Finance" }).click();
    writes.length = 0;
    await openSettings();
    const alert = settings
      .getByRole("alert")
      .filter({ hasText: "Couldn't load your current choices" });
    await expect(alert).toContainText("Your settings can't be edited until both are confirmed.");
    await expect(limit).toBeDisabled();
    await expect(
      settings
        .getByRole("radiogroup", { name: "How much Moss does on its own" })
        .getByRole("radio")
        .first()
    ).toBeDisabled();
    // Retry while still down only re-reads and stays locked.
    await settings.getByRole("button", { name: "Retry loading settings" }).click();
    await expect(alert).toContainText("Your settings can't be edited until both are confirmed.");
    await expect(limit).toBeDisabled();
    expect(writes, "retry must not write").toEqual([]);
  } finally {
    await restartUatStack(projectName, baseURL);
  }

  // ---- Server back: retry recovers, and the value is the confirmed one, not the failed edit ----
  await settings.getByRole("button", { name: "Retry loading settings" }).click();
  await expect(limit).toBeEnabled({ timeout: 30_000 });
  await expect(limit).toHaveValue(confirmed);
  expect(writes, "recovery retry must not write").toEqual([]);
  // Persisted truth after reload.
  await page.reload();
  await expect(page.getByLabel("Moss can move up to, per move")).toHaveValue(confirmed);

  // ---- Customize disclosure at phone width: spacing and hit targets ----
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const toggle = page.getByRole("button", { name: /^Customize/ });
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.focus();
      await page.keyboard.press("Enter");
    }
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const metrics = await page.evaluate(() => {
      const t = [...document.querySelectorAll("button")].find((b) =>
        (b.textContent ?? "").trim().startsWith("Customize")
      ) as HTMLElement;
      const marker = t.querySelector(".fnm-disclosure-marker") as HTMLElement;
      const range = document.createRange();
      const textNode = [...t.childNodes].find((n) => n.nodeType === 3) as Text;
      range.selectNodeContents(textNode);
      const text = range.getBoundingClientRect();
      const mark = marker.getBoundingClientRect();
      const box = t.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const tapHits = [-20, 0, 20].map((dy) => {
        const hit = document.elementFromPoint(cx, cy + dy);
        return hit !== null && t.contains(hit);
      });
      const switches = [...document.querySelectorAll("#fnm-customize .fnm-switch-row")]
        .map((row) => row.querySelector("label.jds-switch, button") as HTMLElement | null)
        .filter((control): control is HTMLElement => control !== null)
        .map((control) => {
          const r = control.getBoundingClientRect();
          return { w: r.width, h: r.height };
        });
      return {
        gap: mark.left - text.right,
        toggleW: box.width,
        toggleH: box.height,
        switches,
        tapHits,
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    console.log(`PARK_PRESS_FINANCE_DISCLOSURE width=${width} ${JSON.stringify(metrics)}`);
    expect.soft(metrics.gap, `marker clears the word at ${width}px`).toBeGreaterThanOrEqual(4);
    // The shared disclosure control adds a 44px tap zone on phones, so the real target is probed
    // with elementFromPoint at the centre and 20px above and below it.
    expect.soft(metrics.tapHits, `Customize tap zone at ${width}px`).toEqual([true, true, true]);
    // The shared switch (40x23) is unchanged from main; recorded in the log line, not asserted.
    expect.soft(metrics.sideways).toBeLessThanOrEqual(0);
    // Keyboard collapse works too.
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  }
});
