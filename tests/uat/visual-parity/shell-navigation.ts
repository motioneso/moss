// P1 shell/navigation and Tasks-overflow checks on the real seeded stack.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

import { stillPage } from "./capture.js";
import {
  runMatrixMeasurementChecks,
  runShellMatrix,
  type MatrixContext
} from "./shell-navigation-matrix.js";

const NAV_ASIDE_SELECTOR = "aside.sidebar";
const NAV_CONTROL_SELECTOR =
  'button[aria-label="Collapse navigation"], button[aria-label="Expand navigation"]';

export interface ShellGeometry {
  readonly navMode: string | null;
  readonly sidebarWidth: number;
  readonly sidebarX: number;
  readonly collapseVisible: boolean;
  readonly drawerOpen: boolean;
  readonly paddingLeft: string;
  readonly linkGap: string;
  readonly linkPadding: string;
  readonly linkFont: string;
  readonly selectedBg: string;
  readonly selectedFg: string;
}

export async function shellGeometry(page: Page): Promise<ShellGeometry> {
  return page.evaluate((navControlSelector) => {
    const frame = document.querySelector(".app-frame");
    const sidebar = Array.from(document.querySelectorAll("aside")).find((aside) =>
      aside.querySelector(navControlSelector)
    ) as HTMLElement | null;
    const box = sidebar?.getBoundingClientRect();
    const link = sidebar?.querySelector(".module-link") as HTMLElement | null;
    const active = sidebar?.querySelector(".module-link.active") as HTMLElement | null;
    const collapse = sidebar?.querySelector(".nav-collapse") as HTMLElement | null;
    const cs = (el: Element | null) => (el ? getComputedStyle(el) : null);
    return {
      navMode: frame?.getAttribute("data-nav") ?? null,
      sidebarWidth: Math.round(box?.width ?? -1),
      sidebarX: Math.round(box?.x ?? -999),
      collapseVisible: Boolean(collapse && cs(collapse)?.display !== "none"),
      drawerOpen: sidebar?.classList.contains("open") ?? false,
      paddingLeft: cs(sidebar)?.paddingLeft ?? "?",
      linkGap: cs(sidebar?.querySelector(".module-nav") ?? null)?.gap ?? "?",
      linkPadding: link ? `${cs(link)?.paddingTop} ${cs(link)?.paddingRight}` : "?",
      linkFont: link ? `${cs(link)?.fontSize}/${cs(link)?.fontWeight}` : "?",
      selectedBg: cs(active)?.backgroundColor ?? "?",
      selectedFg: cs(active)?.color ?? "?"
    };
  }, NAV_CONTROL_SELECTOR);
}

export function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`parity-shell: ${message}`);
}

export async function openChatDrawer(page: Page): Promise<void> {
  await page
    .locator("header.topbar")
    .getByRole("button", { name: /open chat|chat with/i })
    .click();
  await page.getByRole("button", { name: "Close chat" }).waitFor({ timeout: 10000 });
  const newChat = page.getByRole("button", { name: "New chat" });
  const replies = page
    .locator(".chatd-msg:not(.chatd-msg--me) .chatd-bubble")
    .filter({ hasText: /\S/ });
  if (await newChat.count()) {
    const clearResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.pathname === "/api/chat/clear" &&
        url.searchParams.get("surface") === "drawer"
      );
    });
    await newChat.click();
    const response = await clearResponse;
    if (response.status() !== 204) throw new Error("parity-shell: chat clear failed");
    await page.waitForFunction(
      () => document.querySelectorAll(".chatd-msg:not(.chatd-msg--me) .chatd-bubble").length === 0,
      undefined,
      { timeout: 10000 }
    );
    const previousReplyCount = await replies.count();
    const composer = page.getByRole("textbox", { name: /^Message/ }).first();
    await composer.waitFor({ timeout: 10000 });
    await composer.fill("What are my goals?");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await replies.nth(previousReplyCount).waitFor({ state: "visible", timeout: 120000 });
    return;
  }
  if ((await replies.count()) > 0) {
    await replies.last().waitFor({ state: "visible", timeout: 10000 });
    return;
  }
  const composer = page.getByRole("textbox", { name: /^Message/ }).first();
  await composer.waitFor({ timeout: 10000 });
  await composer.fill("What are my goals?");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await replies.last().waitFor({ state: "visible", timeout: 120000 });
}

