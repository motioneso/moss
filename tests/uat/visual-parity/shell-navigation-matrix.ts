import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { stillPage, type RouteName, type RouteReadinessEvidence } from "./capture.js";

const PAGES = ["/today", "/tasks", "/calendar", "/settings"] as const;
const POPULATED: Record<string, readonly string[]> = {
  today: ["timeline", "weather", "news stories", "sports scores", "evening recap"],
  tasks: ["task list", "list selection", "view/filter/search controls"],
  calendar: ["calendar events", "day-plan rows"],
  settings: ["settings navigation", "settings panes"],
  chat: ["populated Today", "phase1-smoke scripted conversation"]
};

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

interface CaseSpec {
  readonly key: string;
  readonly label: string;
  readonly path: (typeof PAGES)[number];
  readonly width: 375 | 920 | 1180 | 1440;
  readonly nav: "expanded" | "rail" | "drawer";
  readonly chat: boolean;
  readonly file: string;
}

interface CaseRecord {
  readonly key: string;
  readonly file: string;
  readonly viewport: { readonly width: number; readonly height: 1000 };
  readonly navigation: string;
  readonly populatedWidgets: readonly string[];
  readonly readiness: RouteReadinessEvidence;
  readonly mainRect: Rect | null;
  readonly chatRect: Rect | null;
}

interface ShellGeometry {
  readonly navMode: string | null;
  readonly sidebarWidth: number;
  readonly sidebarX: number;
  readonly collapseVisible: boolean;
  readonly drawerOpen: boolean;
}

export interface MatrixContext {
  readonly check: (condition: boolean, message: string) => void;
  readonly shellGeometry: (page: Page) => Promise<ShellGeometry>;
  readonly openChatDrawer: (page: Page) => Promise<void>;
  readonly blurComposer: (page: Page) => Promise<void>;
  readonly expectAttr: (page: Page, mode: string) => Promise<void>;
  readonly localDay: () => string;
  readonly localIso: (day: string, time: string) => string;
  readonly openToday: (page: Page, date: Date) => Promise<void>;
  readonly waitForRoutePopulated: (page: Page, route: RouteName) => Promise<RouteReadinessEvidence>;
  readonly longTaskListName: string;
}

export async function waitForBreakpointReadiness(
  page: Page,
  context: Pick<MatrixContext, "waitForRoutePopulated" | "expectAttr">
): Promise<void> {
  await context.waitForRoutePopulated(page, "today");
  await context.expectAttr(page, "expanded");
}

const CASES: readonly CaseSpec[] = [
  ...PAGES.flatMap((path) =>
    ([1440, 375] as const).map((width) => ({
      key: `${path.slice(1)}@${width}-${width === 1440 ? "expanded" : "drawer"}`,
      label: path.slice(1),
      path,
      width,
      nav: width === 1440 ? ("expanded" as const) : ("drawer" as const),
      chat: false,
      file: `head-${width}-${path.slice(1)}.png`
    }))
  ),
  ...([1440, 375] as const).map((width) => ({
    key: `chat@${width}-${width === 1440 ? "expanded" : "drawer"}`,
    label: "chat",
    path: "/today" as const,
    width,
    nav: width === 1440 ? ("expanded" as const) : ("drawer" as const),
    chat: true,
    file: `head-${width}-chat.png`
  })),
  {
    key: "today@1440-rail",
    label: "today",
    path: "/today",
    width: 1440,
    nav: "rail",
    chat: false,
    file: "head-1440-today-rail.png"
  },
  {
    key: "today@1180-expanded",
    label: "today",
    path: "/today",
    width: 1180,
    nav: "expanded",
    chat: false,
    file: "head-1180-today.png"
  },
  {
    key: "today@920-drawer",
    label: "today",
    path: "/today",
    width: 920,
    nav: "drawer",
    chat: false,
    file: "head-920-today.png"
  }
];

function assertCaseGeometry(
  item: CaseSpec,
  geometry: ShellGeometry,
  check: (condition: boolean, message: string) => void
): void {
  if (item.key === "today@1440-rail") {
    check(geometry.sidebarWidth === 64, `${item.key} sidebar ${geometry.sidebarWidth} != 64`);
    check(geometry.navMode === "rail", `${item.key} nav mode ${geometry.navMode} != rail`);
  }
  if (item.width === 1440 && item.nav === "expanded")
    check(geometry.sidebarWidth === 194, `${item.key} sidebar ${geometry.sidebarWidth} != 194`);
  if (item.width === 1180) {
    check(geometry.sidebarWidth === 168, `${item.key} sidebar ${geometry.sidebarWidth} != 168`);
    check(geometry.collapseVisible, `${item.key} collapse button hidden`);
  }
  if (item.nav === "drawer") {
    check(!geometry.collapseVisible, `${item.key} collapse button visible`);
    check(geometry.sidebarX < 0, `${item.key} closed drawer is visible at x=${geometry.sidebarX}`);
  }
}

