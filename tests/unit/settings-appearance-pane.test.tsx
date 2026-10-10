// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import type { AestheticThemeTokens } from "@moss/shared";
import { ColorBox } from "@moss/ui";
import {
  AppearancePane,
  contrastRatio,
  saveThemeDraft,
  slugifyThemeId,
  themeColorError,
  tokensToCssVars,
  readBuiltInTokens
} from "../../apps/web/src/settings/settings-appearance-pane.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";
import {
  PREVIEW_PARTS,
  ThemePreview,
  ThemeReadability,
  ReadabilityList,
  THEME_READABILITY_PAIRS,
  readRenderedThemeChecks,
  readabilityContrastRatio
} from "../../apps/web/src/settings/settings-theme-preview.js";
import { parsePalette } from "../../apps/web/src/theme/theme-runtime.js";

function renderAppearancePane(): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToString(
    createElement(
      FeedbackProvider,
      null,
      createElement(QueryClientProvider, { client }, createElement(AppearancePane))
    )
  );
}

const tokens: AestheticThemeTokens = {
  paper: "#ffffff",
  surface: "#ffffff",
  surface2: "#f5f3ed",
  surface3: "#edeae1",
  ink: "#000000",
  ink2: "#5b564d",
  ink3: "#8b8678",
  ink4: "#9a958a",
  line: "rgb(38, 34, 28)",
  lineSubtle: "rgb(245, 243, 237)",
  lineStrong: "rgb(210, 205, 194)",
  accent: "#2f6a4c"
};

describe("parsePalette (auto-staging)", () => {
  it("extracts hex colors from a Coolors export", () => {
    const coolors = "#541388 / #F038FF / #EF709D / #E9DC3F / #38A3A5";
    expect(parsePalette(coolors)).toEqual(["#541388", "#F038FF", "#EF709D", "#E9DC3F", "#38A3A5"]);
  });

  it("extracts rgb() colors", () => {
    expect(parsePalette("rgb(84, 19, 136), rgb(255, 0, 128)")).toEqual([
      "rgb(84, 19, 136)",
      "rgb(255, 0, 128)"
    ]);
  });

  it("deduplicates repeated colors", () => {
    expect(parsePalette("#aabbcc #aabbcc #ddeeff")).toEqual(["#aabbcc", "#ddeeff"]);
  });

  it("returns empty array for text with no valid colors", () => {
    expect(parsePalette("no colors here")).toEqual([]);
    expect(parsePalette("")).toEqual([]);
  });
});

describe("ColorBox", () => {
  const box = (open: boolean, palette: string[]) =>
    renderToString(
      createElement(ColorBox, {
        label: "Accent",
        value: "#2C5D8A",
        palette,
        open,
        onOpenChange: () => undefined,
        onChange: () => undefined
      })
    );

  it("fills the whole box with the color and keeps the picker closed", () => {
    const html = box(false, ["#2c5d8a"]);
    expect(html).toContain("--jds-colorbox:#2C5D8A");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("From your palette");
  });

  it("opens with the pasted palette on top and marks the current color", () => {
    const html = box(true, ["#2c5d8a", "#d39b3c"]);
    expect(html).toContain("From your palette");
    expect(html).toContain('aria-label="Use #2c5d8a" aria-pressed="true"');
    expect(html).toContain('aria-label="Use #d39b3c" aria-pressed="false"');
    expect(html).toContain("Any color");
  });

  it("asks for a palette when none was pasted", () => {
    expect(box(true, [])).toContain("Paste a palette and its colors show here.");
  });
});

describe("ThemePreview", () => {
  it("says the preview is clickable and marks every part with its field", () => {
    const html = renderToString(
      createElement(ThemePreview, { style: {}, openPart: "rule", onPick: () => undefined })
    );
    expect(html).toContain("Click any part to change its color.");
    for (const part of Object.keys(PREVIEW_PARTS)) {
      expect(html).toContain(`data-part="${part}"`);
    }
    expect(html).toContain('class="theme-pv__rule is-open"');
    expect(PREVIEW_PARTS.rule.key).toBe("highlight");
    expect(PREVIEW_PARTS.nav.key).toBe("nav");
  });
});

describe("AppearancePane — editor visibility", () => {
  it("keeps the editor hidden until the user starts a theme", () => {
    const html = renderAppearancePane();
    expect(html).toContain("New theme");
    expect(html).toContain("Color mode");
    expect(html).toContain("theme-gallery");
    expect(html).not.toContain("theme-editor");
    expect(html).not.toContain("Save theme");
    expect(html).not.toContain("Cancel");
  });
});

