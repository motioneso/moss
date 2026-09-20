// tests/uat/visual-parity/capture.ts: region capture, honest masking, pixel diff, report lines.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { expect, type Page } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { assertEveningRenderedContract } from "./evening-readiness.js";
import { maskRects } from "./masks.js";
import type { MockupEntry } from "./mockups.js";
export interface CaptureResult {
  readonly file: string;
  readonly size: string;
  readonly maskedShare: number;
  readonly diffPercent: number;
  readonly sizeMatch: boolean;
  readonly artifactSha256: string;
  readonly crop: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly geometrySidecar?: {
    readonly path: string;
    readonly sha256: string;
  };
}
export interface CaptureArtifactDirs {
  readonly raw: string;
  readonly masked: string;
  readonly diffs: string;
}
export interface ComparatorControlResult {
  readonly zeroPercent: number;
  readonly changedPercent: number;
  readonly artifacts: readonly { readonly path: string; readonly sha256: string }[];
}
export interface GuardCaptureResult {
  readonly capturePath: string;
  readonly rawPath: string;
  readonly controlPath: string;
  readonly sha256: string;
  readonly crop: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly elapsedMs: number;
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
  outDir: string,
  artifactDirs?: CaptureArtifactDirs
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
    const locator = page.locator(entry.region.selector).first();
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) throw new Error(`parity: ${entry.region.selector} has no box for ${entry.name}`);
    shot = await locator.screenshot();
    const boxAfter = await locator.boundingBox();
    if (
      !boxAfter ||
      boxAfter.x !== box.x ||
      boxAfter.y !== box.y ||
      boxAfter.width !== box.width ||
      boxAfter.height !== box.height
    ) {
      throw new Error(`parity: bounding box moved during capture for ${entry.name}`);
    }
    ox = box.x;
    oy = box.y;
  }
  const rawBytes = shot;
  const rawDir = artifactDirs?.raw ?? outDir;
  const maskedDir = artifactDirs?.masked ?? outDir;
  const diffDir = artifactDirs?.diffs ?? outDir;
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(maskedDir, { recursive: true });
  mkdirSync(diffDir, { recursive: true });
  const rawPath = join(rawDir, entry.name);
  const maskedPath = join(maskedDir, entry.name);
  const diffPath = join(diffDir, entry.name.replace(/\.png$/, ".diff.png"));
  if (artifactDirs) writeFileSync(rawPath, rawBytes);
  const mockup = PNG.sync.read(readFileSync(join(mockupRoot, entry.dir, entry.name)));
  const capture = PNG.sync.read(shot);
  const sizeMatch = capture.width === mockup.width && capture.height === mockup.height;
  const masks = toImageSpace(await maskRects(page), ox, oy);
  const maskedPixels = paintMask(capture, masks);
  const maskedShare = maskedPixels / (capture.width * capture.height);
  let diffPercent: number;
  if (!sizeMatch) {
    diffPercent = 100;
    writeFileSync(maskedPath, PNG.sync.write(capture));
    writeFileSync(diffPath, PNG.sync.write(capture));
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
    writeFileSync(maskedPath, PNG.sync.write(capture));
    writeFileSync(diffPath, PNG.sync.write(diff));
  }
  let geometrySidecar: { path: string; sha256: string } | undefined;
  if (entry.region.kind === "element" && artifactDirs) {
    const sidecarPath = join(rawDir, entry.name.replace(/\.png$/, ".geometry.json"));
    const rawSha256 = createHash("sha256").update(rawBytes).digest("hex");
    const geometry = {
      identity: `${entry.dir}/${entry.name}`,
      selector: entry.region.selector,
      viewport: { width: entry.viewport.w, height: entry.viewport.h },
      crop: { x: ox, y: oy, width: capture.width, height: capture.height },
      rawSha256
    };
    const sidecarContent = JSON.stringify(geometry, null, 2);
    writeFileSync(sidecarPath, sidecarContent);
    geometrySidecar = {
      path: sidecarPath,
      sha256: createHash("sha256").update(sidecarContent).digest("hex")
    };
  }
  return {
    file: entry.name,
    size: `${capture.width}x${capture.height}`,
    maskedShare,
    diffPercent,
    sizeMatch,
    artifactSha256: createHash("sha256").update(rawBytes).digest("hex"),
    crop: { x: ox, y: oy, width: capture.width, height: capture.height },
    ...(geometrySidecar ? { geometrySidecar } : {})
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

export type RouteName = "tasks" | "calendar" | "settings" | "today" | "evening";

export interface RouteReadinessExpectations {
  readonly taskTitle?: string;
  readonly meetingTitle?: string;
  readonly eventTitles?: readonly string[];
  readonly settingsPaneTitle?: string;
  readonly eveningSummary?: string;
  readonly tomorrowTaskTitle?: string;
  readonly tomorrowEventTitle?: string;
}

export interface RouteReadinessEvidence {
  readonly route: RouteName;
  readonly matched: readonly string[];
  readonly loadingAbsent: true;
  readonly fontsReady: true;
  readonly elapsedMs: number;
}

async function routeText(
  page: Page,
  selector: string,
  expected: string | RegExp,
  label: string,
  matched: string[]
): Promise<void> {
  const locator = page.locator(selector).filter({ hasText: expected }).first();
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  const text = (await locator.innerText()).replace(/\s+/g, " ").trim();
  matched.push(`${label}: ${text.slice(0, 180)}`);
}

async function routeVisible(
  page: Page,
  selector: string,
  label: string,
  matched: string[]
): Promise<void> {
  await page.locator(selector).first().waitFor({ state: "visible", timeout: 30_000 });
  matched.push(label);
}

type WeatherSnapshot = {
  readonly elementPresent: boolean;
  readonly locationText: string | null;
  readonly currentTemperatureText: string | null;
  readonly conditionText: string | null;
  readonly tileCount: number;
  readonly firstTile: { readonly label: string | null; readonly temperature: string | null } | null;
  readonly unavailableLoadingText: string | null;
};

async function weatherSnapshot(page: Page): Promise<WeatherSnapshot> {
  return page.evaluate(() => {
    const root = document.querySelector("#weather");
    const text = (selector: string): string | null => {
      const value = root?.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim();
      return value ? value.slice(0, 180) : null;
    };
    const tiles = root?.querySelectorAll(".jds-weather-chip__day") ?? [];
    const unavailable = root?.querySelector(".cmd-empty, .empty-state, .pane__loading");
    return {
      elementPresent: root !== null,
      locationText: text(".jds-weather-chip__location"),
      currentTemperatureText: text(".wx-row .jds-brief__title"),
      conditionText: text(".wx-row > div > div:nth-child(2)"),
      tileCount: tiles.length,
      firstTile:
        tiles.length > 0
          ? {
              label:
                tiles[0]?.querySelector(".jds-weather-chip__label")?.textContent?.trim() || null,
              temperature:
                tiles[0]?.querySelector(".jds-weather-chip__temp")?.textContent?.trim() || null
            }
          : null,
      unavailableLoadingText:
        unavailable?.textContent?.replace(/\s+/g, " ").trim().slice(0, 180) ?? null
    };
  });
}

async function logWeatherSnapshot(
  page: Page,
  route: RouteName,
  phase: "before" | "after" | "failure"
) {
  console.log(
    `[parity-weather] route=${route} phase=${phase} ${JSON.stringify(await weatherSnapshot(page))}`
  );
}

function isWeatherPopulated(snapshot: WeatherSnapshot): boolean {
  const nonempty = (value: string | null): boolean => Boolean(value?.trim());
  return Boolean(
    snapshot.elementPresent &&
    nonempty(snapshot.locationText) &&
    nonempty(snapshot.currentTemperatureText) &&
    nonempty(snapshot.conditionText) &&
    Number.isInteger(snapshot.tileCount) &&
    snapshot.tileCount > 0 &&
    snapshot.firstTile !== null &&
    nonempty(snapshot.firstTile.label) &&
    nonempty(snapshot.firstTile.temperature) &&
    !nonempty(snapshot.unavailableLoadingText)
  );
}

async function visibleWeatherFallback(page: Page, route: RouteName): Promise<void> {
  const unavailable = await page
    .locator("#weather .cmd-empty, #weather .empty-state, #weather .pane__loading")
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => {
          const style = getComputedStyle(node);
          return style.display !== "none" && style.visibility !== "hidden";
        })
        .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 180))
    );
  if (unavailable.length > 0)
    throw new Error(`parity: ${route} weather unavailable/loading: ${unavailable.join(" | ")}`);
}

