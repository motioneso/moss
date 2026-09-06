import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Masthead token readability gate (Park Press slice 1).
 *
 * Parses apps/web/src/styles/tokens.css directly (no DOM), resolves the seven
 * --masthead-* tokens for every theme block the file defines, composites any
 * transparency onto the field, and fails if heading, quieter text or eyebrow
 * read under 4.5:1 on the field. The rule is decorative so no ratio applies.
 *
 * Theme blocks are discovered, not listed: :root, each standalone
 * [data-theme="..."], the dark block, and each dark-plus-theme block. A theme
 * added later is covered without editing this test.
 *
 * Contrast arithmetic mirrors contrastRatio in
 * apps/web/src/settings/settings-appearance-pane.tsx, kept local so this test
 * stays free of React and the DOM (the plan allows either shape).
 */

const cssPath = new URL("../../apps/web/src/styles/tokens.css", import.meta.url);
const css = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Decls = Map<string, string>;

function parseDecls(body: string): Decls {
  const decls: Decls = new Map();
  for (const part of body.split(";")) {
    const m = part.match(/(--[\w-]+)\s*:\s*(.+)/);
    if (m?.[1] && m[2]) decls.set(m[1], m[2].trim());
  }
  return decls;
}

let root: Decls | undefined;
let darkBase: Decls | undefined;
const lightThemes = new Map<string, Decls>();
const darkCombos = new Map<string, Decls>();

const rulePattern = /([^{}@]+)\{([^}]*)\}/g;
let rule: RegExpExecArray | null;
while ((rule = rulePattern.exec(css)) !== null) {
  const selector = rule[1]?.trim() ?? "";
  const body = rule[2] ?? "";
  if (!selector || selector.includes("@")) continue;
  const parts = selector.split(",").map((p) => p.trim());
  if (parts.length === 1 && parts[0] === ":root") {
    // The @media block re-opens :root for durations only; keep the first.
    if (!root) root = parseDecls(body);
    continue;
  }
  if (parts.some((p) => p === '[data-color-mode="dark"]')) {
    darkBase = parseDecls(body);
    continue;
  }
  if (parts.length !== 1) continue;
  const single = parts[0] ?? "";
  const light = /^\[data-theme="([^"]+)"\]$/.exec(single)?.[1];
  if (light) {
    lightThemes.set(light, parseDecls(body));
    continue;
  }
  const combo =
    /^\[data-color-mode="dark"\]\[data-theme="([^"]+)"\]$/.exec(single)?.[1] ??
    /^\[data-theme="([^"]+)"\]\[data-color-mode="dark"\]$/.exec(single)?.[1];
  if (combo) darkCombos.set(combo, parseDecls(body));
}

if (!root) throw new Error("tokens.css: no :root block found");
if (!darkBase) throw new Error("tokens.css: no dark block found");

interface ThemeContext {
  readonly label: string;
  readonly chain: readonly Decls[];
}

const contexts: ThemeContext[] = [{ label: "light, default", chain: [root] }];
for (const name of [...lightThemes.keys()].sort()) {
  contexts.push({ label: `light, ${name}`, chain: [lightThemes.get(name)!, root] });
}
contexts.push({ label: "dark, default", chain: [darkBase, root] });
for (const name of [...darkCombos.keys()].sort()) {
  contexts.push({ label: `dark, ${name}`, chain: [darkCombos.get(name)!, darkBase, root] });
}

function resolveToken(name: string, chain: readonly Decls[], depth = 0): string {
  if (depth > 10) throw new Error(`var chain too deep: ${name}`);
  for (const block of chain) {
    const raw = block.get(name);
    if (raw === undefined) continue;
    const ref = /^\s*var\(\s*(--[\w-]+)\s*\)\s*$/.exec(raw)?.[1];
    return ref ? resolveToken(ref, chain, depth + 1) : raw;
  }
  throw new Error(`token not defined: ${name}`);
}

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function parseColor(value: string): Rgba {
  const text = value.trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(text)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    const n = parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const comma =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([\d.]+))?\s*\)$/.exec(text);
  if (comma) {
    return {
      r: Number(comma[1]),
      g: Number(comma[2]),
      b: Number(comma[3]),
      a: comma[4] === undefined ? 1 : Number(comma[4])
    };
  }
  const spaced = /^rgba?\(\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(
    text
  );
  if (spaced) {
    return {
      r: Number(spaced[1]),
      g: Number(spaced[2]),
      b: Number(spaced[3]),
      a: spaced[4] === undefined ? 1 : Number(spaced[4])
    };
  }
  throw new Error(`unsupported color literal in tokens.css: ${value}`);
}

/** Composite a possibly-transparent foreground onto an opaque field. */
function compositeOn(fg: Rgba, bg: Rgba): [number, number, number] {
  const mix = (f: number, b: number): number => f * fg.a + b * (1 - fg.a);
  return [mix(fg.r, bg.r), mix(fg.g, bg.g), mix(fg.b, bg.b)];
}

function luminance([r, g, b]: readonly [number, number, number]): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Same arithmetic as the appearance pane's contrastRatio. */
function contrastRatio(fg: Rgba, bg: Rgba): number {
  const l1 = luminance(compositeOn(fg, bg));
  const l2 = luminance([bg.r, bg.g, bg.b]);
  return Number(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2));
}

function ratioOf(fgToken: string, ctx: ThemeContext): number {
  const bg = parseColor(resolveToken("--masthead-bg", ctx.chain));
  const fg = parseColor(resolveToken(fgToken, ctx.chain));
  return contrastRatio(fg, bg);
}

describe("masthead tokens stay readable on the field (4.5:1)", () => {
  it("covers every theme block in tokens.css", () => {
    // Guards against the parser silently finding nothing: default light, the
    // four accent themes, dark, and dark combined with a theme at minimum.
    expect(contexts.length).toBeGreaterThanOrEqual(6);
    expect(contexts.some((c) => c.label.startsWith("dark"))).toBe(true);
  });

  for (const ctx of contexts) {
    it(`${ctx.label}: heading, quieter text and eyebrow clear 4.5:1`, () => {
      // All seven names must resolve; only the three text tokens carry a ratio
      // (the rule is decorative, the button pair is not body text).
      for (const name of [
        "--masthead-bg",
        "--masthead-fg",
        "--masthead-fg-muted",
        "--masthead-accent",
        "--masthead-rule",
        "--masthead-action-bg",
        "--masthead-action-fg"
      ]) {
        expect(() => resolveToken(name, ctx.chain), `${ctx.label} ${name} resolves`).not.toThrow();
      }
      expect(ratioOf("--masthead-fg", ctx), `${ctx.label} heading`).toBeGreaterThanOrEqual(4.5);
      expect(
        ratioOf("--masthead-fg-muted", ctx),
        `${ctx.label} quieter text`
      ).toBeGreaterThanOrEqual(4.5);
      expect(ratioOf("--masthead-accent", ctx), `${ctx.label} eyebrow`).toBeGreaterThanOrEqual(4.5);
    });
  }
});
