import { describe, expect, it } from "vitest";

import type { AestheticThemeTokens } from "@moss/shared";
import {
  applyThemeTokens,
  deriveNavColors,
  isSolidThemeColor,
  type CSSStyleDeclarationLike
} from "../../apps/web/src/theme/theme-runtime.js";

const baseTokens: AestheticThemeTokens = {
  paper: "#eef1f4",
  surface: "#f8fafb",
  surface2: "#e9eef3",
  surface3: "#c9d3dd",
  ink: "#1d2733",
  ink2: "#4d5a69",
  ink3: "#6b7684",
  ink4: "#8a94a0",
  line: "#c9d1da",
  lineSubtle: "#dde3ea",
  lineStrong: "#9aa6b3",
  accent: "#2c5d8a"
};

function fakeStyle(): CSSStyleDeclarationLike & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    setProperty: (name, value) => void values.set(name, value),
    removeProperty: (name) => {
      const prior = values.get(name) ?? "";
      values.delete(name);
      return prior;
    },
    getPropertyValue: (name) => values.get(name) ?? ""
  };
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("custom-theme nav color", () => {
  it("keeps nav text and quiet links at 4.5:1 or better on any ground", () => {
    const grounds = ["#1f2c44", "#f1e4b8", "#b8664a", "#777777", "#2c5d8a", "#ffffff", "#000000"];
    for (const ground of grounds) {
      const nav = deriveNavColors(ground, baseTokens.accent);
      expect(nav, ground).not.toBeNull();
      expect(ratio(nav!.vars["--nav-fg"], ground), ground).toBeGreaterThanOrEqual(4.5);
      expect(ratio(nav!.vars["--nav-muted"], ground), ground).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses house ink or bone, and black or white only on middle tones", () => {
    expect(deriveNavColors("#1f2c44", baseTokens.accent)?.vars["--nav-fg"]).toBe("#ede5d2");
    expect(deriveNavColors("#f1e4b8", baseTokens.accent)?.vars["--nav-fg"]).toBe("#282c25");
    const mid = deriveNavColors("#b8664a", baseTokens.accent);
    expect(mid?.strongText).toBe(true);
    expect(mid?.vars["--nav-fg"]).toBe("#000000");
  });

  it("keeps the accent pill only when the accent stands out from the nav", () => {
    const pale = deriveNavColors("#f1e4b8", baseTokens.accent);
    expect(pale?.activeKind).toBe("accent");
    expect(pale?.vars["--nav-active-bg"]).toBe(baseTokens.accent);

    const sameAsAccent = deriveNavColors(baseTokens.accent, baseTokens.accent);
    expect(sameAsAccent?.activeKind).toBe("wash");
    expect(sameAsAccent?.vars["--nav-active-fg"]).toBe(sameAsAccent?.vars["--nav-fg"]);
  });

  it("keeps selected and hover text at 4.5:1 on their own grounds", () => {
    const grounds = ["#1f2c44", "#f1e4b8", "#b8664a", "#777777", "#2c5d8a", "#ffffff", "#000000"];
    const accents = ["#777777", "#ffffff", "#000000", "#2c5d8a", "#e63946", "#f1e4b8"];
    for (const ground of grounds) {
      for (const accent of accents) {
        const vars = deriveNavColors(ground, accent)!.vars;
        const label = `${ground} on ${accent}`;
        expect(
          ratio(vars["--nav-active-fg"], vars["--nav-active-bg"]),
          label
        ).toBeGreaterThanOrEqual(4.5);
        expect(ratio(vars["--nav-fg"], vars["--nav-hover"]), label).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("picks the selected label against the accent pill, not the nav", () => {
    const vars = deriveNavColors("#000000", "#ffffff")!.vars;
    expect(vars["--nav-active-bg"]).toBe("#ffffff");
    expect(vars["--nav-active-fg"]).toBe("#282c25");
  });

  it("accepts opaque rgba nav colors and refuses see-through ones", () => {
    expect(isSolidThemeColor("rgba(0, 0, 0, 1)")).toBe(true);
    expect(isSolidThemeColor("rgb(29, 53, 87)")).toBe(true);
    expect(isSolidThemeColor("rgba(0, 0, 0, 0.5)")).toBe(false);
    expect(deriveNavColors("rgba(0,0,0,1)", baseTokens.accent)?.vars["--nav-bg"]).toBe("#000000");
    expect(deriveNavColors("rgba(0,0,0,0.5)", baseTokens.accent)).toBeNull();

    const style = fakeStyle();
    applyThemeTokens(style, { ...baseTokens, nav: "rgba(0,0,0,1)" });
    expect(style.values.get("--nav-bg")).toBe("#000000");
  });

  it("rejects a ground that is not a color", () => {
    expect(deriveNavColors("navy", baseTokens.accent)).toBeNull();
  });

  it("sets the nav vars only when the theme carries a nav color", () => {
    const style = fakeStyle();
    applyThemeTokens(style, { ...baseTokens, nav: "#1f2c44" });
    expect(style.values.get("--nav-bg")).toBe("#1f2c44");

    applyThemeTokens(style, baseTokens);
    expect(style.values.has("--nav-bg")).toBe(false);
    expect(style.values.has("--nav-fg")).toBe(false);

    applyThemeTokens(style, { ...baseTokens, nav: "#1f2c44" });
    applyThemeTokens(style, null);
    expect(style.values.has("--nav-active-bg")).toBe(false);
  });
});

describe("top bar ground (#3012)", () => {
  it("follows the theme's own paper so a dark-start theme keeps a dark bar under light ink", () => {
    const style = fakeStyle();
    applyThemeTokens(style, { ...baseTokens, paper: "#1c1a16", ink: "#ece7dc" });
    expect(style.values.get("--topbar-bg")).toBe("rgb(28 26 22 / 0.85)");
  });

  it("clears the bar ground when the theme is removed", () => {
    const style = fakeStyle();
    applyThemeTokens(style, baseTokens);
    applyThemeTokens(style, null);
    expect(style.values.has("--topbar-bg")).toBe(false);
  });
});
