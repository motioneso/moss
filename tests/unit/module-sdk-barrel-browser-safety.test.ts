import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the module-sdk barrel (#1120) browser-safety invariant: `packages/module-sdk/src/index.ts`
 * is the package's top-level `"."` export, so any VALUE a caller imports from the bare
 * `@moss/module-sdk` specifier is reachable through this file. `@moss/shared` re-exports values
 * from this barrel and is itself Vite-bundled into apps/web, so a node builtin anywhere in the
 * barrel's own import graph would break the browser build (or worse, silently ship server-only
 * code to the client) the same way `sessionRateLimitKey`'s `node:crypto` dependency did before
 * #1120 moved it to the `@moss/module-sdk/server` subpath (see #1110 for the first, narrower
 * version of this same bug with a different symbol).
 *
 * This walks the real import graph starting at index.ts, following every relative import, and
 * fails if any file it reaches specifies a `node:*` module. It deliberately does not walk into
 * bare package specifiers (fastify, @moss/db, ...) — those are a separate, already-declared
 * dependency of the server-only packages that consume this barrel, not something this guard
 * needs to re-litigate.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BARREL_ENTRY = resolve(REPO_ROOT, "packages/module-sdk/src/index.ts");

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?from\s+)?["']([^"']+)["']/g;

function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function resolveRelativeFile(candidate: string): string | null {
  // NodeNext ESM: relative imports are written `./x.js` but the source on disk is `x.ts`.
  const stripped = candidate.replace(/\.(js|jsx)$/, "");
  for (const base of stripped === candidate ? [candidate] : [stripped, candidate]) {
    for (const ext of ["", ".ts", ".tsx", ".js", ".jsx"]) {
      const withExt = base + ext;
      if (existsSync(withExt)) return withExt;
    }
  }
  return null;
}

function walkImportGraph(entryFile: string): { visited: Set<string>; violations: string[] } {
  const visited = new Set<string>();
  const violations: string[] = [];
  const stack = [entryFile];

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, "utf8");
    for (const specifier of extractSpecifiers(source)) {
      if (specifier.startsWith("node:")) {
        violations.push(`${file} imports node builtin "${specifier}"`);
        continue;
      }
      if (!specifier.startsWith(".")) continue; // bare package specifier — not walked further.

      const resolved = resolveRelativeFile(join(dirname(file), specifier));
      if (resolved && !visited.has(resolved)) stack.push(resolved);
    }
  }

  return { visited, violations };
}

describe("module-sdk barrel browser safety (#1120)", () => {
  it("never reaches a node:* builtin from the @moss/module-sdk top-level barrel", () => {
    const { visited, violations } = walkImportGraph(BARREL_ENTRY);
    // Sanity: the walk actually traversed imports rather than reading one leaf file.
    expect(visited.size).toBeGreaterThan(1);
    expect(violations).toEqual([]);
  });

  it("keeps sessionRateLimitKey / mcpSessionRateLimitKey off the barrel and on the ./server subpath", () => {
    const barrelSource = readFileSync(BARREL_ENTRY, "utf8");
    expect(barrelSource).not.toMatch(/export\s*\{[^}]*sessionRateLimitKey/s);

    const serverEntry = resolve(REPO_ROOT, "packages/module-sdk/src/server.ts");
    const serverSource = readFileSync(serverEntry, "utf8");
    expect(serverSource).toMatch(/sessionRateLimitKey/);
    expect(serverSource).toMatch(/mcpSessionRateLimitKey/);
  });
});
