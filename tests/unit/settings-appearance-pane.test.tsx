import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { AestheticThemeTokens } from "@moss/shared";
import { ColorBox } from "@moss/ui";
import {
  AppearancePane,
  contrastRatio,
  saveThemeDraft,
  slugifyThemeId,
  themeColorError,
  tokensToCssVars
} from "../../apps/web/src/settings/settings-appearance-pane.js";
import { FeedbackProvider } from "../../apps/web/src/settings/settings-feedback.js";
import { PREVIEW_PARTS, ThemePreview } from "../../apps/web/src/settings/settings-theme-preview.js";
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