async function waitForWeather(
  page: Page,
  route: RouteName,
  matched: string[],
  deadlineAt?: number
): Promise<void> {
  await logWeatherSnapshot(page, route, "before");
  try {
    await routeVisible(page, "#weather", "Weather region", matched);
    await visibleWeatherFallback(page, route);
    const remaining = deadlineAt === undefined ? 30_000 : deadlineAt - Date.now();
    const timeout = Math.min(30_000, remaining);
    if (timeout <= 0) throw new Error(`parity-smoke: 180s budget exceeded before ${route} weather`);
    await expect
      .poll(async () => isWeatherPopulated(await weatherSnapshot(page)), { timeout })
      .toBe(true);
    await visibleWeatherFallback(page, route);
    const snapshot = await weatherSnapshot(page);
    if (!isWeatherPopulated(snapshot))
      throw new Error(
        `parity: ${route} weather populated predicate changed: ${JSON.stringify(snapshot)}`
      );
    matched.push(`weather: ${JSON.stringify(snapshot)}`);
    try {
      await logWeatherSnapshot(page, route, "after");
    } catch {
      // Diagnostics are best effort and must not replace the readiness result.
    }
    matched.push(`weather tiles: ${await page.locator("#weather .jds-weather-chip__day").count()}`);
  } catch (error) {
    try {
      await logWeatherSnapshot(page, route, "failure");
    } catch {
      // Preserve the original readiness assertion if diagnostics cannot be collected.
    }
    throw error;
  }
}

