import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";

import {
  HARNESS_FILES,
  computeHarnessDigest,
  selectedSetupActions
} from "../../tests/uat/visual-parity/case-selection.js";
import { driveState, prepareSelectedEntry } from "../../tests/uat/visual-parity/seed.js";
import { type MockupEntry } from "../../tests/uat/visual-parity/mockups.js";
import { type ParityManifest } from "../../tests/uat/visual-parity/seed.js";

// Fail-first cover for the p4n setup-hygiene slice. Every test drives the
// real setup helpers on a real Chromium page against a route-stubbed stand-in
// for the app: page.route fulfills /today and the two overview endpoints, so
// no disposable stack is needed and nothing here fakes the page's data.

// A case fixture with a declared height other than 1000. Invariant 7 forbids
// editing MOCKUPS for this, so the non-1000 viewport lives here in the test.
function hygieneEntry(state: string, clock: "morning" | "evening"): MockupEntry {
  return {
    name: "probe.png",
    dir: "probe",
    viewport: { w: 1440, h: 800 },
    region: { kind: "element", selector: "main" },
    state,
    clock
  } as unknown as MockupEntry;
}

const HYGIENE_MANIFEST = {
  tasks: [
    { key: "t1", title: "Write the launch brief", due: null },
    { key: "t2", title: "Reply to Priya", due: null },
    { key: "t3", title: "File the travel report", due: null }
  ],
  meetings: [{ title: "Standup with Priya", startsAt: "08:30", endsAt: "09:00" }],
  events: [],
  todayPlanTasks: [],
  tomorrowPlanTasks: [],
  news: { expectedHeadline: "" },
  weather: { location: "Nowhere" }
} as unknown as ParityManifest;

// Everything one setup pass reads: the morning page with its sections and
// the two buttons that open the planning and reader dialogs. Both dialogs
// are inserted by the button click so closeDialogs still sees a clean page.
const STUB_HTML = `<!doctype html><html><body><main class="content-surface">
<div class="today-hero"><h1>Write the launch brief</h1></div>
<p>Standup with Priya</p>
<section class="jds-brief--news"><h2>News</h2><div style="height:1500px"></div></section>
<section class="jds-brief--sports"><h2>Sports</h2></section>
<ul><li>Arsenal win again</li></ul>
<div id="weather">Sunny 21</div>
<button id="planBtn">Plan tomorrow</button>
<button id="readerBtn">Read the full morning briefing</button>
</main><script>
planBtn.onclick=()=>document.body.insertAdjacentHTML("beforeend",'<div role="dialog"><nav aria-label="Plan steps"><button>Reflect</button><button>Open commitments</button><button>Shape tomorrow</button><button>Review</button></nav></div>');
readerBtn.onclick=()=>document.body.insertAdjacentHTML("beforeend",'<div role="dialog"><div role="tab">Read</div><div role="tab">Review</div></div>');
</script></body></html>`;

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

async function stubbedContext(): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 800 },
    baseURL: "http://stub.test"
  });
  await context.route(
    (url) => url.pathname === "/today",
    (route) => route.fulfill({ status: 200, contentType: "text/html", body: STUB_HTML })
  );
  await context.route(
    (url) => url.pathname === "/api/sports/overview",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ scoreboard: [{ games: [{ home: { sourceTeamId: "359" } }] }] })
      })
  );
  await context.route(
    (url) => url.pathname === "/api/news/overview",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ topStories: [{ title: "Stub headline" }] })
      })
  );
  return context;
}

async function recordSizes(page: Page): Promise<Array<{ width: number; height: number }>> {
  const calls: Array<{ width: number; height: number }> = [];
  const origSize = page.setViewportSize.bind(page);
  page.setViewportSize = (async (size: { width: number; height: number }) => {
    calls.push({ ...size });
    return origSize(size);
  }) as typeof page.setViewportSize;
  return calls;
}

describe("setup honors the case viewport", () => {
  it("lays out a non-1000 reader case at its declared height", async () => {
    const context = await stubbedContext();
    const page = await context.newPage();
    try {
      const calls = await recordSizes(page);
      await prepareSelectedEntry(
        page,
        hygieneEntry("reader-proposed-read", "morning"),
        HYGIENE_MANIFEST
      );
      expect(calls.length).toBeGreaterThan(0);
      for (const size of calls) expect(size.height).toBe(800);
    } finally {
      await page.close();
      await context.close();
    }
  }, 60_000);

  it("lays out a non-1000 planning case at its declared height", async () => {
    const context = await stubbedContext();
    const page = await context.newPage();
    try {
      const calls = await recordSizes(page);
      await prepareSelectedEntry(page, hygieneEntry("evening-step-0", "evening"), HYGIENE_MANIFEST);
      expect(calls.length).toBeGreaterThan(0);
      for (const size of calls) expect(size.height).toBe(800);
    } finally {
      await page.close();
      await context.close();
    }
  }, 60_000);

  it("keeps the declared height through the state driver", async () => {
    const context = await stubbedContext();
    const page = await context.newPage();
    try {
      await page.goto("/today");
      await driveState(page, "today-morning-news", { w: 1440, h: 800 });
      expect(page.viewportSize()?.height).toBe(800);
    } finally {
      await page.close();
      await context.close();
    }
  }, 60_000);
});

describe("one scroll per setup pass", () => {
  // The scroll must come from the recipe's driveState step, not from a
  // second scroll after setup. The count alone cannot tell those apart:
  // the pre-fix code also scrolled exactly once, from the deleted block.
  // The recipe assertion is what fails on the old code.
  it("scrolls the morning news case exactly once, via the recipe", async () => {
    expect(selectedSetupActions("today-morning-news")).toContain("driveState");
    const context = await stubbedContext();
    await context.addInitScript(() => {
      (window as unknown as { __sivCount: number }).__sivCount = 0;
      const orig = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function (
        ...args: Parameters<typeof orig>
      ): ReturnType<typeof orig> {
        (window as unknown as { __sivCount: number }).__sivCount += 1;
        return orig.apply(this, args);
      };
    });
    const page = await context.newPage();
    try {
      await prepareSelectedEntry(
        page,
        hygieneEntry("today-morning-news", "morning"),
        HYGIENE_MANIFEST
      );
      const count = await page.evaluate(
        () => (window as unknown as { __sivCount: number }).__sivCount
      );
      expect(count).toBe(1);
    } finally {
      await page.close();
      await context.close();
    }
  }, 60_000);
});

describe("harness digest covers the case list", () => {
  it("binds mockups.ts so editing it moves the digest", () => {
    expect(HARNESS_FILES).toContain("tests/uat/visual-parity/mockups.ts");
    expect(computeHarnessDigest()).toBe(
      createHash("sha256")
        .update(HARNESS_FILES.map((file) => readFileSync(file)).join(""))
        .digest("hex")
    );
  });
});
