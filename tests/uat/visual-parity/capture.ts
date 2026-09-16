// tests/uat/visual-parity/capture.ts
//
// VP-P0 region capture, honest masking, pixel diff and report lines.
// Masked pixels are painted identical in both images before pixelmatch,
// so generated text can neither pass nor fail a capture.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { maskRects } from "./masks.js";
import type { MockupEntry } from "./mockups.js";

export interface CaptureResult {
  readonly file: string;
  readonly size: string;
  readonly maskedShare: number;
  readonly diffPercent: number;
  readonly sizeMatch: boolean;
}
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function centerCrop(png: PNG, w: number, h: number): PNG {
  const out = new PNG({ width: w, height: h });
  const dx = Math.max(0, Math.floor((png.width - w) / 2));
  const dy = Math.max(0, Math.floor((png.height - h) / 2));
  PNG.bitblt(png, out, dx, dy, Math.min(w, png.width), Math.min(h, png.height), 0, 0);
  return out;
}

function paintMask(png: PNG, rects: readonly Rect[]): number {
  let masked = 0;
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x)),
      y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(png.width, Math.ceil(r.x + r.width));
    const y1 = Math.min(png.height, Math.ceil(r.y + r.height));
    for (let y = y0; y < y1; y += 1)
      for (let x = x0; x < x1; x += 1) {
        const i = (png.width * y + x) * 4;
        png.data[i] = 255;
        png.data[i + 1] = 0;
        png.data[i + 2] = 255;
        png.data[i + 3] = 255;
        masked += 1;
      }
  }
  return masked;
}

function toImageSpace(rects: readonly Rect[], ox: number, oy: number): Rect[] {
  return rects.map((r) => ({ x: r.x - ox, y: r.y - oy, width: r.width, height: r.height }));
}

export async function stillPage(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({
    content:
      "*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}"
  });
  await page.evaluate(() => document.fonts.ready);
}

export async function captureEntry(
  page: Page,
  entry: MockupEntry,
  mockupRoot: string,
  outDir: string
): Promise<CaptureResult> {
  await page.setViewportSize({ width: entry.viewport.w, height: entry.viewport.h });
  await stillPage(page);
  let shot: Buffer;
  let ox: number;
  let oy: number;
  if (entry.region.kind === "clip") {
    const { x, y, w, h } = entry.region;
    shot = await page.screenshot({ clip: { x, y, width: w, height: h } });
    ox = x;
    oy = y;
    if (entry.region.crop) {
      const png = PNG.sync.read(shot);
      shot = PNG.sync.write(centerCrop(png, entry.region.crop.w, entry.region.crop.h));
      ox = x + Math.floor((w - entry.region.crop.w) / 2);
      oy = y + Math.floor((h - entry.region.crop.h) / 2);
    }
  } else {
    const box = await page.locator(entry.region.selector).first().boundingBox();
    if (!box) throw new Error(`parity: ${entry.region.selector} has no box for ${entry.name}`);
    shot = await page.locator(entry.region.selector).first().screenshot();
    ox = box.x;
    oy = box.y;
  }
  const mockup = PNG.sync.read(readFileSync(join(mockupRoot, entry.dir, entry.name)));
  const capture = PNG.sync.read(shot);
  const sizeMatch = capture.width === mockup.width && capture.height === mockup.height;
  const masks = toImageSpace(await maskRects(page), ox, oy);
  const maskedPixels = paintMask(capture, masks);
  const maskedShare = maskedPixels / (capture.width * capture.height);
  let diffPercent: number;
  if (!sizeMatch) {
    diffPercent = 100;
    writeFileSync(join(outDir, entry.name), PNG.sync.write(capture));
    writeFileSync(join(outDir, entry.name.replace(/\.png$/, ".diff.png")), PNG.sync.write(capture));
  } else {
    paintMask(mockup, masks);
    const diff = new PNG({ width: mockup.width, height: mockup.height });
    const different = pixelmatch(
      mockup.data,
      capture.data,
      diff.data,
      mockup.width,
      mockup.height,
      { threshold: 0.1 }
    );
    diffPercent = (different / (mockup.width * mockup.height)) * 100;
    writeFileSync(join(outDir, entry.name), PNG.sync.write(capture));
    writeFileSync(join(outDir, entry.name.replace(/\.png$/, ".diff.png")), PNG.sync.write(diff));
  }
  return {
    file: entry.name,
    size: `${capture.width}x${capture.height}`,
    maskedShare,
    diffPercent,
    sizeMatch
  };
}

export function reportLine(r: CaptureResult): string {
  return `| ${r.file} | ${r.size} | ${(r.maskedShare * 100).toFixed(1)}% | ${r.diffPercent.toFixed(2)}% | ${r.sizeMatch ? "size-ok" : "SIZE-MISMATCH"} |`;
}

export async function guardCapture(
  page: Page,
  name: string,
  w: number,
  outDir: string
): Promise<void> {
  await page.setViewportSize({ width: w, height: 1000 });
  await stillPage(page);
  await page.screenshot({
    path: join(outDir, `${name}.png`),
    clip: { x: 0, y: 0, width: w, height: 850 }
  });
}

export function diffFiles(aPath: string, bPath: string, outPath: string): number {
  const a = PNG.sync.read(readFileSync(aPath));
  const b = PNG.sync.read(readFileSync(bPath));
  if (a.width !== b.width || a.height !== b.height) return 100;
  const diff = new PNG({ width: a.width, height: a.height });
  const different = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  writeFileSync(outPath, PNG.sync.write(diff));
  return (different / (a.width * a.height)) * 100;
}