describe("appearance pane helpers", () => {
  it("saves and activates the custom theme draft", async () => {
    const calls: string[] = [];
    const response = await saveThemeDraft(
      { id: "my-blue", name: "My Blue", tokens },
      {
        putCustomTheme: async (id, body) => {
          calls.push(`put:${id}:${body.name}`);
          return { theme: { id, name: body.name ?? "", builtIn: false, tokens } };
        },
        setActiveTheme: async (body) => {
          calls.push(`active:${body.id}`);
          return { builtIn: [], custom: [], activeId: body.id, mode: "light" as const };
        }
      }
    );

    expect(response.theme.id).toBe("my-blue");
    expect(calls).toEqual(["put:my-blue:My Blue", "active:my-blue"]);
  });

  it("refuses a see-through nav color but allows one elsewhere", () => {
    expect(themeColorError("nav", "rgba(0, 0, 0, 0.5)")).toMatch(/solid color/);
    expect(themeColorError("nav", "rgba(0, 0, 0, 1)")).toBeNull();
    expect(themeColorError("accent", "rgba(0, 0, 0, 0.5)")).toBeNull();
    expect(themeColorError("nav", "navy")).toMatch(/#rrggbb/);
  });

  it("slugifies theme names into route-safe ids", () => {
    expect(slugifyThemeId(" Coolors Sunset! ")).toBe("coolors-sunset");
    expect(slugifyThemeId("!!!")).toMatch(/^theme-/);
  });

  it("computes WCAG contrast ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
  });

  it("projects only aesthetic CSS vars", () => {
    const css = tokensToCssVars({ ...tokens, red: "#000000" } as AestheticThemeTokens);

    expect(css["--paper"]).toBe("#ffffff");
    expect(css["--accent"]).toBe("#2f6a4c");
    expect(css["--red"]).toBeUndefined();
  });
});

