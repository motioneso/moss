// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomThemeDto, ListThemesResponse } from "@moss/shared";

import { BrandMark } from "../../packages/ui/src/brand-mark.js";
import { LoadingScreen } from "../../apps/web/src/loading-screen.js";
import { isDarkThemeColor } from "../../apps/web/src/theme/theme-runtime.js";
import { resolveShellAppearance } from "../../apps/web/src/shell/shell-appearance.js";
import {
  SHELL_COLOR_MODE_STORAGE_KEY,
  SHELL_PAGE_TONE_STORAGE_KEY,
  SHELL_THEME_STORAGE_KEY,
  saveShellPageTone
} from "../../apps/web/src/shell/theme-storage.js";

const webFile = (path: string) => readFileSync(`apps/web/${path}`, "utf8");

const bootThemeSource = webFile("public/boot-theme.js");
const indexHtml = webFile("index.html");
const bootCss = webFile("src/styles/boot.css");
const tokensCss = webFile("src/styles/tokens.css");

function runBootTheme(options: { readonly systemDark: boolean }) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: query === "(prefers-color-scheme: dark)" && options.systemDark
  })) as unknown as typeof window.matchMedia;
  new Function(bootThemeSource)();
  const root = document.documentElement;
  return { mode: root.getAttribute("data-color-mode"), theme: root.getAttribute("data-theme") };
}

