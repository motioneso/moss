// Live-Path Gate for #3019 - a custom theme can set the page header color.
// Runs against a REAL dev instance: real API, real database. Nothing is mocked.
//
// Run with:
//   LIVE_BASE_URL=http://127.0.0.1:<port> LIVE_OWNER_PASSWORD=... \
//     npx playwright test --config playwright.live.config.ts header-3019
import { expect, test, type Page } from "@playwright/test";

const OWNER_PASSWORD = process.env.LIVE_OWNER_PASSWORD;
if (!OWNER_PASSWORD) {
  throw new Error("Set LIVE_OWNER_PASSWORD to the development instance sign-in password.");
}
const OWNER = { email: "ben@ben.com", password: OWNER_PASSWORD };
const SHOTS = process.env.LIVE_SHOT_DIR ?? "/tmp/theme-header-color";
const THEME_ID = "header-3019-dark-start";

// The values a theme editor reads from the built-in dark mode when a new theme starts from it.
const DARK_START = {
  paper: "#1c1a16",
  surface: "#232019",
  surface2: "#2a271f",
  surface3: "#322e25",
  ink: "#ece7dc",
  ink2: "#b7b1a2",
  ink3: "#8a8576",
  ink4: "#736e60",
  line: "rgba(255, 255, 255, 0.08)",
  lineSubtle: "rgba(255, 255, 255, 0.04)",
  lineStrong: "rgba(255, 255, 255, 0.16)",
  accent: "#294b39"
};
const LIGHT_START = {
  paper: "#f6f1e4",
  surface: "#fbf8ef",
  surface2: "#f1ebdb",
  surface3: "#e8e0cb",
  ink: "#282c25",
  ink2: "#4d5147",
  ink3: "#6b6e63",
  ink4: "#8a8c80",
  line: "rgba(38, 34, 28, 0.1)",
  lineSubtle: "rgba(38, 34, 28, 0.05)",
  lineStrong: "rgba(38, 34, 28, 0.2)",
  accent: "#294b39"
};

async function signInThroughUi(page: Page) {
  await page.goto("/");
  await page.getByLabel(/email/i).fill(OWNER.email);
  await page.getByLabel(/password/i).fill(OWNER.password);
  await page
    .locator("form")
    .getByRole("button", { name: /sign in/i })
    .click();
  await expect(page.getByRole("navigation").first()).toBeVisible();
}

async function api(page: Page, method: string, path: string, body?: unknown) {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method,
        credentials: "include",
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, path, body }
  );
}

function channels(color: string): [number, number, number] {
  const m = color.match(/[\d.]+/g)!.map(Number);
  return [m[0]!, m[1]!, m[2]!];
}
function lum([r, g, b]: [number, number, number]) {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string) {
  const [l1, l2] = [lum(channels(a)), lum(channels(b))];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const NAV = "#e7ebdf";
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 }
];
// Header grounds picked to cover dark, light and a mid-tone that needs full black or white text.
const headers = [
  { name: "dark-green", color: "#14231a" },
  { name: "bone", color: "#f4efe2" },
  { name: "mid-grey", color: "#808080" }
];
const starts = [
  { name: "light", mode: "light", tokens: LIGHT_START },
  { name: "dark", mode: "dark", tokens: DARK_START }
];

async function labelsOf(page: Page) {
  const bar = page.locator(".topbar").first();
  await expect(bar).toBeVisible();
  await expect(bar.locator(".topbar-title").first()).toBeVisible();
  const bg = await bar.evaluate((el) => getComputedStyle(el).backgroundColor);
  const labels = await bar.evaluate((el) =>
    [...el.querySelectorAll("*")]
      .filter((n) => [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent?.trim()))
      .map((n) => ({
        text: (n.textContent ?? "").trim().slice(0, 30),
        color: getComputedStyle(n).color
      }))
  );
  const cogLocator = bar.locator(".topbar-settings-button");
  const cog =
    (await cogLocator.count()) > 0
      ? await cogLocator.first().evaluate((el) => getComputedStyle(el).color)
      : null;
  return { bar, bg, labels, cog };
}