describe("page header editing (#3019)", () => {
  it("lists the header as a clickable preview part and rejects non-solid values", () => {
    expect(PREVIEW_PARTS.header.key).toBe("header");
    expect(themeColorError("header", "#1c1a16")).toBeNull();
    expect(themeColorError("header", "rgba(28, 26, 22, 0.5)")).not.toBeNull();
  });

  it("gives a draft with no header value no header vars, as after Reset to default", () => {
    const withHeader = tokensToCssVars({ ...tokens, header: "#1c1a16" });
    expect(withHeader["--header-bg"]).toBeDefined();
    const { header: _dropped, ...reset } = { ...tokens, header: "#1c1a16" };
    expect(Object.keys(tokensToCssVars(reset)).some((name) => name.startsWith("--header-"))).toBe(
      false
    );
  });

  it("clears the applied theme's header vars on the preview so a reset draft shows its own page color", () => {
    const css = readFileSync("packages/ui/src/styles/components-theme-editor.css", "utf8");
    const block = /\.theme-pv,[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    for (const name of ["bg", "fg", "muted", "line", "hover"]) {
      expect(block).toContain(`--header-${name}: initial;`);
    }
  });
});

describe("semantic theme readability", () => {
  it("samples exact semantic foregrounds and grounds in an isolated custom light base", () => {
    const html = renderToString(
      createElement(ThemeReadability, { themeId: "draft-test", style: tokensToCssVars(tokens) })
    );
    expect(html).toContain('class="theme-readability-samples jds-theme-scope"');
    expect(html).toContain('data-color-mode="light"');
    expect(html).toContain('data-theme="draft-test"');
    expect(html).toContain('aria-hidden="true"');
    for (const pair of THEME_READABILITY_PAIRS) {
      expect(html).toContain(`data-theme-contrast-sample="${pair.id}"`);
      expect(html).toContain(
        `color:var(${pair.foreground});background-color:var(${pair.background})`
      );
    }
    expect(THEME_READABILITY_PAIRS.find((pair) => pair.id === "faint-page")).toMatchObject({
      foreground: "--text-faint",
      background: "--paper"
    });
    expect(THEME_READABILITY_PAIRS.find((pair) => pair.id === "primary-label")).toMatchObject({
      foreground: "--text-on-accent",
      background: "--btn-primary-bg"
    });
  });

  // jsdom does not resolve inherited CSS variables. These fixtures exercise the
  // browser-computed-color boundary; real cascade/outer-dark isolation is browser QA.
  it.each([
    { name: "Forest light", foreground: "rgb(106, 99, 80)", background: "rgb(242, 238, 228)" },
    { name: "Forest dark", foreground: "rgb(154, 149, 137)", background: "rgb(50, 46, 37)" },
    {
      name: "custom dark paper on light semantic base",
      foreground: "rgb(106, 99, 80)",
      background: "rgb(28, 26, 22)"
    }
  ])("reports the returned rendered pair for $name", ({ foreground, background }) => {
    const root = document.createElement("div");
    root.innerHTML = THEME_READABILITY_PAIRS.map(
      (pair) => `<span data-theme-contrast-sample="${pair.id}"></span>`
    ).join("");
    const readStyle = vi.fn(() => ({ color: foreground, backgroundColor: background }));
    const checks = readRenderedThemeChecks(root, readStyle);
    expect(readStyle).toHaveBeenCalledTimes(THEME_READABILITY_PAIRS.length);
    const ratio = readabilityContrastRatio(foreground, background)!;
    expect(
      checks.every(
        (check) =>
          check.foreground === foreground &&
          check.background === background &&
          check.ratio === ratio
      )
    ).toBe(true);
    const html = renderToString(createElement(ReadabilityList, { checks }));
    expect(html).toContain(`data-foreground="${foreground}"`);
    expect(html).toContain(`data-background="${background}"`);
    expect(html).toContain(`${ratio.toFixed(2)} to 1`);
    expect(html).toContain("do not cover");
    expect(html).toContain("Warnings do not block saving");
    if (ratio < 4.5) expect(html).toContain("You can still save this palette.");
  });

  it("does not invent passing contrast for transparent or unsupported colors", () => {
    expect(readabilityContrastRatio("rgba(255, 255, 255, 0.5)", "#000000")).toBeNull();
    expect(readabilityContrastRatio("#ffffff", "rgba(0, 0, 0, 0.5)")).toBeNull();
    expect(readabilityContrastRatio("var(--text)", "#ffffff")).toBeNull();
    expect(readabilityContrastRatio("color(srgb 1 1 1)", "color(srgb 0 0 0)")).toBe(21);
    const html = renderToString(
      createElement(ReadabilityList, {
        checks: [
          {
            id: "unsupported",
            label: "Unmeasured sample",
            foreground: "var(--text)",
            background: "#ffffff",
            ratio: null,
            floor: 4.5
          }
        ]
      })
    );
    expect(html).toContain("Not measured");
    expect(html).toContain("could not be measured reliably");
    expect(html).not.toContain("Meets 4.5");
  });

  it("keeps low-contrast palette saving unchanged", async () => {
    const low = { ...tokens, ink: tokens.paper, accent: tokens.paper };
    const put = vi.fn(async (id: string, body: { name?: string }) => ({
      theme: { id, name: body.name ?? "", builtIn: false, tokens: low }
    }));
    const activate = vi.fn(async (body: { id: string }) => ({
      builtIn: [],
      custom: [],
      activeId: body.id,
      mode: "light" as const
    }));
    await saveThemeDraft(
      { id: "low-contrast", name: "My palette", tokens: low },
      {
        putCustomTheme: put,
        setActiveTheme: activate
      }
    );
    expect(put).toHaveBeenCalledWith("low-contrast", { name: "My palette", tokens: low });
    expect(activate).toHaveBeenCalledWith({ id: "low-contrast" });
  });
});

describe("built-in palette probe isolation", () => {
  it.each(["light", "dark"] as const)("uses an explicit %s scope and removes the probe", (mode) => {
    const original = window.getComputedStyle.bind(window);
    const measure = vi.spyOn(window, "getComputedStyle").mockImplementation((node) => {
      expect(node.classList.contains("jds-theme-scope")).toBe(true);
      expect(node.getAttribute("data-theme")).toBe("teal");
      expect(node.getAttribute("data-color-mode")).toBe(mode);
      expect(node.isConnected).toBe(true);
      return original(node);
    });
    try {
      readBuiltInTokens("teal", mode);
      expect(measure).toHaveBeenCalledOnce();
      expect(document.querySelector(".jds-theme-scope")).toBeNull();
    } finally {
      measure.mockRestore();
    }
  });
});