function rectAttributes(markup: string): string[][] {
  return [...markup.matchAll(/<rect\b([^>]*?)\/?>/g)].map((match) =>
    [...match[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => `${name}=${value}`)
  );
}

describe("pre-script loading screen theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-color-mode");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the same browser keys the app shell saves", () => {
    expect(bootThemeSource).toContain(`"${SHELL_THEME_STORAGE_KEY}"`);
    expect(bootThemeSource).toContain(`"${SHELL_COLOR_MODE_STORAGE_KEY}"`);
    expect(bootThemeSource).toContain(`"${SHELL_PAGE_TONE_STORAGE_KEY}"`);
  });

  it("honours a saved light choice even when the system is dark", () => {
    localStorage.setItem(SHELL_COLOR_MODE_STORAGE_KEY, "light");
    expect(runBootTheme({ systemDark: true }).mode).toBe("light");
  });

  it("honours a saved dark choice even when the system is light", () => {
    localStorage.setItem(SHELL_COLOR_MODE_STORAGE_KEY, "dark");
    expect(runBootTheme({ systemDark: false }).mode).toBe("dark");
  });

  it("follows the system when nothing is saved", () => {
    expect(runBootTheme({ systemDark: true }).mode).toBe("dark");
    expect(runBootTheme({ systemDark: false }).mode).toBe("light");
  });

  it("treats the legacy Dark theme as dark mode on the light palette", () => {
    localStorage.setItem(SHELL_THEME_STORAGE_KEY, "dark");
    expect(runBootTheme({ systemDark: false })).toEqual({ mode: "dark", theme: "light" });
  });

  it("goes dark for a dark custom theme, whose saved color mode is always light", () => {
    localStorage.setItem(SHELL_THEME_STORAGE_KEY, "my-night");
    localStorage.setItem(SHELL_COLOR_MODE_STORAGE_KEY, "light");
    saveShellPageTone(isDarkThemeColor("#14161a") ? "dark" : "light");
    expect(runBootTheme({ systemDark: false })).toEqual({ mode: "dark", theme: "my-night" });
  });

  it("stays light for a light custom theme even when the system is dark", () => {
    localStorage.setItem(SHELL_THEME_STORAGE_KEY, "my-day");
    localStorage.setItem(SHELL_COLOR_MODE_STORAGE_KEY, "light");
    saveShellPageTone(isDarkThemeColor("rgb(250, 248, 240)") ? "dark" : "light");
    expect(runBootTheme({ systemDark: true }).mode).toBe("light");
  });

  it("keeps a saved palette theme", () => {
    localStorage.setItem(SHELL_THEME_STORAGE_KEY, "sage");
    localStorage.setItem(SHELL_COLOR_MODE_STORAGE_KEY, "dark");
    expect(runBootTheme({ systemDark: false })).toEqual({ mode: "dark", theme: "sage" });
  });

  it("falls back to the system when browser storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(runBootTheme({ systemDark: true })).toEqual({ mode: "dark", theme: "light" });
  });

  it("is loaded from the site in the head, before the page body paints", () => {
    const head = indexHtml.slice(0, indexHtml.indexOf("<body>"));
    expect(head).toContain('<script src="/boot-theme.js"></script>');
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it("colours the address bar with the page background for the chosen mode", () => {
    const rules = [...tokensCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const paper = (selector: string) => {
      const block = rules.find((rule) =>
        rule[1]!.split(",").some((item) => item.trim() === selector)
      )?.[2];
      const value = block?.match(/--paper: (#[0-9a-f]{6});/)?.[1];
      expect(value, `paper declared for ${selector}`).toBeDefined();
      return value!;
    };
    const lightPaper = paper(":root");
    const darkPaper = paper('[data-color-mode="dark"]');
    const meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);

    localStorage.setItem(SHELL_COLOR_MODE_STORAGE_KEY, "dark");
    runBootTheme({ systemDark: false });
    expect(meta.content).toBe(darkPaper);

    localStorage.setItem(SHELL_COLOR_MODE_STORAGE_KEY, "light");
    runBootTheme({ systemDark: true });
    expect(meta.content).toBe(lightPaper);
    expect(indexHtml).toContain(`<meta name="theme-color" content="${lightPaper}" />`);
    meta.remove();
  });
});

describe("loading screen logo mark", () => {
  const brandRects = rectAttributes(renderToStaticMarkup(createElement(BrandMark)));

  it("shows the Moss mark on the pre-script screen, matching BrandMark", () => {
    const mark = indexHtml.slice(
      indexHtml.indexOf('<span class="loading-mark">'),
      indexHtml.indexOf("</span>")
    );
    expect(brandRects).toHaveLength(3);
    expect(rectAttributes(mark)).toEqual(brandRects);
    expect(indexHtml).toContain('<p id="boot-loading" role="status">Loading Moss</p>');
  });

  it("shows the same mark on the in-app loading screen", () => {
    const html = renderToStaticMarkup(createElement(LoadingScreen));
    expect(html).toContain('<span class="loading-mark">');
    expect(rectAttributes(html)).toEqual(brandRects);
    expect(html).toContain('<p role="status">Loading Moss</p>');
  });

  it("animates the mark's bars instead of spinning a bordered circle", () => {
    const rule = bootCss.slice(bootCss.indexOf(".loading-mark {"), bootCss.indexOf("@keyframes"));
    expect(rule).not.toMatch(/border|rotate|\bspin\b/);
    expect(rule).toMatch(/\.loading-mark rect \{[^}]*animation: loading-mark-bar/);
    expect(bootCss).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*\.loading-mark rect \{\s*animation: none/
    );
  });
});

describe("shell appearance once the theme list loads", () => {
  const customTheme = (id: string, paper: string) =>
    ({ id, name: id, builtIn: false, tokens: { paper } }) as unknown as CustomThemeDto;
  const themes = (overrides: Partial<ListThemesResponse>): ListThemesResponse => ({
    builtIn: [],
    custom: [],
    activeId: "light",
    mode: "light",
    ...overrides
  });

  it("saves a dark page tone for a dark custom theme, which renders on the light base", () => {
    const appearance = resolveShellAppearance(
      themes({ activeId: "my-night", custom: [customTheme("my-night", "#14161a")] })
    );
    expect(appearance).toMatchObject({
      dataTheme: "my-night",
      colorMode: "light",
      pageTone: "dark"
    });
    expect(appearance.tokens).not.toBeNull();
  });

  it("saves a light page tone for a light custom theme even in dark mode", () => {
    const appearance = resolveShellAppearance(
      themes({ activeId: "my-day", mode: "dark", custom: [customTheme("my-day", "#faf8f0")] })
    );
    expect(appearance).toMatchObject({ colorMode: "light", pageTone: "light" });
  });

  it("follows the chosen mode for built-in palettes", () => {
    expect(resolveShellAppearance(themes({ activeId: "sage", mode: "dark" }))).toMatchObject({
      dataTheme: "sage",
      colorMode: "dark",
      pageTone: "dark",
      tokens: null
    });
  });

  it("maps the legacy Dark theme to the light palette", () => {
    expect(resolveShellAppearance(themes({ activeId: "dark", mode: "dark" }))).toMatchObject({
      themeId: "dark",
      dataTheme: "light",
      pageTone: "dark"
    });
  });
});
