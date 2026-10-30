import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { Browser } from "playwright-core";
import { formatCents } from "../../../external-modules/finance/src/web/format.js";
type Read = (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
export async function exerciseManualNetWorth(
  browser: Browser,
  base: string,
  cookie: string,
  read: Read,
  artifacts?: string
) {
  const accounts = await read("finance.accounts.list");
  expect(accounts.banks).toEqual([]);
  expect((accounts.accounts as { source?: string }[]).every((a) => a.source === "manual")).toBe(
    true
  );
  const date = String((await read("finance.manual.context")).today);
  const result = await read("finance.reports.net-worth", { currency: "EUR", months: 6 });
  expect(result).toMatchObject({ headlineCents: 123450, asOf: date });
  expect(result.coverage).toEqual([
    expect.objectContaining({
      name: "Synthetic EUR cash",
      source: "ledger",
      included: true,
      asOf: date,
      contributionCents: 123450
    })
  ]);
  const count = (result.points as unknown[]).length;
  expect(count).toBeGreaterThanOrEqual(2);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce"
  });
  await context.addCookies(
    cookie.split("; ").map((part) => {
      const index = part.indexOf("=");
      return { name: part.slice(0, index), value: part.slice(index + 1), url: base };
    })
  );
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort()
  );
  const page = await context.newPage();
  try {
    await page.goto(`${base}/m/finance/reports`);
    await page.getByLabel("Report currency", { exact: true }).selectOption("EUR");
    const region = page.getByRole("region", { name: "Net worth", exact: true });
    await region
      .getByRole("heading", { name: formatCents(123450, "EUR"), exact: true, level: 3 })
      .waitFor();
    await region.getByText("1 of 1 account included in this total.", { exact: true }).waitFor();
    const sources = region.getByRole("button", { name: "Show balance sources", exact: true });
    await sources.focus();
    await sources.press("Enter");
    await region.getByText(`Manual ledger through ${date}`, { exact: true }).waitFor();
    const history = region.getByRole("button", { name: "Show balance history", exact: true });
    await history.focus();
    await history.press("Space");
    await region
      .getByText(`1–${Math.min(count, 50)} of ${count} balance points`, { exact: true })
      .waitFor();
    for (const theme of ["light", "dark", "sage"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => scrollTo(0, 0));
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false
        );
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), `finance-ledger-net-worth-${theme}-${width}.png`),
            fullPage: true
          });
      }
    }
    await page.reload();
    await page.getByLabel("Report currency", { exact: true }).selectOption("EUR");
    await region
      .getByRole("heading", { name: formatCents(123450, "EUR"), exact: true, level: 3 })
      .waitFor();
    await page.getByLabel("Report currency", { exact: true }).selectOption("USD");
    await region
      .getByRole("heading", { name: formatCents(999999, "USD"), exact: true, level: 3 })
      .waitFor();
    expect(
      await region
        .getByRole("heading", { name: formatCents(123450, "EUR"), exact: true, level: 3 })
        .count()
    ).toBe(0);
  } catch (error) {
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-ledger-worth-debug.png"),
        fullPage: true
      });
    throw error;
  } finally {
    await context.close();
  }
}
