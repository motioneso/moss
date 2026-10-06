import { expect, type Locator, type Page } from "@playwright/test";
import { openMeetingChat } from "./meeting-minimal-ui.js";

/** Real rendered DOM assertions only; no screenshots or network interception. */
export async function assertMeetingReviewLayout(page: Page): Promise<void> {
  for (const width of [1600, 1440, 1180, 390, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    const tabs = page.getByRole("tablist", { name: "Meeting sections", exact: true });
    await expect(tabs).toBeVisible();
    const minimumFont = await tabs
      .getByRole("tab")
      .evaluateAll((elements) =>
        Math.min(...elements.map((element) => parseFloat(getComputedStyle(element).fontSize)))
      );
    expect(minimumFont).toBeGreaterThanOrEqual(11);
    const notes = page.getByRole("tab", { name: "Notes", exact: true });
    await notes.click();
    await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toBeVisible();
    const geometry = await page.locator(".meetings-workspace").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const transcript = element
        .querySelector('[aria-label="Transcript"]')
        ?.getBoundingClientRect();
      const panel = element
        .querySelector('[role="tabpanel"]:not([hidden])')!
        .getBoundingClientRect();
      const tabs = element.querySelector('[role="tablist"]')!.getBoundingClientRect();
      const notes = element.querySelector("textarea")!.getBoundingClientRect();
      const outer = element.closest(".meetings-page")!.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        width: bounds.width,
        outerWidth: outer.width,
        panelLeft: panel.left,
        panelRight: panel.right,
        panelTop: panel.top,
        panelWidth: panel.width,
        tabsBottom: tabs.bottom,
        notesWidth: notes.width,
        transcriptLeft: transcript?.left,
        transcriptRight: transcript?.right,
        transcriptWidth: transcript?.width
      };
    });
    expect(geometry.width).toBeGreaterThanOrEqual(geometry.outerWidth - 2);
    expect(geometry.panelTop).toBeGreaterThanOrEqual(geometry.tabsBottom - 1);
    expect(geometry.notesWidth).toBeGreaterThanOrEqual(geometry.panelWidth - 2);
    expect(geometry.panelRight).toBeCloseTo(geometry.right, 0);
    if (width > 760) {
      await expect(page.getByRole("region", { name: "Transcript", exact: true })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveCount(0);
      expect(geometry.transcriptLeft).toBeCloseTo(geometry.left, 0);
      expect(geometry.transcriptRight).toBeLessThan(geometry.panelLeft);
      expect(geometry.transcriptWidth! / geometry.panelWidth).toBeCloseTo(1.35, 1);
    } else {
      expect(geometry.panelWidth).toBeGreaterThanOrEqual(geometry.width - 2);
      await notes.focus();
      await notes.press("Home");
      const transcriptTab = page.getByRole("tab", { name: "Transcript", exact: true });
      await expect(transcriptTab).toBeFocused();
      await expect(transcriptTab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("region", { name: "Transcript", exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toBeHidden();
      const controls = page.getByRole("region", { name: "Meeting recording", exact: true });
      const primary = controls.locator(":scope > .jds-btn, :scope > .jds-control-pill");
      if (await primary.count()) {
        await expect(primary).toHaveCSS("position", "fixed");
        const box = await primary.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y + box!.height).toBeLessThanOrEqual(1000);
        expect(box!.y).toBeGreaterThan(850);
      }
    }
    if (width === 390) {
      await openMeetingChat(page);
      await expect(page.locator(".chatd")).toBeVisible();
      await expect(page.locator(".chatd--docked")).toHaveCount(0);
      await page.getByRole("button", { name: "Close chat", exact: true }).click();
    }
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        )
      )
      .toBe(0);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("tab", { name: "Notes", exact: true }).click();
  await assertMeetingTextContrast(page, page.getByRole("tab", { name: "Notes", exact: true }));
}

export async function assertProvisionalContrast(page: Page): Promise<void> {
  const text = page
    .getByRole("region", { name: "Transcript", exact: true })
    .locator(".meetings-transcript-turn--live .meetings-transcript-text")
    .first();
  await assertMeetingTextContrast(page, text);
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
