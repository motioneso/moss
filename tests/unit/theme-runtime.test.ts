import { describe, expect, it } from "vitest";

import type { AestheticThemeTokens } from "@moss/shared";
import {
  applyThemeTokens,
  deriveAccentRamp,
  isThemeColor,
  parsePalette,
  type CSSStyleDeclarationLike
} from "../../apps/web/src/theme/theme-runtime.js";

const validThemeTokens: AestheticThemeTokens = {
  paper: "#fbfaf6",
  surface: "#ffffff",
  surface2: "#f5f3ed",
  surface3: "#edeae1",
  ink: "#292621",
  ink2: "#5b564d",
  ink3: "#8b8678",
  ink4: "#9a958a",
  line: "rgb(38, 34, 28)",
  lineSubtle: "rgb(245, 243, 237)",
  lineStrong: "rgb(210, 205, 194)",
  accent: "#2f6a4c"
};

describe("theme runtime", () => {
  it("parses Coolors arrays and whitespace-separated hex values", () => {
    expect(parsePalette('["#f4f1de","#e07a5f"] #3d405b\n#81b29a')).toEqual([
      "#f4f1de",
      "#e07a5f",
      "#3d405b",
      "#81b29a"
    ]);
  });

  it("validates hex, rgb, and rgba color values", () => {
    expect(isThemeColor("#f4f1de")).toBe(true);
    expect(isThemeColor("rgb(244, 241, 222)")).toBe(true);
    expect(isThemeColor("rgba(244, 241, 222, 0.5)")).toBe(true);
    expect(isThemeColor("url(javascript:alert(1))")).toBe(false);
  });

  it("applies aesthetic tokens and generated accent vars only", () => {
    const style = fakeStyle();
    applyThemeTokens(style, { ...validThemeTokens, red: "#000000" } as AestheticThemeTokens);

    expect(style.values.get("--paper")).toBe(validThemeTokens.paper);
    expect(style.values.get("--accent")).toBe(validThemeTokens.accent);
    expect(style.values.get("--accent-hover")).toBe(
      deriveAccentRamp(validThemeTokens.accent, validThemeTokens.paper)["--accent-hover"]
    );
    expect(style.values.has("--red")).toBe(false);
  });

  it("clears runtime theme overrides", () => {
    const style = fakeStyle();
    applyThemeTokens(style, validThemeTokens);
    applyThemeTokens(style, null);

    expect(style.values.size).toBe(0);
  });

  it("mixes accent softs toward --paper, not pure white, so custom themes match the oat-tinted built-in softs (#787)", () => {
    const oatPaper = "#ece4d1"; // Park Press built-in oat ground
    const ramp = deriveAccentRamp("#294b39", oatPaper); // built-in forest accent

    // Oat-mixed softs land close to tokens.css's hand-tuned --forest-soft/-2
    // (#dbe2d3 / #c9d5c0); a pure-white mix would instead be #e1e6e3 / #ccd4cf.
    expect(ramp["--accent-soft"]).toBe("#d1cfbc");
    expect(ramp["--accent-soft-2"]).toBe("#bdbfad");
  });

  it("falls back to a white mix when --paper isn't a parseable theme color", () => {
    const ramp = deriveAccentRamp("#294b39", "not-a-color");
    expect(ramp["--accent-soft"]).toBe("#e1e6e3");
    expect(ramp["--accent-soft-2"]).toBe("#ccd4cf");
  });
});

function fakeStyle(): CSSStyleDeclarationLike & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    setProperty: (name, value) => values.set(name, value),
    removeProperty: (name) => {
      values.delete(name);
      return "";
    },
    getPropertyValue: (name) => values.get(name) ?? ""
  };
}