test("page header color paints the desktop strip, phones follow the nav color", async ({
  page
}) => {
  test.setTimeout(240_000);
  await signInThroughUi(page);
  const before = (await api(page, "GET", "/api/me/themes")).json;
  try {
    for (const start of starts) {
      await api(page, "PUT", "/api/me/themes/mode", { mode: start.mode });
      for (const header of headers) {
        const put = await api(page, "PUT", `/api/me/themes/${THEME_ID}`, {
          name: "Header 3019",
          tokens: { ...start.tokens, nav: NAV, header: header.color }
        });
        expect(put.status, JSON.stringify(put.json)).toBe(200);
        expect((await api(page, "PUT", "/api/me/themes/active", { id: THEME_ID })).status).toBe(
          200
        );
        for (const vp of viewports) {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await page.goto("/");
          await expect(page.locator("html")).toHaveAttribute("data-theme", THEME_ID);
          let { bar, bg, labels, cog } = await labelsOf(page);
          if (!cog) {
            // Module pages carry the settings cog beside the title.
            await page.goto("/tasks");
            await expect(page.locator("html")).toHaveAttribute("data-theme", THEME_ID);
            ({ bar, bg, labels, cog } = await labelsOf(page));
          }
          const want = vp.name === "desktop" ? header.color : NAV;
          expect(channels(bg)).toEqual(channels(hexToRgb(want)));
          expect(labels.length).toBeGreaterThanOrEqual(2);
          for (const label of [...labels, ...(cog ? [{ text: "cog", color: cog }] : [])]) {
            const ratio = contrast(bg, label.color);
            console.log(
              `${start.name} ${header.name} ${vp.name}: "${label.text}" ${label.color} on ${bg} = ${ratio.toFixed(2)}`
            );
            expect(ratio, `${label.text} on the header`).toBeGreaterThanOrEqual(4.5);
          }
          const box = await bar.boundingBox();
          await page.screenshot({
            path: `${SHOTS}/${start.name}-${header.name}-${vp.name}.png`,
            clip: { x: 0, y: 0, width: vp.width, height: Math.ceil((box?.height ?? 64) + 4) }
          });
        }
      }
    }
  } finally {
    await api(page, "PUT", "/api/me/themes/active", { id: before.activeId });
    await api(page, "PUT", "/api/me/themes/mode", { mode: before.mode });
    await api(page, "DELETE", `/api/me/themes/${THEME_ID}`);
  }
});

test("a saved theme without a header color keeps today's strip", async ({ page }) => {
  test.setTimeout(120_000);
  await signInThroughUi(page);
  const before = (await api(page, "GET", "/api/me/themes")).json;
  try {
    const put = await api(page, "PUT", `/api/me/themes/${THEME_ID}`, {
      name: "Header 3019",
      tokens: LIGHT_START
    });
    expect(put.status).toBe(200);
    await api(page, "PUT", "/api/me/themes/active", { id: THEME_ID });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", THEME_ID);
    await expect(page.locator("html")).not.toHaveAttribute("data-header-color", "");
    const { bg } = await labelsOf(page);
    // The page color #f6f1e4 at 85% over the page, exactly as before this change.
    expect(bg).toMatch(/^rgba\(246, 241, 228, 0\.85\)$/);
  } finally {
    await api(page, "PUT", "/api/me/themes/active", { id: before.activeId });
    await api(page, "DELETE", `/api/me/themes/${THEME_ID}`);
  }
});

