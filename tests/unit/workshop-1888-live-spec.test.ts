import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = () =>
  readFile(new URL("../live/workshop-1888-uat.spec.ts", import.meta.url), "utf8");

describe("workshop-1888 live spec (#3281)", () => {
  it("starts its fresh chat through the Conversations controls", async () => {
    const text = await source();
    expect(text, "removed New chat button").not.toMatch(/name: \/\^New chat\$\//);
    expect(text, "removed New chat button").not.toMatch(/name: "New chat"/);
    const opens = text.match(/name: "Open conversations"/g) ?? [];
    const sides = text.match(/name: "New side chat", exact: true/g) ?? [];
    expect(opens.length, "Open conversations clicks").toBe(1);
    expect(sides.length, "every overlay open starts a side chat").toBe(opens.length);
  });

  it("asks only after the drawer clear, an empty transcript and zero plan cards", async () => {
    const text = await source();
    expect(text).toMatch(/url\.pathname === "\/api\/chat\/clear"/);
    expect(text).toMatch(/url\.searchParams\.get\("surface"\) === "drawer"/);
    expect(text).toMatch(/expect\(\(await cleared\)\.status\(\)\)\.toBe\(204\)/);
    expect(text, "old replies gone").toMatch(/drawer\.locator\(REPLIES\)\)\.toHaveCount\(0\)/);
    const listening = text.indexOf("const cleared = page.waitForResponse(");
    const opened = text.indexOf('getByRole("button", { name: "Open conversations" }).click()');
    expect(listening, "clear listener").toBeGreaterThan(-1);
    expect(opened, "clear listener armed before the clicks").toBeGreaterThan(listening);
    const started = text.indexOf("await startSideChat(page, drawer)");
    const noCards = text.indexOf("await expect(planCards).toHaveCount(0)");
    const asked = text.indexOf('await composer.press("Enter")');
    expect(started, "side chat started").toBeGreaterThan(-1);
    expect(noCards, "zero stale plan cards checked").toBeGreaterThan(started);
    expect(asked, "ask sent after the zero-card check").toBeGreaterThan(noCards);
    expect(text, "exactly one fresh plan").toMatch(/await expect\(planCards\)\.toHaveCount\(1, /);
  });

  it("keeps every check after the plan appears", async () => {
    const text = await source();
    const kept = [
      "await expect(page).toHaveURL(/\\/workshop$/, { timeout: 15_000 })",
      "expect(current).not.toBe(firstStatus)",
      "await expect(statusIndicator).toHaveCount(0, { timeout: 1_650_000 })",
      'getByRole("button", { name: "Look at the draft" }).first()',
      "await expect(page).toHaveURL(/\\/m\\/[a-z0-9-]+$/, { timeout: 30_000 })",
      "await expect(moduleRoot.getByText(/word of the day/i).first()).toBeVisible()",
      "await expect(moduleRoot.getByText(/noun|verb|adjective|adverb/i).first()).toBeVisible()",
      'await page.getByRole("button", { name: "Ask for a change" }).click()',
      'await page.getByRole("button", { name: "Ship it" }).click()',
      "await page.reload()",
      'await expect(page.getByRole("button", { name: "Look at the draft" })).toHaveCount(0)'
    ];
    for (const line of kept) expect(text, line).toContain(line);
    const shipAbsent = 'await expect(page.getByRole("button", { name: "Ship it" })).toHaveCount(0)';
    const reload = text.indexOf("await page.reload()");
    expect(text.indexOf(shipAbsent, reload), "Ship it stays gone after reload").toBeGreaterThan(
      reload
    );
  });

  it("signs in as the disposable install's owner", async () => {
    const text = await source();
    expect(text).toMatch(/email: OWNER_EMAIL/);
    expect(text, "no fallback to the dev account").not.toMatch(/LIVE_OWNER_EMAIL \?\?/);
    expect(text, "no dev account email").not.toMatch(/ben@ben\.com/);
    expect(text).toMatch(/if \(!OWNER_EMAIL \|\| !OWNER_PASSWORD\)/);
  });
});
