import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * #1970 — the medication builder form previews a schedule in the browser by importing
 * `@moss/wellness/schedule-summary` directly, so the summary sentence and the next three doses
 * come from the same source file the server uses and can never drift from it.
 *
 * That only works while every file reachable from `schedule-summary.ts` stays free of Node
 * built-ins and never reaches the wellness package index, whose manifest pulls `node:url`
 * (see the note at packages/shared/src/wellness-api.ts:834). A regression here breaks the web
 * bundle at build time with an opaque error rather than failing a typecheck, so it is asserted
 * on its own.
 */

const WELLNESS_SRC = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/wellness/src"
);

const ENTRY = resolve(WELLNESS_SRC, "schedule-summary.ts");

/** Every `from "..."` specifier in `source`, paired with whether it is a type-only import. */
function importsOf(source: string): { specifier: string; typeOnly: boolean }[] {
  const found: { specifier: string; typeOnly: boolean }[] = [];
  const pattern = /import\s+(type\s+)?([\s\S]*?)\bfrom\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const clause = match[2] ?? "";
    // `import type { X }` and `import { type X, type Y }` are both erased at build time.
    const namedNames = clause.match(/\{([\s\S]*)\}/)?.[1];
    const everyNameIsTypeOnly =
      namedNames !== undefined &&
      namedNames
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
        .every((n) => n.startsWith("type "));
    found.push({
      specifier: match[3] ?? "",
      typeOnly: match[1] !== undefined || everyNameIsTypeOnly
    });
  }
  return found;
}

/** Every wellness source file the browser would pull in by importing `schedule-summary.ts`. */
function reachableFiles(): { path: string; source: string }[] {
  const seen = new Map<string, string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    const source = readFileSync(file, "utf8");
    seen.set(file, source);
    for (const { specifier, typeOnly } of importsOf(source)) {
      if (typeOnly) continue;
      if (!specifier.startsWith(".")) continue;
      queue.push(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
    }
  }
  return [...seen].map(([path, source]) => ({ path, source }));
}

describe("the schedule summary is safe to run in the browser (#1970)", () => {
  it("reaches more than just its own file", () => {
    // Guards the walker itself: if the import parser silently matched nothing, every other
    // assertion below would pass vacuously.
    expect(reachableFiles().length).toBeGreaterThan(1);
  });

  it("pulls in no Node built-in at runtime", () => {
    const offenders = reachableFiles()
      .filter(({ source }) =>
        importsOf(source).some(
          ({ specifier, typeOnly }) => !typeOnly && specifier.startsWith("node:")
        )
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("never reaches the wellness package index", () => {
    const offenders = reachableFiles()
      .filter(({ path }) => path.endsWith("/index.ts"))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("is published as its own entry point so the browser need not import the index", () => {
    const manifest = JSON.parse(readFileSync(resolve(WELLNESS_SRC, "../package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports["./schedule-summary"]).toBe("./src/schedule-summary.ts");
  });
});
