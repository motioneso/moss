import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";

import {
  ensureSectionClearOfTopbar,
  scrollSectionTop,
  sectionTopbarOverlap
} from "../../tests/uat/visual-parity/seed.js";

const BAR_PAGE = (barPosition: "sticky" | "fixed") => `<!doctype html>
<html><head><style>
.topbar {
  position: ${barPosition};
  top: 0;
  min-height: 60px;
  padding: 8px 20px;
  border-bottom: 1px solid black;
  background: white;
}
${barPosition === "fixed" ? "body { margin: 0; }" : ""}
.spacer { height: 2000px; }
#target { background: #eee; }
</style></head><body>
<div class="topbar">Bar</div>
${barPosition === "fixed" ? '<section id="target"><h2>Head</h2></section><div class="spacer"></div>' : '<div class="spacer"></div><section id="target"><h2>Head</h2><p>Body</p></section><div class="spacer"></div>'}
</body></html>`;

describe("parity capture topbar offset", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  for (const width of [1440, 375]) {
    it(`lands the scrolled section clear of the measured bar at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      try {
        await page.setContent(BAR_PAGE("sticky"));
        await scrollSectionTop(page, "#target");
        const measured = await sectionTopbarOverlap(page, "#target");
        expect(measured.barHeight).toBeGreaterThanOrEqual(77);
        expect(measured.overlap).toBeLessThanOrEqual(0);
        expect(measured.targetTop).toBeGreaterThanOrEqual(measured.barHeight);
        expect(measured.targetTop - measured.barHeight).toBeLessThan(1);
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  it("refuses a capture whose head cannot clear the bar, naming everything", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await page.setContent(BAR_PAGE("fixed"));
      const before = await sectionTopbarOverlap(page, "#target");
      expect(before.overlap).toBeGreaterThan(0);
      const failure = await scrollSectionTop(page, "#target").then(
        () => null,
        (error: unknown) => error as Error
      );
      expect(failure, "covered head must throw").not.toBeNull();
      expect(failure!.message).toContain("#target");
      expect(failure!.message).toContain("1440");
      expect(failure!.message).toContain(`${before.barHeight}px`);
      expect(failure!.message).toContain("overlap");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("leaves an already-clear target alone (capture path)", async () => {
    const page: Page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await page.setContent(BAR_PAGE("sticky"));
      await page.evaluate(() => {
        document.querySelector("#target")!.scrollIntoView(true);
        window.scrollBy(0, -200);
      });
      const yBefore = await page.evaluate(() => window.scrollY);
      await ensureSectionClearOfTopbar(page, "#target", "#target");
      expect(await page.evaluate(() => window.scrollY)).toBe(yBefore);
    } finally {
      await page.close();
    }
  }, 60_000);
});
