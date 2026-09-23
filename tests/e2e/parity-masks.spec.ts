import { expect, test } from "@playwright/test";

import { maskRects } from "../uat/visual-parity/masks.js";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function centersInside(rects: ReadonlyArray<Box>, box: Box): number {
  return rects.filter(
    (r) =>
      r.x + r.width / 2 >= box.x &&
      r.x + r.width / 2 <= box.x + box.width &&
      r.y + r.height / 2 >= box.y &&
      r.y + r.height / 2 <= box.y + box.height
  ).length;
}

test("masks cover only text a user can see", async ({ page }) => {
  await page.setContent(`
    <style>
      .evening-plan__prose { font-size: 20px; line-height: 30px; }
      #clip { height: 34px; overflow: hidden; }
      #scroll-holder { margin-left: 600px; }
      #scroll { height: 34px; overflow-y: scroll; }
      #cover-wrap { position: relative; }
      #cover { position: absolute; inset: 0; background: white; }
      #faded { opacity: 0; }
      #passthrough { pointer-events: none; }
    </style>
    <div class="evening-plan__prose" id="visible">Fully visible prose line one<br>line two</div>
    <div id="clip"><div class="evening-plan__prose" id="half">Half clipped line one<br>line two<br>line three</div></div>
    <div id="scroll-holder"><div id="scroll"><div class="evening-plan__prose" id="scrolled">Scrolled out line one<br>line two<br>line three<br>line four</div></div></div>
    <div id="cover-wrap"><div class="evening-plan__prose" id="covered">Covered prose line</div><div id="cover"></div></div>
    <div id="faded"><div class="evening-plan__prose" id="transparent">Transparent prose line</div></div>
    <div id="passthrough"><div class="evening-plan__prose" id="events">Passthrough prose line</div></div>
  `);
  await page.evaluate(() => {
    const scroller = document.querySelector("#scroll") as HTMLElement;
    scroller.scrollTop = scroller.scrollHeight;
  });
  const rects = await maskRects(page);
  const box = async (sel: string): Promise<Box> =>
    page.evaluate((s) => {
      // getBoundingClientRect never scrolls, unlike locator.boundingBox.
      const r = document.querySelector(s)!.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, sel);

  const inside = (r: Box, b: Box): boolean =>
    r.x + r.width / 2 >= b.x &&
    r.x + r.width / 2 <= b.x + b.width &&
    r.y + r.height / 2 >= b.y &&
    r.y + r.height / 2 <= b.y + b.height;
  expect(centersInside(rects, await box("#visible"))).toBeGreaterThan(0);
  const scrollBox = await box("#scroll");
  const scrolledBox = await box("#scrolled");
  const leaked = rects.filter((r) => inside(r, scrolledBox) && !inside(r, scrollBox));
  expect(leaked.length).toBe(0);
  expect(centersInside(rects, scrollBox)).toBeGreaterThan(0);
  expect(centersInside(rects, await box("#cover-wrap"))).toBe(0);
  expect(centersInside(rects, await box("#faded"))).toBe(0);
  expect(centersInside(rects, await box("#events"))).toBeGreaterThan(0);

  const clipBox = await box("#clip");
  const inClip = rects.filter(
    (r) =>
      r.x + r.width / 2 >= clipBox.x &&
      r.x + r.width / 2 <= clipBox.x + clipBox.width &&
      r.y + r.height / 2 >= clipBox.y &&
      r.y + r.height / 2 <= clipBox.y + clipBox.height
  );
  expect(inClip.length).toBeGreaterThan(0);
  for (const r of inClip) {
    expect(r.y + r.height).toBeLessThanOrEqual(clipBox.y + clipBox.height + 1);
  }
});