test("clicking the header in the editor preview selects the Page header color", async ({
  page
}) => {
  test.setTimeout(120_000);
  await signInThroughUi(page);
  const before = (await api(page, "GET", "/api/me/themes")).json;
  try {
    const put = await api(page, "PUT", `/api/me/themes/${THEME_ID}`, {
      name: "Header 3019",
      tokens: { ...LIGHT_START, header: "#14231a" }
    });
    expect(put.status).toBe(200);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/settings?section=appearance");
    const card = page.locator("text=Header 3019").first();
    await expect(card).toBeVisible();
    await card
      .locator("xpath=ancestor::*[.//button[normalize-space()='Edit']][1]")
      .getByRole("button", { name: "Edit" })
      .click();
    await expect(page.getByRole("heading", { name: "Page header" })).toBeVisible();
    const strip = page.locator('.theme-pv [data-part="header"]');
    await expect(strip).toBeVisible();
    await strip.click();
    await expect(
      page.getByRole("dialog", { name: /Page header background/ }).first()
    ).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/editor-preview-pick.png` });
    await page.keyboard.press("Escape");
    await page.getByRole("heading", { name: "Page header" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/editor-header-group.png` });
  } finally {
    await api(page, "PUT", "/api/me/themes/active", { id: before.activeId });
    await api(page, "DELETE", `/api/me/themes/${THEME_ID}`);
  }
});

const THEME_B = "header-3019-plain";

async function openEditor(page: Page, name: string) {
  await page.goto("/settings?section=appearance");
  const card = page.locator(`text=${name}`).first();
  await expect(card).toBeVisible();
  await card
    .locator("xpath=ancestor::*[.//button[normalize-space()='Edit']][1]")
    .getByRole("button", { name: "Edit" })
    .click();
  await expect(page.getByRole("heading", { name: "Page header" })).toBeVisible();
}

test("Reset to default on the Page header shows the theme's own page color in the preview", async ({
  page
}) => {
  test.setTimeout(240_000);
  await signInThroughUi(page);
  const before = (await api(page, "GET", "/api/me/themes")).json;
  const GREEN = "#14231a";
  const RED = "#7a1f1f";
  try {
    // Active theme has a dark green header; the theme being edited has none and a bone page color.
    const active = await api(page, "PUT", `/api/me/themes/${THEME_ID}`, {
      name: "Header 3019",
      tokens: { ...DARK_START, header: GREEN }
    });
    expect(active.status, JSON.stringify(active.json)).toBe(200);
    const plain = await api(page, "PUT", `/api/me/themes/${THEME_B}`, {
      name: "Plain 3019",
      tokens: LIGHT_START
    });
    expect(plain.status, JSON.stringify(plain.json)).toBe(200);
    expect((await api(page, "PUT", "/api/me/themes/active", { id: THEME_ID })).status).toBe(200);

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openEditor(page, "Plain 3019");
      const preview = page.locator('.theme-pv [data-part="header"]');
      const section = page
        .locator("section.theme-fields")
        .filter({ has: page.getByRole("heading", { name: "Page header" }) });
      const previewBg = () => preview.evaluate((el) => getComputedStyle(el).backgroundColor);
      const frame = page.locator(".theme-pv");

      // Before touching anything: the plain theme's own page color, not the active green.
      expect(channels(await previewBg())).toEqual(channels(hexToRgb(LIGHT_START.paper)));

      // Set a header color through the real picker.
      await preview.click();
      await page
        .getByRole("dialog", { name: /Page header background/ })
        .getByLabel("Any color")
        .fill(RED);
      await page.keyboard.press("Escape");
      expect(channels(await previewBg())).toEqual(channels(hexToRgb(RED)));
      await frame.screenshot({ path: `${SHOTS}/reset-${vp.name}-1-set.png` });

      // Reset to default: the preview returns to this theme's page color.
      await section.getByRole("button", { name: "Reset to default" }).click();
      expect(channels(await previewBg())).toEqual(channels(hexToRgb(LIGHT_START.paper)));
      expect(channels(await previewBg())).not.toEqual(channels(hexToRgb(GREEN)));
      const titleColor = await preview
        .locator(".theme-pv__header-title")
        .evaluate((el) => getComputedStyle(el).color);
      expect(contrast(hexToRgb(LIGHT_START.paper), titleColor)).toBeGreaterThanOrEqual(4.5);
      await frame.screenshot({ path: `${SHOTS}/reset-${vp.name}-2-after-reset.png` });
    }
  } finally {
    await api(page, "PUT", "/api/me/themes/active", { id: before.activeId });
    await api(page, "DELETE", `/api/me/themes/${THEME_ID}`);
    await api(page, "DELETE", `/api/me/themes/${THEME_B}`);
  }
});

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}