export async function blurComposer(page: Page): Promise<void> {
  const composer = page.getByRole("textbox", { name: /^Message/ });
  if (await composer.count()) await composer.first().evaluate((el) => (el as HTMLElement).blur());
}

export async function runShellChecks(
  page: Page,
  outDir: string,
  readiness: Pick<MatrixContext, "waitForRoutePopulated" | "longTaskListName">
): Promise<void> {
  const { localIso, localDay, openToday } = await import("./seed.js");
  const { runThemeContrastChecks } = await import("./shell-navigation-theme.js");
  const dir = join(outDir, "shell");
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];

  await runShellMatrix(page, outDir, notes, {
    check,
    shellGeometry,
    openChatDrawer,
    blurComposer,
    expectAttr,
    localDay,
    localIso,
    openToday,
    ...readiness
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/today");
  await stillPage(page);
  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expectAttr(page, "rail");
  let geometry = await shellGeometry(page);
  check(geometry.sidebarWidth === 64, `rail width ${geometry.sidebarWidth} != 64`);
  check(
    await page
      .locator(NAV_ASIDE_SELECTOR)
      .getByRole("button", { name: /account menu/i })
      .isVisible(),
    "rail hides account-menu trigger"
  );
  const chatOpener = page
    .locator("header.topbar")
    .getByRole("button", { name: /open chat|chat with/i });
  check(await chatOpener.isVisible(), "rail hides chat opener");
  await chatOpener.click();
  await page.getByRole("button", { name: "Close chat" }).click();
  await page.getByRole("button", { name: "Expand navigation" }).click();
  await expectAttr(page, "expanded");
  geometry = await shellGeometry(page);
  check(geometry.sidebarWidth === 194, `restored width ${geometry.sidebarWidth} != 194`);
  notes.push("collapse/expand, rail account and Chat controls ok");

  const browser = page.context().browser();
  check(!!browser, "no browser for reload-persistence context");
  const ctx = await browser!.newContext({ baseURL: new URL(page.url()).origin });
  await ctx.addCookies(await page.context().cookies());
  const persisted = await ctx.newPage();
  await persisted.setViewportSize({ width: 1440, height: 1000 });
  await persisted.goto("/today");
  await stillPage(persisted);
  await persisted.evaluate(() => localStorage.setItem("jarvis.nav:v1", "rail"));
  await persisted.reload();
  await stillPage(persisted);
  await expectAttr(persisted, "rail");
  const persistedGeometry = await shellGeometry(persisted);
  const persistedStorage = await persisted.evaluate(() => localStorage.getItem("jarvis.nav:v1"));
  check(
    persistedStorage === "rail" && persistedGeometry.navMode === "rail",
    `reloaded nav storage=${persistedStorage ?? "missing"} mode=${persistedGeometry.navMode ?? "missing"} width=${persistedGeometry.sidebarWidth}`
  );
  check(
    persistedGeometry.sidebarWidth === 64,
    `reloaded rail width ${persistedGeometry.sidebarWidth} != 64`
  );
  await ctx.close();
  notes.push("rail preference persists across reload");

  await page.getByRole("button", { name: "Collapse navigation" }).click();
  await expectAttr(page, "rail");
  await page.setViewportSize({ width: 375, height: 1000 });
  await page.goto("/today");
  await stillPage(page);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.locator(`${NAV_ASIDE_SELECTOR}.open`).waitFor({ timeout: 10000 });
  check(
    await page.locator(`${NAV_ASIDE_SELECTOR}.open .brand-wordmark`).isVisible(),
    "drawer lacks full labels"
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    (navAsideSelector) => !document.querySelector(navAsideSelector)?.classList.contains("open"),
    NAV_ASIDE_SELECTOR,
    { timeout: 10000 }
  );
  check(
    (await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) ===
      "Open navigation",
    "Escape did not restore opener focus"
  );
  for (const dest of ["Tasks", "Calendar"]) {
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.locator(`${NAV_ASIDE_SELECTOR}.open`).waitFor({ timeout: 10000 });
    await page.getByRole("link", { name: dest, exact: true }).click();
    await page.waitForFunction(
      (navAsideSelector) => !document.querySelector(navAsideSelector)?.classList.contains("open"),
      NAV_ASIDE_SELECTOR,
      { timeout: 10000 }
    );
  }
  notes.push("stored-rail drawer labels, Escape focus and destination close ok");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/today");
  await stillPage(page);
  const order = await page.evaluate((navAsideSelector) => {
    const aside = document.querySelector(navAsideSelector);
    const focusable = aside
      ? Array.from(aside.querySelectorAll("a[href],button:not([disabled])"))
      : [];
    const names = focusable.map(
      (el) => el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 24) ?? "?"
    );
    return {
      names,
      badTabindex: focusable.filter((el) => (el as HTMLElement).tabIndex > 0).length,
      collapseIdx: names.findIndex((name) => /^(Collapse|Expand) navigation$/.test(name))
    };
  }, NAV_ASIDE_SELECTOR);
  check(order.badTabindex === 0, "positive tabindex in sidebar");
  check(
    order.collapseIdx >= 0 && order.collapseIdx < 2,
    `collapse not by logo: ${order.collapseIdx}`
  );
  notes.push(`keyboard order ok: ${order.names.slice(0, 6).join(" | ")}`);

  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/tasks");
    await readiness.waitForRoutePopulated(page, "tasks");
    await stillPage(page);
    const searchToggle = page.locator('.tk-bar button[aria-label="Toggle search"]').first();
    if (await searchToggle.count()) await searchToggle.click();
    await page.getByRole("button", { name: readiness.longTaskListName }).click();
    await page.locator(".tk-tagmenu__item").filter({ hasText: readiness.longTaskListName }).click();
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      const bar = document.querySelector(".tk-bar");
      const controls = bar
        ? Array.from(bar.querySelectorAll("button,a,input,select")).map((el) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return {
              name: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 20) ?? "?",
              x: r.x,
              w: r.width,
              visible: r.width > 0 && r.height > 0
            };
          })
        : [];
      return { scrollW: doc.scrollWidth, innerW: window.innerWidth, controls };
    });
    check(
      overflow.scrollW <= overflow.innerW,
      `Tasks @${width} overflow ${overflow.scrollW} > ${overflow.innerW}`
    );
    for (const control of overflow.controls) {
      check(control.visible, `Tasks @${width} control hidden: ${control.name}`);
      check(
        control.x + control.w <= overflow.innerW + 1,
        `Tasks @${width} control offscreen: ${control.name}`
      );
    }
    notes.push(`Tasks @${width} populated toolbar/search/list controls fit`);
  }

  await page.setViewportSize({ width: 375, height: 1000 });
  await page.goto("/today");
  await stillPage(page);
  await runThemeContrastChecks(page, dir, notes);
  await page.evaluate(() => {
    localStorage.setItem("jarvis.theme:v1", "light");
    localStorage.setItem("jarvis.nav:v1", "expanded");
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/today");
  await stillPage(page);
  writeFileSync(
    join(dir, "shell-notes.md"),
    `# R4 shell checks\n\n${notes.map((n) => `- ${n}`).join("\n")}\n`
  );
}

export function runShellMeasurementChecks(): void {
  runMatrixMeasurementChecks();
}

export async function expectAttr(page: Page, mode: string): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelector(".app-frame")?.getAttribute("data-nav") === expected,
    mode,
    { timeout: 10000 }
  );
}
