import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";

import { prepareSelectedEntry, scrollSectionTop } from "../../tests/uat/visual-parity/seed.js";
import { type MockupEntry } from "../../tests/uat/visual-parity/mockups.js";
import { type ParityManifest } from "../../tests/uat/visual-parity/seed.js";

// A section wrapped in an overflow:visible container that is taller than it
// is tall: the wrapper's scrollHeight exceeds its clientHeight, so the old
// nearest-overflow pick scrolls it, nothing moves, and the refusal fires.
// The fix must climb past it to the container that actually scrolls.
const VISIBLE_WRAPPER_PAGE = `<!doctype html>
<html><head><style>
html, body { margin: 0; }
.topbar {
  position: sticky;
  top: 0;
  min-height: 60px;
  padding: 8px 20px;
  border-bottom: 1px solid black;
  background: white;
}
main.content-surface { overflow: visible; height: 800px; }
.spacer { height: 2000px; }
#section { background: #eee; }
.tall { height: 1500px; }
.afterspace { height: 2000px; }
</style></head><body>
<div class="topbar">Bar</div>
<main class="content-surface">
<div class="spacer"></div>
<section id="section"><h2>Head</h2><p>Body</p></section>
<div class="tall"></div>
</main>
<div class="afterspace"></div>
</body></html>`;

async function overlapOf(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  const barBottom = await page.evaluate(() => {
    const bar = document.querySelector(".topbar");
    return bar ? bar.getBoundingClientRect().bottom : 0;
  });
  return { targetTop: box?.y ?? NaN, barBottom, overlap: barBottom - (box?.y ?? NaN) };
}

describe("parity scroll picks the ancestor that actually scrolls", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  for (const width of [1440, 375]) {
    it(`scrolls a section inside an overflow visible wrapper clear at ${width}px`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      try {
        await page.setContent(VISIBLE_WRAPPER_PAGE);
        await scrollSectionTop(page, "#section");
        const measured = await overlapOf(page, "#section");
        expect(measured.overlap).toBeLessThanOrEqual(0);
        expect(measured.targetTop - measured.barBottom).toBeLessThan(1);
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});

const ORDER_MANIFEST = {
  tasks: [
    { key: "t1", title: "Write the launch brief", due: null },
    { key: "t2", title: "Reply to Priya", due: null },
    { key: "t3", title: "File the travel report", due: null }
  ],
  meetings: [],
  events: [],
  todayPlanTasks: [],
  tomorrowPlanTasks: [],
  news: { expectedHeadline: "" },
  weather: { location: "" }
} as unknown as ParityManifest;

function orderEntryFor(width: number): MockupEntry {
  return {
    name: `probe-${width}.png`,
    dir: "probe",
    viewport: { w: width, h: 1000 },
    region: { kind: "element", selector: '[role="dialog"]' },
    state: "reader-proposed-read",
    clock: "morning"
  } as unknown as MockupEntry;
}

describe("entry setup sizes the viewport before navigating", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  // Every case lays out and scrolls at its own viewport. These tests drive
  // the real entry setup on a real browser page and record the order of the
  // viewport sizing against the first navigation. There is deliberately no
  // app behind the page here: "/today" has no server in this file, so the
  // first navigation attempt fails fast and the run ends there. The order
  // under test is settled before that failure either way, which is exactly
  // what makes a stale-width setup impossible.
  for (const [startWidth, entryWidth] of [
    [1440, 375],
    [375, 1440]
  ] as const) {
    it(`sizes to ${entryWidth}px before navigating from ${startWidth}px`, async () => {
      const page = await browser.newPage({ viewport: { width: startWidth, height: 1000 } });
      try {
        const calls: string[] = [];
        const origSize = page.setViewportSize.bind(page);
        page.setViewportSize = (async (size: { width: number; height: number }) => {
          calls.push(`size:${size.width}`);
          return origSize(size);
        }) as typeof page.setViewportSize;
        const origGoto = page.goto.bind(page);
        page.goto = (async (...args: Parameters<Page["goto"]>) => {
          calls.push("goto");
          return origGoto(...args);
        }) as typeof page.goto;
        await prepareSelectedEntry(page, orderEntryFor(entryWidth), ORDER_MANIFEST).catch(
          () => undefined
        );
        expect(calls[0]).toBe(`size:${entryWidth}`);
      } finally {
        await page.close();
      }
    }, 60_000);
  }
});
