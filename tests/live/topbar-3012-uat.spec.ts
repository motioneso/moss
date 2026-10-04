// Live-Path Gate for #3012 - the top bar stays readable in a custom theme made from dark mode.
// Runs against a REAL dev instance: real API, real database. Nothing is mocked.
//
// Run with:
//   LIVE_BASE_URL=http://127.0.0.1:<port> LIVE_OWNER_PASSWORD=... \
//     npx playwright test --config playwright.live.config.ts topbar-3012
import { expect, test, type Page } from "@playwright/test";

const OWNER_PASSWORD = process.env.LIVE_OWNER_PASSWORD;
if (!OWNER_PASSWORD) {
  throw new Error("Set LIVE_OWNER_PASSWORD to the development instance sign-in password.");
}
const OWNER = { email: "ben@ben.com", password: OWNER_PASSWORD };
const SHOTS = process.env.LIVE_SHOT_DIR ?? "/tmp/fix-3012-topbar";
const THEME_ID = "topbar-3012-dark-start";

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

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 }
];
const starts = [
  { name: "from-dark", tokens: DARK_START },
  { name: "from-light", tokens: LIGHT_START }
];

test("top bar text is readable on its own background in a custom theme", async ({ page }) => {
  test.setTimeout(180_000);
  await signInThroughUi(page);
  const before = (await api(page, "GET", "/api/me/themes")).json;
  try {
    for (const start of starts) {
      await api(page, "PUT", "/api/me/themes/mode", {
        mode: start.name === "from-dark" ? "dark" : "light"
      });
      const put = await api(page, "PUT", `/api/me/themes/${THEME_ID}`, {
        name: "Top bar 3012",
        tokens: start.tokens
      });
      expect(put.status).toBe(200);
      expect((await api(page, "PUT", "/api/me/themes/active", { id: THEME_ID })).status).toBe(200);

      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto("/");
        await expect(page.locator("html")).toHaveAttribute("data-theme", THEME_ID);
        const bar = page.locator(".topbar").first();
        await expect(bar).toBeVisible();
        const title = bar.locator(".topbar-title").first();
        await expect(title).toBeVisible();
        const bg = await bar.evaluate((el) => getComputedStyle(el).backgroundColor);
        const fg = await title.evaluate((el) => getComputedStyle(el).color);
        const ratio = contrast(bg, fg);
        console.log(
          `${start.name} ${vp.name}: bar ${bg}, text ${fg}, contrast ${ratio.toFixed(2)}`
        );
        const box = await bar.boundingBox();
        await page.screenshot({
          path: `${SHOTS}/${start.name}-${vp.name}.png`,
          clip: { x: 0, y: 0, width: vp.width, height: Math.ceil((box?.height ?? 64) + 4) }
        });
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      }
    }
  } finally {
    await api(page, "PUT", "/api/me/themes/active", { id: before.activeId });
    await api(page, "PUT", "/api/me/themes/mode", { mode: before.mode });
    await api(page, "DELETE", `/api/me/themes/${THEME_ID}`);
  }
});
