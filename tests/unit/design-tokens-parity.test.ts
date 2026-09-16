import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// VP-P0: light-theme tokens resolve to the study values (spec invariant 6).
// Only the :root block is read, so themed overrides cannot satisfy this.
const EXPECTED: Readonly<Record<string, string>> = {
  "--surface": "#faf8f1",
  "--forest-hover": "#345942",
  "--forest-deep": "#1d382b",
  "--ink": "#282c25",
  "--muted": "#676c60",
  "--line": "#c6cbbc",
  "--line-strong": "#9ba591",
  "--sage": "#dce3d6",
  "--sage-light": "#e7ebdf",
  "--gold-light": "#e9bd69",
  "--focus": "#805316",
  "--shadow": "0 12px 44px rgb(18 31 24 / 0.18)"
};

function lightTokens(): Map<string, string> {
  const source = readFileSync(
    join(__dirname, "..", "..", "apps", "web", "src", "styles", "tokens.css"),
    "utf8"
  );
  const root = source.slice(0, source.indexOf('[data-theme="dark"]'));
  const found = new Map<string, string>();
  for (const match of root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    found.set(match[1]!, match[2]!.split("/*")[0]!.trim());
  }
  return found;
}

function resolveToken(tokens: Map<string, string>, name: string, seen = new Set<string>()): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`missing token ${name}`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  if (!alias) return value;
  if (seen.has(name)) throw new Error(`cyclic token alias ${name}`);
  seen.add(name);
  return resolveToken(tokens, alias[1]!, seen);
}

describe("design tokens parity", () => {
  it("resolves the study values in the light theme", () => {
    const tokens = lightTokens();
    for (const [name, value] of Object.entries(EXPECTED)) {
      expect(resolveToken(tokens, name), name).toBe(value);
    }
  });
});
