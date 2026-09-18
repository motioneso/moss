import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";

import { scrollSectionTop } from "../../tests/uat/visual-parity/seed.js";

// Inline measurer, deliberately not imported from seed.ts: this file must
// load and run on the tree before the fix, where the module's measuring
// helper does not exist. scrollSectionTop exists there with the same
// signature, so the first test fails on old code with the measured
// overlap and passes on the new code.
async function overlapOf(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  const barBottom = await page.evaluate(() => {
    const bar = document.querySelector(".topbar");
    return bar ? bar.getBoundingClientRect().bottom : 0;
  });
  return { targetTop: box?.y ?? NaN, barBottom, overlap: barBottom - (box?.y ?? NaN) };
}

const SECTION_PAGE = `<!doctype html>
<html><head><style>
.topbar {
  position: sticky;
  top: 0;
  min-height: 60px;
  padding: 8px 20px;
  border-bottom: 1px solid black;
  background: white;
}
.spacer { height: 2000px; }
#section { background: #eee; }
</style></head><body>
<div class="topbar">Bar</div>
<div class="spacer"></div>
<section id="section"><h2>Head</h2><p>Body</p></section>
<div class="spacer"></div>
</body></html>`;

// A dialog pinned to the viewport over the bar's rectangle: overlap here is
// paint order, which the harness does not judge, so the scroll must succeed.
const DIALOG_PAGE = `<!doctype html>
<html><head><style>
.topbar {
  position: fixed;
  top: 0; left: 0; right: 0;
  min-height: 60px;
  padding: 8px 20px;
  border-bottom: 1px solid black;
  background: white;
}
#dialog {
  position: fixed;
  top: 20px; left: 100px; width: 400px; height: 300px;
  background: white;
  border: 1px solid black;
}
</style></head><body>
<div class="topbar">Bar</div>
<div style="height: 3000px;"></div>
<div id="dialog" role="dialog"><h2>Dialog</h2></div>
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
        await page.setContent(SECTION_PAGE);
        await scrollSectionTop(page, "#section");
        const measured = await overlapOf(page, "#section");
        expect(measured.barBottom).toBeGreaterThanOrEqual(77);
        expect(measured.overlap).toBeLessThanOrEqual(0);
        expect(measured.targetTop - measured.barBottom).toBeLessThan(1);
      } finally {
        await page.close();
      }
    }, 60_000);
  }

  it("refuses a section that cannot clear the bar, naming everything", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      // The section is stuck at the very top under a fixed bar with no
      // scrollable ancestor, so no offset can clear it.
      await page.setContent(`<!doctype html>
<html><head><style>
html, body { margin: 0; height: 1000px; overflow: hidden; }
.topbar {
  position: fixed;
  top: 0; left: 0; right: 0;
  min-height: 60px;
  padding: 8px 20px;
  border-bottom: 1px solid black;
  background: white;
}
#section { position: absolute; top: 0; left: 0; right: 0; background: #eee; }
</style></head><body>
<div class="topbar">Bar</div>
<section id="section"><h2>Head</h2></section>
</body></html>`);
      const before = await overlapOf(page, "#section");
      expect(before.overlap).toBeGreaterThan(0);
      const failure = await scrollSectionTop(page, "#section").then(
        () => null,
        (error: unknown) => error as Error
      );
      expect(failure, "covered section must throw").not.toBeNull();
      expect(failure!.message).toContain("#section");
      expect(failure!.message).toContain("1440");
      expect(failure!.message).toContain(`${before.barBottom}px`);
      expect(failure!.message).toContain("overlap");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("leaves a viewport-pinned dialog overlapping the bar alone", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await page.setContent(DIALOG_PAGE);
      const before = await overlapOf(page, "#dialog");
      expect(before.overlap).toBeGreaterThan(0);
      await scrollSectionTop(page, "#dialog");
    } finally {
      await page.close();
    }
  }, 60_000);
});
