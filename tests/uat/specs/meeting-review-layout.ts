import { expect, type Locator, type Page } from "@playwright/test";

/** Real rendered DOM assertions only; no screenshots or network interception. */
export async function assertMeetingReviewLayout(page: Page): Promise<void> {
  for (const width of [1600, 1180, 390, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByRole("tablist", { name: "Meeting review sections" })).toBeVisible();
    const summary = page.getByRole("tab", { name: "Summary and actions", exact: true });
    await summary.focus();
    await summary.press("End");
    const notes = page.getByRole("tab", { name: /^My notes/ });
    await expect(notes).toBeFocused();
    await expect(notes).toHaveAttribute("aria-selected", "true");
    await notes.press("Home");
    await expect(summary).toBeFocused();
    await expect(summary).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(async () =>
        page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          body: document.querySelector(".meetings-body")!.getBoundingClientRect().width,
          page: document.querySelector(".meetings-page")!.getBoundingClientRect().width
        }))
      )
      .toMatchObject({ overflow: 0 });
    const widths = await page.evaluate(() => ({
      body: document.querySelector(".meetings-body")!.getBoundingClientRect().width,
      page: document.querySelector(".meetings-page")!.getBoundingClientRect().width
    }));
    expect(widths.body).toBeGreaterThan(widths.page - 40);
  }
  for (const theme of [
    { mode: "light", park: "forest" },
    { mode: "dark", park: "forest" },
    { mode: "light", park: "teal" }
  ]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.colorMode = theme.mode;
      document.documentElement.dataset.theme = theme.park;
    }, theme);
    await expect(page.getByRole("tab", { name: "Summary and actions", exact: true })).toBeVisible();
    const metrics = await page
      .getByRole("tab", { name: "Summary and actions", exact: true })
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          fontSize: parseFloat(style.fontSize),
          color: style.color,
          outlineStyle: style.outlineStyle
        };
      });
    expect(metrics.fontSize).toBeGreaterThanOrEqual(11);
    expect(metrics.color).not.toBe("rgba(0, 0, 0, 0)");
    expect(metrics.outlineStyle).not.toBe("none");
  }
  await page.evaluate(() => {
    delete document.documentElement.dataset.colorMode;
    delete document.documentElement.dataset.theme;
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
}

export async function assertProvisionalContrast(page: Page): Promise<void> {
  const badge = page
    .getByRole("region", { name: "Retained transcript", exact: true })
    .locator(".jds-badge")
    .filter({ hasText: /^Provisional$/ });
  await assertMeetingTextContrast(page, badge);
}

export async function assertMeetingTextContrast(page: Page, badge: Locator): Promise<void> {
  for (const theme of [
    { mode: "light", park: "forest" },
    { mode: "dark", park: "forest" },
    { mode: "light", park: "teal" }
  ]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.colorMode = theme.mode;
      document.documentElement.dataset.theme = theme.park;
    }, theme);
    await expect(badge).toBeVisible();
    const ratio = await badge.evaluate((element) => {
      const parse = (color: string) => {
        const match = color.match(/^rgba?\(([^)]+)\)$/);
        if (!match) throw new Error(`Unsupported computed colour: ${color}`);
        const parts = match[1]!
          .split(/[\s,/]+/)
          .filter(Boolean)
          .map(Number);
        return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
      };
      const nodes: Element[] = [];
      let node: Element | null = element;
      while (node) {
        nodes.push(node);
        node = node.parentElement;
      }
      let background = [255, 255, 255];
      for (const item of nodes.reverse()) {
        const [r, g, b, alpha] = parse(getComputedStyle(item).backgroundColor);
        background = [r!, g!, b!].map(
          (channel, i) => channel * alpha! + background[i]! * (1 - alpha!)
        );
      }
      const foreground = parse(getComputedStyle(element).color).slice(0, 3);
      const luminance = (rgb: number[]) =>
        rgb
          .map((n) => n / 255)
          .map((n) => (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4))
          .reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i]!, 0);
      const fg = luminance(foreground),
        bg = luminance(background);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
  await page.evaluate(() => {
    delete document.documentElement.dataset.colorMode;
    delete document.documentElement.dataset.theme;
  });
}
