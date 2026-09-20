// tests/uat/visual-parity/shell-navigation-theme.ts
//
// Invariant 8: dark/canyon stay token-derived. The app resolves its theme
// through a server query, so storage alone cannot switch it in this seeded
// run; force the app's own data-theme attribute (the same attribute
// app-shell sets from the active theme) after settling, then prove the page
// actually themed (background differs from light) and gate real WCAG ratios:
// Today body + lede, nav labels, the Chat dialog text and the evening save
// dialog text, each >= 4.5. Split out of shell-navigation.ts to stay under
// the repo file-size cap; called once from runShellChecks.

import { join } from "node:path";
import type { Page } from "@playwright/test";

import { check } from "./shell-navigation.js";
import { closeDialogs, ensurePlanning, localDay, localIso, openToday } from "./seed.js";
import { stillPage } from "./capture.js";

function parseRgb(color: string): [number, number, number] {
  const rgb = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (rgb && rgb[1] !== undefined && rgb[2] !== undefined && rgb[3] !== undefined)
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  // Custom properties compute as authored, so a token reads back as #rrggbb.
  const hex = color.match(/^#([0-9a-fA-F]{6})$/);
  if (hex && hex[1] !== undefined) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // Chrome reports computed colors as color(srgb r g b) with 0-1 components.
  const srgb = color.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (srgb && srgb[1] !== undefined && srgb[2] !== undefined && srgb[3] !== undefined)
    return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
  throw new Error(`parity-shell: unparseable color ${color}`);
}

function contrastRatio(fg: string, bg: string): number {
  const lum = (rgb: [number, number, number]): number => {
    const lin = (v: number): number => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  };
  const [l1, l2] = [lum(parseRgb(fg)), lum(parseRgb(bg))];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export async function runThemeContrastChecks(
  page: Page,
  dir: string,
  notes: string[]
): Promise<void> {
  const themeDay = localDay();
  // Faithful forcing: app-shell sets BOTH attrs (dark = theme light + color-mode
  // dark); forcing data-theme alone renders a hybrid that never ships.
  const forceTheme = async (theme: string): Promise<void> => {
    await page.evaluate((t) => {
      localStorage.setItem("jarvis.theme:v1", t);
      localStorage.setItem("jarvis.color-mode:v1", t === "dark" ? "dark" : "light");
      document.documentElement.setAttribute("data-theme", t === "dark" ? "light" : t);
      document.documentElement.setAttribute("data-color-mode", t === "dark" ? "dark" : "light");
    }, theme);
    await page.waitForTimeout(500);
  };
  const samplePair = async (selector: string): Promise<{ fg: string; bg: string }> =>
    page.evaluate((sel) => {
      const pick = (root: ParentNode): Element | null => {
        for (const el of root.querySelectorAll(sel)) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return el;
        }
        return null;
      };
      const el = pick(document) ?? pick(document.querySelector('[role="dialog"]') ?? document);
      if (!el) throw new Error(`parity-shell: no visible ${sel}`);
      const cs = getComputedStyle(el);
      let bg = cs.backgroundColor;
      let host: Element | null = el;
      while ((bg === "rgba(0, 0, 0, 0)" || bg === "transparent") && host?.parentElement) {
        host = host.parentElement;
        bg = getComputedStyle(host).backgroundColor;
      }
      return { fg: cs.color, bg };
    }, selector);
  // Dialog text: every visible text holder with tag/snippet/disabled state;
  // backdrops resolve up the ancestors to the real surface.
  const sampleDialogPairs = async (): Promise<
    Array<{ tag: string; text: string; fg: string; bg: string; disabled: boolean }>
  > =>
    page.evaluate(() => {
      const dlgs = [...document.querySelectorAll('[role="dialog"]')];
      const dlg = dlgs.find((d) => {
        const r = (d as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!dlg) throw new Error("parity-shell: no visible dialog for contrast");
      const out: Array<{ tag: string; text: string; fg: string; bg: string; disabled: boolean }> =
        [];
      for (const tag of ["p", "h1", "h2", "h3", "li", "button", "span"]) {
        for (const el of dlg.querySelectorAll(tag)) {
          const r = (el as HTMLElement).getBoundingClientRect();
          const text = ((el.textContent ?? "").trim().replace(/\s+/g, " ") || "").slice(0, 48);
          if (r.width <= 0 || r.height <= 0 || text === "") continue;
          const cs = getComputedStyle(el);
          let bg = cs.backgroundColor;
          let host: Element | null = el;
          while ((bg === "rgba(0, 0, 0, 0)" || bg === "transparent") && host?.parentElement) {
            host = host.parentElement;
            bg = getComputedStyle(host).backgroundColor;
          }
          const htmlEl = el as HTMLElement;
          out.push({
            tag,
            text,
            fg: cs.color,
            bg,
            disabled: htmlEl.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true"
          });
        }
      }
      // Zero rows is legitimate here (e.g. the chat dialog has no p/h1/h2/h3/li
      // text nodes to gate beyond its composer); callers decide what to do
      // with an empty result, so this does not throw.
      return out;
    });
  // Shared gate for a dialog's body/lede text (p/h1/h2/h3/li, not disabled).
  // Used for both the Chat dialog and the evening-planning dialog below.
  const gateDialogText = async (
    theme: string,
    label: string
  ): Promise<{ minRatio: number; count: number }> => {
    const pairs = await sampleDialogPairs();
    const rows = pairs.map((p) => ({ ...p, ratio: contrastRatio(p.fg, p.bg) }));
    for (const row of rows)
      console.log(
        `[parity-shell] ${theme} ${label} <${row.tag}> "${row.text}" ${row.ratio.toFixed(2)}${row.disabled ? " disabled" : ""}`
      );
    const gated = rows.filter((p) => !p.disabled && ["p", "h1", "h2", "h3", "li"].includes(p.tag));
    return gated.length > 0
      ? { minRatio: Math.min(...gated.map((p) => p.ratio)), count: gated.length }
      : { minRatio: -1, count: 0 };
  };

  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const theme of ["dark", "canyon"]) {
    await page.goto("/today");
    await stillPage(page);
    await openToday(page, new Date(localIso(themeDay, "08:00")));
    await stillPage(page);
    await forceTheme(theme);
    await page.screenshot({ path: join(dir, `p1-1440-${theme}.png`) });
    // Prove the theme actually applied: dark must leave the light paper,
    // while canyon keeps the light paper by design and instead swaps the
    // accent tokens (--forest identifies it: #65b889 dark, #8a4b2b canyon).
    const applied = await page.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      forest: getComputedStyle(document.documentElement).getPropertyValue("--forest").trim()
    }));
    const expectedForest: [number, number, number] =
      theme === "dark" ? [101, 184, 137] : [138, 75, 43];
    const forestRgb = parseRgb(applied.forest);
    const forestDist = Math.max(
      Math.abs(forestRgb[0] - expectedForest[0]),
      Math.abs(forestRgb[1] - expectedForest[1]),
      Math.abs(forestRgb[2] - expectedForest[2])
    );
    console.log(`[parity-shell] ${theme} applied: bg ${applied.bg}, forest ${applied.forest}`);
    check(forestDist <= 12, `${theme} --forest not applied (${applied.forest})`);

    const body = await samplePair("main p");
    const lede = await samplePair(".jds-brief p");
    const navPairs: Array<{ label: string; fg: string; bg: string }> = await page.evaluate(() => {
      const out: Array<{ label: string; fg: string; bg: string }> = [];
      for (const el of document.querySelectorAll(".sidebar .module-link")) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const cs = getComputedStyle(el);
        let bg = cs.backgroundColor;
        let host: Element | null = el;
        while ((bg === "rgba(0, 0, 0, 0)" || bg === "transparent") && host?.parentElement) {
          host = host.parentElement;
          bg = getComputedStyle(host).backgroundColor;
        }
        out.push({
          label: ((el.textContent ?? "").trim().replace(/\s+/g, " ") || "").slice(0, 20),
          fg: cs.color,
          bg
        });
      }
      return out;
    });
    for (const nav of navPairs)
      console.log(
        `[parity-shell] ${theme} nav "${nav.label}" ${contrastRatio(nav.fg, nav.bg).toFixed(2)} (${nav.fg} on ${nav.bg})`
      );
    const bodyRatio = contrastRatio(body.fg, body.bg);
    const ledeRatio = contrastRatio(lede.fg, lede.bg);
    const navRatios = navPairs.map((p) => contrastRatio(p.fg, p.bg));
    check(navRatios.length > 0, `${theme} no nav labels sampled`);
    const navRatio = Math.min(...navRatios);
    console.log(
      `[parity-shell] ${theme} today body ${bodyRatio.toFixed(2)} lede ${ledeRatio.toFixed(2)} nav min ${navRatio.toFixed(2)} over ${navRatios.length} labels`
    );
    check(bodyRatio >= 4.5, `${theme} body contrast ${bodyRatio.toFixed(2)} < 4.5`);
    check(ledeRatio >= 4.5, `${theme} lede contrast ${ledeRatio.toFixed(2)} < 4.5`);
    // Nav labels are normal-size (13px) text, so invariant 8's readability floor
    // is the same 4.5:1 as body/lede text (WCAG AA normal text), not a lower bar.
    check(navRatio >= 4.5, `${theme} nav contrast ${navRatio.toFixed(2)} < 4.5`);
    notes.push(
      `${theme} today body ${bodyRatio.toFixed(2)} lede ${ledeRatio.toFixed(2)} nav min ${navRatio.toFixed(2)} over ${navRatios.length} labels`
    );

    const chatBtn = page
      .locator("header.topbar")
      .getByRole("button", { name: /open chat|chat with/i });
    await chatBtn.click();
    await page.getByRole("button", { name: "Close chat" }).waitFor({ timeout: 10000 });
    await forceTheme(theme);
    await page
      .getByRole("dialog")
      .locator('textarea[aria-label^="Message"]')
      .fill("Contrast probe message");
    await stillPage(page);
    // Spec 8.4: one 1440 capture of the Chat dialog per theme, alongside the Today capture above.
    await page.screenshot({ path: join(dir, `p1-1440-${theme}-chat-dialog.png`) });
    const chatText = await page.evaluate(() => {
      const area = document.querySelector('[role="dialog"] textarea') as HTMLElement | null;
      if (!area) throw new Error("parity-shell: no chat composer for contrast");
      const cs = getComputedStyle(area);
      let bg = cs.backgroundColor;
      const dlg = area.closest('[role="dialog"]');
      if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent")
        bg = dlg ? getComputedStyle(dlg).backgroundColor : bg;
      if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent")
        bg = getComputedStyle(document.body).backgroundColor;
      return { fg: cs.color, bg };
    });
    const chatRatio = contrastRatio(chatText.fg, chatText.bg);
    console.log(
      `[parity-shell] ${theme} chat dialog composer ${chatRatio.toFixed(2)} (${chatText.fg} on ${chatText.bg})`
    );
    check(chatRatio >= 4.5, `${theme} chat dialog composer contrast ${chatRatio.toFixed(2)} < 4.5`);
    // Beyond the composer, the dialog's own body/lede text must also clear the floor.
    const chatGate = await gateDialogText(theme, "chat dialog");
    if (chatGate.count > 0) {
      check(
        chatGate.minRatio >= 4.5,
        `${theme} chat dialog body/lede contrast ${chatGate.minRatio.toFixed(2)} < 4.5`
      );
      notes.push(
        `${theme} chat dialog composer ${chatRatio.toFixed(2)}, body/lede min ${chatGate.minRatio.toFixed(2)} over ${chatGate.count} text nodes`
      );
    } else {
      notes.push(
        `${theme} chat dialog composer ${chatRatio.toFixed(2)}, no body/lede text present to gate`
      );
    }
    await page.getByRole("button", { name: "Close chat" }).click();

    await openToday(page, new Date(localIso(themeDay, "20:00")));
    await stillPage(page);
    await forceTheme(theme);
    await ensurePlanning(page, { w: 1440, h: 1000 }, 2);
    await page.getByRole("dialog").waitFor({ timeout: 30000 });
    await forceTheme(theme);
    await stillPage(page);
    // Spec 8.4: one 1440 capture of the evening-planning dialog per theme.
    await page.screenshot({ path: join(dir, `p1-1440-${theme}-evening-dialog.png`) });
    const eveningGate = await gateDialogText(theme, "evening dialog");
    check(eveningGate.count > 0, `${theme} evening dialog has no gated text`);
    check(
      eveningGate.minRatio >= 4.5,
      `${theme} evening dialog contrast ${eveningGate.minRatio.toFixed(2)} < 4.5`
    );
    notes.push(
      `${theme} evening dialog min ${eveningGate.minRatio.toFixed(2)} over ${eveningGate.count} text nodes`
    );

    await closeDialogs(page).catch(() => undefined);
  }
}