export function runMatrixMeasurementChecks(): void {
  if (CASES.length !== 13 || new Set(CASES.map((item) => item.key)).size !== 13)
    throw new Error("parity-shell: R4 case set is not exactly 13 unique cases");
  const today1180 = CASES.find((item) => item.key === "today@1180-expanded");
  const today920 = CASES.find((item) => item.key === "today@920-drawer");
  if (!today1180 || !today920) throw new Error("parity-shell: breakpoint cases missing");
  assertCaseGeometry(
    today1180,
    {
      navMode: "expanded",
      sidebarWidth: 168,
      sidebarX: 0,
      collapseVisible: true,
      drawerOpen: false
    },
    requireEvidence
  );
  assertCaseGeometry(
    today920,
    {
      navMode: "expanded",
      sidebarWidth: 168,
      sidebarX: -168,
      collapseVisible: false,
      drawerOpen: false
    },
    requireEvidence
  );
  const expectFailure = (item: CaseSpec, geometry: ShellGeometry, message: string): void => {
    let failed = false;
    try {
      assertCaseGeometry(item, geometry, requireEvidence);
    } catch {
      failed = true;
    }
    requireEvidence(failed, message);
  };
  expectFailure(
    today1180,
    {
      navMode: "expanded",
      sidebarWidth: 167,
      sidebarX: 0,
      collapseVisible: true,
      drawerOpen: false
    },
    "synthetic 1180 wrong width was accepted"
  );
  expectFailure(
    today920,
    {
      navMode: "expanded",
      sidebarWidth: 168,
      sidebarX: 0,
      collapseVisible: false,
      drawerOpen: false
    },
    "synthetic 920 visible drawer was accepted"
  );
}

function requireEvidence(condition: boolean, message: string): void {
  if (!condition) throw new Error("parity-shell: " + message);
}

async function measuredRects(page: Page): Promise<{ main: Rect | null; chat: Rect | null }> {
  return page.evaluate(() => {
    const read = (selector: string): Rect | null => {
      const b = document.querySelector(selector)?.getBoundingClientRect();
      return b
        ? {
            x: Math.round(b.x),
            y: Math.round(b.y),
            w: Math.round(b.width),
            h: Math.round(b.height)
          }
        : null;
    };
    return { main: read("main"), chat: read(".chatd") };
  });
}

async function visitCase(
  page: Page,
  item: CaseSpec,
  context: MatrixContext,
  outDir: string
): Promise<CaseRecord> {
  await page.setViewportSize({ width: item.width, height: 1000 });
  await page.goto(item.path);
  if (item.path === "/today")
    await context.openToday(page, new Date(context.localIso(context.localDay(), "08:00")));
  await page.evaluate((mode) => localStorage.setItem("jarvis.nav:v1", mode), "expanded");
  await page.reload();
  await stillPage(page);
  if (item.nav === "rail") {
    await page.getByRole("button", { name: "Collapse navigation" }).click();
    await context.expectAttr(page, "rail");
  }
  const readiness = await context.waitForRoutePopulated(page, item.path.slice(1) as RouteName);
  if (item.chat) {
    await context.openChatDrawer(page);
    await context.blurComposer(page);
  }
  await stillPage(page);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.getSelection()?.removeAllRanges();
  });
  const geometry = await context.shellGeometry(page);
  assertCaseGeometry(item, geometry, context.check);
  const imagePath = join(outDir, "shell", item.file);
  mkdirSync(join(outDir, "shell"), { recursive: true });
  await page.screenshot({
    path: imagePath,
    ...(item.width === 1440 ? {} : { clip: { x: 0, y: 0, width: item.width, height: 850 } })
  });
  const measured = await measuredRects(page);
  if (item.chat) {
    context.check(!!measured.chat, `${item.key} Chat overlay geometry missing`);
    context.check(
      (await page.locator(".chatd-msg:not(.chatd-msg--me) .chatd-bubble").count()) > 0,
      `${item.key} populated Chat evidence missing`
    );
  }
  if (item.chat)
    await page
      .getByRole("button", { name: "Close chat" })
      .click()
      .catch(() => undefined);
  return {
    key: item.key,
    file: item.file,
    viewport: { width: item.width, height: 1000 },
    navigation: item.nav,
    populatedWidgets: POPULATED[item.label] ?? [],
    readiness,
    mainRect: measured.main,
    chatRect: item.chat ? measured.chat : null
  };
}

export async function runShellMatrix(
  page: Page,
  outDir: string,
  notes: string[],
  context: MatrixContext
): Promise<void> {
  const records: Record<string, CaseRecord> = {};
  for (const item of CASES) {
    records[item.key] = await visitCase(page, item, context, outDir);
    notes.push(`${item.key} populated capture saved (${item.file})`);
  }
  context.check(Object.keys(records).length === 13, "R4 matrix did not capture 13 cases");
  const productSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(outDir, "shell", "matrix-manifest.json"),
    JSON.stringify(
      { revision: "VP-P1-R4", productSha, seedDate: context.localDay(), cases: records },
      null,
      2
    ) + "\n"
  );
  notes.push("R4 populated HEAD matrix captured: 13 cases");

  await page.setViewportSize({ width: 1181, height: 1000 });
  await page.goto("/today");
  await stillPage(page);
  await waitForBreakpointReadiness(page, context);
  const at1181 = await context.shellGeometry(page);
  context.check(at1181.sidebarWidth === 194, `Today @1181 sidebar ${at1181.sidebarWidth} != 194`);
  await page.setViewportSize({ width: 1180, height: 1000 });
  const at1180 = await context.shellGeometry(page);
  context.check(at1180.sidebarWidth === 168, `Today @1180 sidebar ${at1180.sidebarWidth} != 168`);
  await page.setViewportSize({ width: 921, height: 1000 });
  const at921 = await context.shellGeometry(page);
  context.check(at921.sidebarWidth === 168, `Today @921 sidebar ${at921.sidebarWidth} != 168`);
  await page.setViewportSize({ width: 920, height: 1000 });
  const at920 = await context.shellGeometry(page);
  context.check(
    !at920.collapseVisible && at920.sidebarX < 0,
    "Today @920 did not switch to drawer"
  );
  notes.push("Today breakpoint edges 1181/1180 and 921/920 checked");
}
