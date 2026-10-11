import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("packages/ui/src/styles/components-chat.css", "utf8");
const tokens = readFileSync("apps/web/src/styles/tokens.css", "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  ""
);
function declarations(selector: string): Record<string, string> {
  const block = [...tokens.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((rule) =>
    rule[1]?.split(",").some((part) => part.trim() === selector)
  )?.[2];
  if (block === undefined) throw new Error(`Missing token selector ${selector}`);
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()])
  );
}
function color(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new Error(`Missing color ${key}`);
  const alias = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  if (alias) return color(values, alias);
  if (!/^#[\da-f]{6}$/i.test(value)) throw new Error(`Expected opaque color ${key}`);
  return value;
}
function luminance(hex: string): number {
  const components = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return components[0]! * 0.2126 + components[1]! * 0.7152 + components[2]! * 0.0722;
}

describe("approval decision keyboard focus", () => {
  it("uses one solid scoped ring, replacing the halo without touching terminal focus", () => {
    const rule = styles.match(
      /\.action-request-actions > \.jds-btn:focus-visible\s*\{([^}]+)\}/
    )?.[1];
    expect(rule).toContain("outline: var(--space-0-5) solid var(--text)");
    expect(rule).toContain("outline-offset: var(--space-0-5)");
    expect(rule).toContain("box-shadow: none");
    expect(styles).toMatch(
      /\.action-request-outcome\[tabindex="-1"\]:focus\s*\{\s*outline: none;\s*\}/
    );
    const shared = readFileSync("packages/ui/src/styles/components-core.css", "utf8");
    expect(shared).toMatch(/\.jds-btn:focus-visible\s*\{[^}]*var\(--focus-ring\)/);
  });

  for (const theme of ["forest", "sage", "canyon", "teal", "dusk"]) {
    it.each(["light", "dark"])(
      `keeps the ${theme}/%s ring above 3:1 on the card surface`,
      (mode) => {
        const values = {
          ...declarations(":root"),
          ...(mode === "dark" ? declarations('[data-theme="dark"]') : {}),
          ...(theme !== "forest" ? declarations(`[data-theme="${theme}"]`) : {}),
          ...(mode === "dark" && theme !== "forest"
            ? declarations(`[data-color-mode="dark"][data-theme="${theme}"]`)
            : {})
        };
        const [low, high] = [
          luminance(color(values, "--text")),
          luminance(color(values, "--surface"))
        ].sort((a, b) => a - b);
        expect((high! + 0.05) / (low! + 0.05)).toBeGreaterThanOrEqual(3);
      }
    );
  }
});