export function runWeatherReadinessChecks(): void {
  const smoke3: WeatherSnapshot = {
    elementPresent: true,
    locationText: "San Francisco",
    currentTemperatureText: "66°F",
    conditionText: "Overcast",
    tileCount: 5,
    firstTile: { label: "Now", temperature: "66°" },
    unavailableLoadingText: null
  };
  const alternative = { ...smoke3, locationText: "Tokyo", currentTemperatureText: "21°C" };
  assert.equal(isWeatherPopulated(smoke3), true);
  assert.equal(isWeatherPopulated(alternative), true);
  const reject = (label: string, patch: Partial<WeatherSnapshot>): void =>
    assert.equal(isWeatherPopulated({ ...smoke3, ...patch }), false, label);
  reject("absent root", { elementPresent: false });
  reject("missing location", { locationText: null });
  reject("blank location", { locationText: "   " });
  reject("missing temperature", { currentTemperatureText: null });
  reject("blank temperature", { currentTemperatureText: "   " });
  reject("missing condition", { conditionText: null });
  reject("blank condition", { conditionText: "   " });
  reject("zero tiles", { tileCount: 0 });
  reject("absent first tile", { firstTile: null });
  reject("missing tile label", { firstTile: { label: null, temperature: "66°" } });
  reject("blank tile label", { firstTile: { label: "   ", temperature: "66°" } });
  reject("missing tile temperature", { firstTile: { label: "Now", temperature: null } });
  reject("blank tile temperature", { firstTile: { label: "Now", temperature: "   " } });
  reject("unavailable/loading text", { unavailableLoadingText: "Weather isn't available" });
}

