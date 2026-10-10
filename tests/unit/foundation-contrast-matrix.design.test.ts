import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const read = (path: string) =>
  readFileSync(new URL(path, root), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const css = read("apps/web/src/styles/tokens.css");
const themes = ["forest", "sage", "canyon", "teal", "dusk"];
type Color = [number, number, number];
function themeTokens(theme: string, dark: boolean) {
  const selectors = new Set([":root", `[data-theme="${theme}"]`]);
  if (dark) {
    selectors.add('[data-theme="dark"]');
    selectors.add('[data-color-mode="dark"]');
    selectors.add(`[data-color-mode="dark"][data-theme="${theme}"]`);
  }
  const tokens = new Map<string, string>();
  for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!block[1]?.split(",").some((selector) => selectors.has(selector.trim()))) continue;
    for (const declaration of block[2]?.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g) ?? []) {
      tokens.set(declaration[1]!, declaration[2]!.trim());
    }
  }
  return tokens;
}
function resolve(tokens: Map<string, string>, name: string, depth = 0): string {
  if (depth > 12) throw new Error(`Circular token ${name}`);
  const value = tokens.get(name);
  if (!value) throw new Error(`Missing token ${name}`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  return ref ? resolve(tokens, ref, depth + 1) : value;
}
function linear(value: number) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function color(value: string): Color {
  const hex = /^#([\da-f]{6})$/i.exec(value)?.[1];
  if (hex)
    return [0, 2, 4].map((index) =>
      linear(parseInt(hex.slice(index, index + 2), 16) / 255)
    ) as Color;
  const lch = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (lch) {
    const l = Number(lch[1]);
    const c = Number(lch[2]);
    const h = (Number(lch[3]) * Math.PI) / 180;
    const a = c * Math.cos(h);
    const b = c * Math.sin(h);
    const ll = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const mm = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const ss = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
      4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
      -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
      -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss
    ].map((v) => Math.max(0, Math.min(1, v))) as Color;
  }
  throw new Error(`Unsupported color ${value}`);
}
function ratio(fg: string, bg: string) {
  const luminance = (value: string) =>
    color(value).reduce(
      (sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!,
      0
    );
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const selectors = [
  ["packages/ui/src/styles/components-core.css", ".jds-eyebrow--muted"],
  ["packages/ui/src/styles/components-keyline.css", ".jds-instrument__label"],
  ...[
    ".jds-masthead__lede",
    ".jds-masthead__dateline",
    ".jds-agenda-row__time",
    ".jds-agenda-row__sub"
  ].map((selector) => ["packages/ui/src/styles/components-moss-today.css", selector])
];

describe("shared selector and ground contracts", () => {
  for (const [file, selector] of selectors) {
    it(`${selector} uses the semantic faint text role`, () => {
      const escaped = selector!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rule = Array.from(
        read(file!).matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "g"))
      )
        .map((match) => match[1])
        .filter((body) => body?.includes("color:"))
        .at(-1);
      expect(rule).toContain("color: var(--text-faint)");
    });
  }
  for (const theme of themes)
    for (const dark of [false, true]) {
      it(`${theme}/${dark ? "dark" : "light"} readable text, field eyebrow and focus grounds`, () => {
        const tokens = themeTokens(theme, dark);
        for (const ground of ["--paper", "--surface", "--surface-2"]) {
          expect(
            ratio(resolve(tokens, "--text-faint"), resolve(tokens, ground)),
            `text-faint/${ground}`
          ).toBeGreaterThanOrEqual(4.5);
        }
        for (const ground of ["--paper", "--surface", "--surface-2", "--surface-3"]) {
          expect(
            ratio(resolve(tokens, "--focus-ring"), resolve(tokens, ground)),
            `focus/${ground}`
          ).toBeGreaterThanOrEqual(3);
        }
        expect(
          ratio(resolve(tokens, "--hero-fg"), resolve(tokens, "--accent"))
        ).toBeGreaterThanOrEqual(4.5);
        // This matrix intentionally does not promise faint text over light surface-3 or arbitrary custom palettes.
        for (const family of [
          "happy",
          "sad",
          "fear",
          "anger",
          "disgust",
          "surprise",
          ...Array.from({ length: 7 }, (_, i) => `med-${i + 1}`)
        ]) {
          for (const ground of ["soft", "soft2"])
            expect(
              ratio(
                resolve(tokens, `--wellness-${family}-ink`),
                resolve(tokens, `--wellness-${family}-${ground}`)
              ),
              `${family} ink/${ground}`
            ).toBeGreaterThanOrEqual(4.5);
          expect(
            ratio(
              resolve(tokens, `--wellness-${family}-on-tint`),
              resolve(tokens, `--wellness-${family}-tint`)
            ),
            `${family} on-tint/tint`
          ).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  it("keeps shared measured text at the 11px floor and uses motion tokens", () => {
    expect(read("packages/ui/src/styles/components-keyline.css")).toContain(
      "font-size: var(--text-2xs)"
    );
    for (const file of [
      "packages/ui/src/styles/components-moss-today.css",
      "packages/ui/src/styles/components-moss.css",
      "apps/web/src/styles.css"
    ]) {
      expect(read(file)).not.toMatch(/font-size:\s*(?:[0-9](?:\.\d+)?|10(?:\.\d+)?)px\s*;/);
    }
    expect(read("packages/ui/src/styles/components-moss-today.css")).toContain(
      "transition: box-shadow var(--dur-fast) var(--ease-out)"
    );
    expect(css).not.toMatch(/--shadow-(?:xs|sm):[^;]*(?:rgba|rgb)\(/);
  });
  it("reuses every root token block inside an opt-in isolated theme scope", () => {
    const rootBlocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((block) =>
      block[1]?.split(",").some((selector) => selector.trim() === ":root")
    );
    expect(rootBlocks).toHaveLength(3);
    for (const block of rootBlocks) {
      expect(block[1]?.split(",").map((selector) => selector.trim())).toContain(".jds-theme-scope");
    }
    // Re-declaring aliases locally makes the browser resolve draft inputs on that node,
    // rather than inheriting a previously resolved alias from an outer dark theme.
    expect(rootBlocks[0]?.[2]).toContain("--text: var(--ink)");
    expect(rootBlocks[0]?.[2]).toContain("--text-faint: #6a6350");
    expect(rootBlocks[0]?.[2]).toContain("--text-on-accent: #ffffff");
    expect(rootBlocks[0]?.[2]).toContain("--accent-fg: var(--forest)");
    expect(rootBlocks[2]?.[2]).toContain("--dur-fast: 0ms");
  });
  it("retains selected-chip emphasis after the chip base rule", () => {
    const rules = read("packages/ui/src/styles/components-sections.css");
    const active = rules.match(/\.jds-btn--chip\.jds-btn--active\s*\{([^}]*)\}/)?.[1];
    expect(active).toContain("background: var(--accent-soft)");
    expect(active).toContain("color: var(--accent-soft-fg)");
  });
  it("lets complex title slots fill the header and retains settings error emphasis", () => {
    const title = read("packages/ui/src/styles/components-moss.css").match(
      /\.jds-dialog__title\s*\{([^}]*)\}/
    )?.[1];
    expect(title).toContain("flex: 1");
    expect(title).toContain("min-width: 0");
    expect(read("packages/ui/src/styles/components-forms.css")).toMatch(
      /\.jds-hint\.jds-hint--error\s*\{\s*color:\s*var\(--danger-fg\)/
    );
  });
});
