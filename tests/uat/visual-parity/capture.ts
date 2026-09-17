// tests/uat/visual-parity/capture.ts: region capture, honest masking, pixel diff, report lines.
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
const DISPLAY_TEXT = [
  ".nw-twlead__title",
  ".nw-twlist__title",
  ".desk-title",
  ".sp-feat__name",
  ".sp-feat__lead",
  ".sp-tk__name"
];
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
  if (/^morning-.*-(news|sports)\.png$/.test(entry.name)) await waitForStablePopulated(page);
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
export async function stableSample(page: Page): Promise<string> {
  return page.evaluate(async (sels: string[]) => {
    const read = async (path: string) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      return response.json();
    };
    const [news, sports] = await Promise.all([
      read("/api/news/overview"),
      read("/api/sports/overview")
    ]);
    const pick = (root: Element | null) =>
      Array.from(root?.querySelectorAll("a,[data-testid],[id]") ?? []).map((el) => ({
        id: (el as HTMLElement).id || null,
        testId: el.getAttribute("data-testid"),
        href:
          el instanceof HTMLAnchorElement
            ? el.href
            : ((el.querySelector("a") as HTMLAnchorElement | null)?.href ?? null),
        text: ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim()
      }));
    const newsRoot = document.querySelector(".jds-brief--news");
    const cards = Array.from(document.querySelectorAll(".jds-brief--sports article.sp-tk"));
    const arsenal =
      cards.find((el) => el.querySelector(".sp-tk__name")?.textContent?.trim() === "Arsenal") ??
      null;
    const newsItems = pick(newsRoot);
    const arsenalItems = pick(arsenal);
    const arsenalText = ((arsenal as HTMLElement | null)?.innerText ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const known: string[] = [];
    document.fonts.forEach((face) =>
      known.push(`${face.family} ${face.weight} ${face.style} ${face.status}`)
    );
    const faces = sels.flatMap((sel) => {
      const el = document.querySelector(sel);
      if (!(el instanceof HTMLElement)) return [];
      const cs = getComputedStyle(el);
      const family = (cs.fontFamily.split(",")[0] ?? "").replace(/["']/g, "").trim();
      if (!known.some((entry) => entry.startsWith(`${family} `))) return [];
      const key = `${family} ${cs.fontWeight} ${cs.fontStyle}`;
      const text = ((el.innerText ?? "").replace(/\s+/g, " ").trim() || "Ag").slice(0, 120);
      const ready =
        known.includes(`${key} loaded`) &&
        document.fonts.check(`${cs.fontStyle} ${cs.fontWeight} 16px ${cs.fontFamily}`, text);
      const spec = `${cs.fontStyle} ${cs.fontWeight} 16px ${cs.fontFamily}`;
      const lines: number[][] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && lines.length < 8) {
        if ((node.textContent ?? "").trim()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const r of Array.from(range.getClientRects())) {
            if (lines.length >= 8) break;
            lines.push([r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10));
          }
        }
        node = walker.nextNode();
      }
      return [{ sel, spec, ready, lines }];
    });
    const pane = (el: Element | null) => {
      const r = el?.getBoundingClientRect();
      return r ? [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10) : null;
    };
    const panes = {
      news: pane(document.querySelector(".jds-brief--news")),
      sports: pane(document.querySelector(".jds-brief--sports")),
      arsenal: pane(arsenal)
    };
    return JSON.stringify({ news, sports, newsItems, arsenalItems, arsenalText, faces, panes });
  }, DISPLAY_TEXT);
}
interface RenderedItem {
  id: string | null;
  testId: string | null;
  href: string | null;
  text: string;
}
function hasRendered(items: readonly RenderedItem[] | undefined, want?: string): boolean {
  const rows = (items ?? []).filter((el) => el.text && (el.id || el.testId || el.href));
  if (rows.length === 0) return false;
  return want ? rows.some((el) => el.text.includes(want)) : true;
}
function isPopulated(sample: string): boolean {
  const value = JSON.parse(sample) as {
    news?: { topStories?: Array<{ id?: string; title?: string; url?: string }> };
    sports?: {
      followed?: Array<{ name?: string; stories?: Array<{ title?: string; url?: string }> }>;
    };
    newsItems?: RenderedItem[];
    arsenalItems?: RenderedItem[];
    arsenalText?: string;
    faces?: Array<{ sel?: string; ready?: boolean }>;
  };
  const lead = value.news?.topStories?.[0];
  const arsenal = value.sports?.followed?.find((card) => card.name === "Arsenal");
  const apiOk = Boolean(
    lead?.id && lead.title && lead.url && arsenal?.stories?.some((s) => s.title && s.url)
  );
  const arsenalHeadline = "Arsenal seal late win to stay top of the pile";
  const faces = value.faces ?? [];
  const facesReady = faces.length > 0 && faces.every((face) => face.ready === true);
  return Boolean(
    apiOk &&
    hasRendered(value.newsItems) &&
    hasRendered(value.arsenalItems) &&
    (value.arsenalText ?? "").includes(arsenalHeadline) &&
    facesReady
  );
}
export async function waitForStablePopulated(page: Page): Promise<void> {
  await stillPage(page);
  await page.evaluate(async (sels: string[]) => {
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!(el instanceof HTMLElement)) continue;
      const cs = getComputedStyle(el);
      const text = ((el.innerText ?? "").replace(/\s+/g, " ").trim() || "Ag").slice(0, 120);
      try {
        await document.fonts.load(`${cs.fontStyle} ${cs.fontWeight} 16px ${cs.fontFamily}`, text);
      } catch {
        /* decode failure surfaces as not-ready in the sample below */
      }
    }
  }, DISPLAY_TEXT);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const first = await stableSample(page);
    await page.waitForTimeout(250);
    const second = await stableSample(page);
    if (first === second && isPopulated(first) && isPopulated(second)) return;
  }
  const detail = await stableSample(page);
  throw new Error(`parity: display face or geometry did not stabilize: ${detail.slice(0, 400)}`);
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