async function routeLoadingAbsent(page: Page, route: RouteName): Promise<void> {
  const visibleLoading = await page.locator(".empty-state, .pane__loading").evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim())
  );
  if (visibleLoading.length > 0)
    throw new Error(
      `parity: ${route} loading state remained visible: ${visibleLoading.join(" | ")}`
    );
}

interface FontState {
  readonly status: string;
  readonly faces: readonly {
    readonly family: string;
    readonly weight: string;
    readonly style: string;
    readonly status: string;
  }[];
}

async function readFontState(page: Page): Promise<FontState> {
  return page.evaluate(() => {
    const faces: Array<FontState["faces"][number]> = [];
    document.fonts.forEach((face) =>
      faces.push({
        family: face.family,
        weight: face.weight,
        style: face.style,
        status: face.status
      })
    );
    return { status: document.fonts.status, faces };
  });
}

function fontStateMessage(state: FontState): string {
  return JSON.stringify(state.faces);
}

async function assertFontsReady(page: Page, route: RouteName): Promise<void> {
  const state = await readFontState(page);
  const errored = state.faces.filter((face) => face.status === "error");
  if (state.status !== "loaded" || errored.length > 0)
    throw new Error(`parity: ${route} fonts not ready: ${fontStateMessage(state)}`);
}

async function waitForFontsReady(page: Page, route: RouteName, deadlineAt?: number): Promise<void> {
  const remaining = deadlineAt === undefined ? 30_000 : deadlineAt - Date.now();
  const timeout = Math.min(30_000, remaining);
  if (timeout <= 0) throw new Error(`parity-smoke: 180s budget exceeded before ${route} fonts`);
  try {
    await page.waitForFunction(() => document.fonts.status === "loaded", { timeout });
  } catch {
    const state = await readFontState(page);
    throw new Error(
      `parity: ${route} fonts did not reach loaded state within ${timeout}ms: ${fontStateMessage(state)}`
    );
  }
  await assertFontsReady(page, route);
}

