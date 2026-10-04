import { describe, expect, it } from "vitest";

import type { AestheticThemeTokens } from "@moss/shared";
import {
  applyThemeTokens,
  type CSSStyleDeclarationLike
} from "../../apps/web/src/theme/theme-runtime.js";

const baseTokens: AestheticThemeTokens = {
  paper: "#ece4d1",
  surface: "#f6f0e1",
  surface2: "#e3dac4",
  surface3: "#d9cfb5",
  ink: "#292621",
  ink2: "#5b564d",
  ink3: "#8b8678",
  ink4: "#9a958a",
  line: "#d5ccb8",
  lineSubtle: "#e0d8c5",
  lineStrong: "#c2b89f",
  accent: "#294b39"
};

describe("custom-theme highlight slot", () => {
  it("applies --gold and a derived gold ramp when provided", () => {
    const style = fakeStyle();
    applyThemeTokens(style, { ...baseTokens, highlight: "#c2872b" });

    expect(style.values.get("--gold")).toBe("#c2872b");
    for (const v of ["--gold-strong", "--gold-soft", "--gold-soft-2", "--gold-ink"]) {
      expect(style.values.get(v), v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("leaves gold vars unset (built-in constant wins) when omitted", () => {
    const style = fakeStyle();
    applyThemeTokens(style, baseTokens);

    expect(style.values.has("--gold")).toBe(false);
  });

  it("clears a previously applied gold ramp", () => {
    const style = fakeStyle();
    applyThemeTokens(style, { ...baseTokens, highlight: "#c2872b" });
    applyThemeTokens(style, null);

    expect(style.values.size).toBe(0);
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
