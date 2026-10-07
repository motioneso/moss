import { expect, type Locator, type Page } from "@playwright/test";
import { openMeetingChat } from "./meeting-minimal-ui.js";

/** Real rendered DOM assertions only; no screenshots or network interception. */
export async function assertMeetingReviewLayout(page: Page): Promise<void> {
  const workspace = page.locator(".meetings-workspace");
  const notesPanel = workspace.locator("#meeting-review-panel-notes");
  const notesTextbox = page.getByRole("textbox", { name: "Notes", exact: true });
  const notesHeading = page
    .getByRole("region", { name: "Personal notes", exact: true })
    .getByRole("heading", { name: "Notes", exact: true });
  for (const width of [1600, 1440, 1180, 390, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    const desktop = width > 760;
    // Wait for the responsive React tree, rather than branching on transient visibility.
    await expect(workspace.locator("#meeting-review-tab-transcript")).toHaveCount(desktop ? 0 : 1);
    const tabs = workspace.getByRole("tablist", {
      name: "Meeting sections",
      exact: true,
      includeHidden: true
    });
    const notesTab = tabs.getByRole("tab", { name: "Notes", exact: true });
    const hasSummary = (await workspace.locator("#meeting-review-panel-summary").count()) === 1;
    const singlePane = desktop && !hasSummary;
    if (singlePane) {
      // Shared Tabs deliberately hides redundant navigation and omits the tabpanel role.
      await expect(tabs).toBeHidden();
      await expect(workspace.getByRole("tablist")).toHaveCount(0);
      await expect(workspace.locator(".jds-tabs__panel")).toHaveCount(1);
      await expect(notesPanel).not.toHaveAttribute("role", "tabpanel");
    } else {
      await expect(tabs).toBeVisible();
      await expect(tabs.getByRole("tab")).toHaveCount((desktop ? 1 : 2) + Number(hasSummary));
      const minimumFont = await tabs
        .getByRole("tab")
        .evaluateAll((elements) =>
          Math.min(...elements.map((element) => parseFloat(getComputedStyle(element).fontSize)))
        );
      expect(minimumFont).toBeGreaterThanOrEqual(11);
      if (desktop && hasSummary) {
        const summaryTab = tabs.getByRole("tab", { name: "Summary", exact: true });
        await summaryTab.click();
        await expect(summaryTab).toHaveAttribute("aria-selected", "true");
        await expect(
          workspace.getByRole("tabpanel", { name: "Summary", exact: true })
        ).toBeVisible();
        await expect(notesTextbox).toBeHidden();
      }
      await notesTab.click();
      await expect(notesTab).toHaveAttribute("aria-selected", "true");
      await expect(notesPanel).toHaveAttribute("role", "tabpanel");
    }
    await expect(notesPanel).toBeVisible();
    await expect(notesTextbox).toBeVisible();
    await expect(notesHeading).toBeVisible();
    expect(
      await notesHeading.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))
    ).toBeGreaterThanOrEqual(11);
    const geometry = await workspace.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const transcript = element
        .querySelector('[aria-label="Transcript"]')
        ?.getBoundingClientRect();
      const panel = element.querySelector("#meeting-review-panel-notes")!.getBoundingClientRect();
      const tabs = element.querySelector('[role="tablist"]')!;
      const notes = element.querySelector('textarea[aria-label="Notes"]')!.getBoundingClientRect();
      const outer = element.closest(".meetings-page")!.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        width: bounds.width,
        outerWidth: outer.width,
        panelLeft: panel.left,
        panelRight: panel.right,
        panelTop: panel.top,
        panelWidth: panel.width,
        tabsBottom: tabs.getBoundingClientRect().bottom,
        notesLeft: notes.left,
        notesRight: notes.right,
        notesWidth: notes.width,
        transcriptLeft: transcript?.left,
        transcriptRight: transcript?.right,
        transcriptWidth: transcript?.width
      };
    });
    expect(geometry.width).toBeGreaterThanOrEqual(geometry.outerWidth - 2);
    expect(geometry.panelTop).toBeGreaterThanOrEqual(
      (singlePane ? geometry.top : geometry.tabsBottom) - 1
    );
    expect(geometry.notesWidth).toBeGreaterThanOrEqual(geometry.panelWidth - 2);
    expect(geometry.notesLeft).toBeCloseTo(geometry.panelLeft, 0);
    expect(geometry.notesRight).toBeCloseTo(geometry.panelRight, 0);
    expect(geometry.panelRight).toBeCloseTo(geometry.right, 0);
    if (desktop) {
      await expect(page.getByRole("region", { name: "Transcript", exact: true })).toBeVisible();
      await expect(page.getByRole("tab", { name: "Transcript", exact: true })).toHaveCount(0);
      expect(geometry.transcriptLeft).toBeCloseTo(geometry.left, 0);
      expect(geometry.transcriptRight).toBeLessThan(geometry.panelLeft);
      expect(geometry.transcriptWidth! / geometry.panelWidth).toBeCloseTo(1.35, 1);
    } else {
      expect(geometry.panelWidth).toBeGreaterThanOrEqual(geometry.width - 2);
      await notesTab.focus();
      await notesTab.press("Home");
      const transcriptTab = tabs.getByRole("tab", { name: "Transcript", exact: true });
      await expect(transcriptTab).toBeFocused();
      await expect(transcriptTab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("region", { name: "Transcript", exact: true })).toBeVisible();
      await expect(notesTextbox).toBeHidden();
      await transcriptTab.press("ArrowRight");
      await expect(notesTab).toBeFocused();
      await expect(notesTab).toHaveAttribute("aria-selected", "true");
      await expect(notesTextbox).toBeVisible();
      const controls = page.getByRole("region", { name: "Meeting recording", exact: true });
      const primary = controls.locator(
        ".meetings-capture-heading > .jds-btn, .meetings-capture-heading > .jds-control-pill"
      );
      const renderedControls = controls
        .getByRole("button", { name: "Start recording", exact: true })
        .or(controls.getByRole("group", { name: "Recording controls", exact: true }));
      await expect(primary).toHaveCount(await renderedControls.count());
      if (await primary.count()) {
        await expect(primary).toBeVisible();
        await expect(primary).toHaveCSS("position", "fixed");
        const box = await primary.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y + box!.height).toBeLessThanOrEqual(1000);
        expect(box!.y).toBeGreaterThan(850);
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      }
    }
    if (width === 375) await assertMeetingTextContrast(page, notesTab);
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
  await expect(workspace.locator("#meeting-review-tab-transcript")).toHaveCount(0);
  await expect(notesTextbox).toBeVisible();
  await assertMeetingTextContrast(page, notesHeading);
  if ((await workspace.locator("#meeting-review-panel-summary").count()) === 1) {
    await assertMeetingTextContrast(
      page,
      workspace.getByRole("tab", { name: "Notes", exact: true })
    );
  }
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