export async function waitForRoutePopulated(
  page: Page,
  route: RouteName,
  expected: RouteReadinessExpectations,
  deadlineAt?: number
): Promise<RouteReadinessEvidence> {
  const started = Date.now();
  const matched: string[] = [];
  await stillPage(page);
  // Font loading is checked after route content mounts; content can trigger new faces.

  if (route === "tasks") {
    await routeVisible(page, ".tasks-wrap", "Tasks region", matched);
    await routeVisible(page, '[role="group"][aria-label="View"]', "List/Matrix control", matched);
    await routeVisible(
      page,
      '[role="group"][aria-label="Status filter"]',
      "Status filter",
      matched
    );
    await routeVisible(page, ".tk-listfilter", "All lists control", matched);
    await routeVisible(page, '[aria-label="Toggle search"]', "Search control", matched);
    await routeText(
      page,
      ".tk-task__title",
      expected.taskTitle ?? "Parity",
      "seeded task",
      matched
    );
  } else if (route === "calendar") {
    await routeVisible(page, ".cal-wrap", "Calendar region", matched);
    await routeVisible(page, ".cal-toolbar", "Calendar toolbar", matched);
    await routeVisible(page, ".cal-body", "Calendar body", matched);
    for (const title of expected.eventTitles ?? [])
      await routeText(page, ".cal-body", title, "seeded calendar content", matched);
  } else if (route === "settings") {
    await routeVisible(page, ".set2", "Settings region", matched);
    await routeVisible(
      page,
      'nav[aria-label="Settings categories"]',
      "Settings categories",
      matched
    );
    await routeVisible(page, ".set2__navitem.is-active", "Active settings category", matched);
    await routeVisible(page, ".set2__pane", "Selected settings pane", matched);
    await routeText(
      page,
      ".set2__pane",
      expected.settingsPaneTitle ?? "Account & preferences",
      "selected settings content",
      matched
    );
  } else if (route === "today") {
    await waitForStablePopulated(page);
    await routeVisible(page, ".cmd-wrap", "Today content", matched);
    await routeVisible(page, ".jds-brief--news", "News widget", matched);
    await routeVisible(page, ".jds-brief--sports", "Sports widget", matched);
    if (expected.taskTitle)
      await routeText(page, ".cmd-main", expected.taskTitle, "seeded Today task", matched);
    if (expected.meetingTitle)
      await routeText(page, ".cmd-main", expected.meetingTitle, "seeded Today meeting", matched);
    await waitForWeather(page, route, matched, deadlineAt);
  } else {
    await routeVisible(page, ".cmd-wrap", "Evening content", matched);
    await routeText(page, ".jds-brief", "Evening review", "Evening review", matched);
    await routeText(page, ".jds-brief", "What happened today", "Evening summary title", matched);
    await routeVisible(page, ".jds-brief__body", "Rendered evening summary", matched);
    await routeVisible(page, ".evening-prep__btn", "Prep for tomorrow action", matched);
    for (const [selector, label] of [
      ["main h1", "Evening heading"],
      [".jds-brief__title", "Evening section title"],
      [".jds-brief__body", "Evening body"]
    ] as const) {
      const text = (await page.locator(selector).first().innerText())
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 600);
      matched.push(`${label}: ${text}`);
    }
    if (expected.eveningSummary) {
      await assertEveningRenderedContract(expected.eveningSummary, {
        heading: await page.locator("main h1").first().innerText(),
        body: await page.locator(".jds-brief__body").first().innerText()
      });
      matched.push("Evening heading/body contract: accepted");
    }
    if (expected.tomorrowTaskTitle)
      await routeText(
        page,
        ".cmd-main",
        expected.tomorrowTaskTitle,
        "seeded tomorrow task",
        matched
      );
    if (expected.tomorrowEventTitle)
      await routeText(
        page,
        ".cmd-main",
        expected.tomorrowEventTitle,
        "seeded tomorrow event",
        matched
      );
  }
  await routeLoadingAbsent(page, route);
  await waitForFontsReady(page, route, deadlineAt);
  await routeLoadingAbsent(page, route);
  await assertFontsReady(page, route);
  if (route === "evening") {
    console.log(
      `[parity-evening-readiness] ${JSON.stringify({
        route,
        viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
        url: page.url(),
        observations: matched.filter((entry) => entry.startsWith("Evening "))
      })}`
    );
  }
  return { route, matched, loadingAbsent: true, fontsReady: true, elapsedMs: Date.now() - started };
}
export function reportLine(r: CaptureResult): string {
  return `| ${r.file} | ${r.size} | ${(r.maskedShare * 100).toFixed(1)}% | ${r.diffPercent.toFixed(2)}% | ${r.sizeMatch ? "size-ok" : "SIZE-MISMATCH"} |`;
}
export function artifactSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
// Finds the first fully-opaque pixel (alpha 255) in raster order whose
// in-bounds neighbours all equal it. A lone changed pixel on a slope reads
// as anti-aliasing to the comparer and diffs to zero, so the control must
// land on flat bytes to be provable through a real pixel-threshold
// comparison. Falls back to the first opaque pixel when nothing is flat.
function firstOpaquePixelOffset(png: PNG): number | null {
  let fallback: number | null = null;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (png.width * y + x) * 4;
      if (png.data[offset + 3] !== 255) continue;
      if (fallback === null) fallback = offset;
      if (isFlatPixel(png, x, y, offset)) return offset;
    }
  }
  return fallback;
}
// True when every in-bounds 8-neighbour equals the pixel's own bytes. A
// pixel with no in-bounds neighbours counts as flat.
function isFlatPixel(png: PNG, x: number, y: number, offset: number): boolean {
  for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, png.height - 1); ny += 1) {
    for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, png.width - 1); nx += 1) {
      if (nx === x && ny === y) continue;
      const neighbour = (png.width * ny + nx) * 4;
      if (
        png.data[neighbour] !== png.data[offset] ||
        png.data[neighbour + 1] !== png.data[offset + 1] ||
        png.data[neighbour + 2] !== png.data[offset + 2] ||
        png.data[neighbour + 3] !== png.data[offset + 3]
      )
        return false;
    }
  }
  return true;
}
// Picks the black/white RGB value with the larger contrast against the pixel's
// own luminance, so the mutation is always visible to a threshold-0.1 compare
// regardless of the source color.
function contrastingRgb(r: number, g: number, b: number): number {
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  return luminance > 127 ? 0 : 255;
}
// Mutates one opaque pixel's RGB to a contrasting black/white value in place,
// leaving its alpha and every other byte untouched. Throws when the image has
// no opaque pixel at all, so a control never silently reports a false pass.
export function applyContrastingControl(png: PNG): void {
  const offset = firstOpaquePixelOffset(png);
  if (offset === null)
    throw new Error("parity case selection: no opaque pixel available for a comparison control");
  const contrast = contrastingRgb(
    png.data[offset] ?? 0,
    png.data[offset + 1] ?? 0,
    png.data[offset + 2] ?? 0
  );
  png.data[offset] = contrast;
  png.data[offset + 1] = contrast;
  png.data[offset + 2] = contrast;
}
export function writeComparisonControls(
  capturePath: string,
  controlsDir: string,
  name: string
): ComparatorControlResult {
  mkdirSync(controlsDir, { recursive: true });
  const control = PNG.sync.read(readFileSync(capturePath));
  const changedPath = join(controlsDir, `${name}.changed.png`);
  const zeroDiffPath = join(controlsDir, `${name}.zero.diff.png`);
  const changedDiffPath = join(controlsDir, `${name}.changed.diff.png`);
  applyContrastingControl(control);
  writeFileSync(changedPath, PNG.sync.write(control));
  const zeroPercent = diffFiles(capturePath, capturePath, zeroDiffPath);
  const changedPercent = diffFiles(capturePath, changedPath, changedDiffPath);
  return {
    zeroPercent,
    changedPercent,
    artifacts: [changedPath, zeroDiffPath, changedDiffPath].map((path) => ({
      path,
      sha256: artifactSha256(path)
    }))
  };
}
export async function guardCapture(
  page: Page,
  name: string,
  w: number,
  outDir: string,
  rawDir = outDir,
  controlsDir = outDir
): Promise<GuardCaptureResult> {
  const startedAt = Date.now();
  await page.setViewportSize({ width: w, height: 1000 });
  await stillPage(page);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(controlsDir, { recursive: true });
  const bytes = await page.screenshot({ clip: { x: 0, y: 0, width: w, height: 850 } });
  const capturePath = join(outDir, `${name}.png`);
  const rawPath = join(rawDir, `${name}.png`);
  const controlPath = join(controlsDir, `${name}.control.png`);
  writeFileSync(capturePath, bytes);
  writeFileSync(rawPath, bytes);
  writeFileSync(controlPath, bytes);
  return {
    capturePath,
    rawPath,
    controlPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    crop: { x: 0, y: 0, width: w, height: 850 },
    elapsedMs: Date.now() - startedAt
  };
}
export function compareCaptureToBase(
  maskedCapturePath: string,
  declaredBasePath: string,
  baseDiffOutPath: string
): number {
  return diffFiles(maskedCapturePath, declaredBasePath, baseDiffOutPath);
}
// Declared reference bytes go through the same comparator as the base: a
// swapped reference fails here instead of passing with only its name bound.
export function compareReferenceCapture(
  maskedCapturePath: string,
  referenceAbsolute: string,
  referenceDiffOutPath: string
): { percent: number; sha256: string } {
  if (!existsSync(referenceAbsolute))
    throw new Error(`parity case selection: missing declared reference ${referenceAbsolute}`);
  const percent = compareCaptureToBase(maskedCapturePath, referenceAbsolute, referenceDiffOutPath);
  if (percent > 0.5)
    throw new Error(`parity case selection: reference comparison ${percent.toFixed(2)}% > 0.5%`);
  return {
    percent,
    sha256: createHash("sha256").update(readFileSync(referenceAbsolute)).digest("hex")
  };
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
