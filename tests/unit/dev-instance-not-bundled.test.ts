import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards #1258's provisioning-tool boundary: the dev-instance CLI (`scripts/dev-instance/*`) talks
 * directly to Postgres with elevated, dev-only intent (dropping/creating databases, minting local
 * tokens). It must never be reachable from the real app's entry points — a stray import would ship
 * that behavior into the running API or worker. This walks the real import graph from each entry
 * file and fails if any visited file's path contains "scripts/dev-instance".
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORBIDDEN_PATH_SEGMENT = "scripts/dev-instance";

const IMPORT_RE = /(?:import|export)\s+(?:[^'"]*?from\s+)?["']([^"']+)["']/g;

function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function resolvePackageDir(packageName: string): string | null {
  const direct = join(REPO_ROOT, "packages", packageName.replace(/^@moss\//, ""));
  if (existsSync(join(direct, "package.json"))) return direct;

  const packagesDir = join(REPO_ROOT, "packages");
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = join(packagesDir, entry.name, "package.json");
    if (!existsSync(pkgJsonPath)) continue;
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: string };
    if (pkgJson.name === packageName) return join(packagesDir, entry.name);
  }
  return null;
}

function resolveFile(candidate: string): string | null {
  // NodeNext ESM: relative imports are written `./x.js` but the source on disk is `x.ts`/`x.tsx`.
  const stripped = candidate.replace(/\.(js|jsx)$/, "");
  for (const base of stripped === candidate ? [candidate] : [stripped, candidate]) {
    for (const ext of ["", ".ts", ".tsx", ".js", ".jsx"]) {
      const withExt = base + ext;
      if (existsSync(withExt) && statSync(withExt).isFile()) return withExt;
    }
  }
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const indexCandidate = join(candidate, "index" + ext);
    if (existsSync(indexCandidate) && statSync(indexCandidate).isFile()) return indexCandidate;
  }
  return null;
}

function resolveSpecifierToFile(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith(".")) {
    return resolveFile(join(dirname(fromFile), specifier));
  }
  if (specifier.startsWith("@moss/")) {
    const packageDir = resolvePackageDir(specifier);
    if (!packageDir) return null;
    const pkgJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    const entry = pkgJson.exports?.["."];
    if (!entry) return null;
    return resolve(packageDir, entry);
  }
  return null; // third-party packages — not walked further.
}

function walkImportGraph(entryFile: string): { visited: Set<string>; violations: string[] } {
  const visited = new Set<string>();
  const violations: string[] = [];
  const stack = [entryFile];

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    if (file.includes(FORBIDDEN_PATH_SEGMENT)) {
      violations.push(file);
      continue;
    }

    const source = readFileSync(file, "utf8");
    for (const specifier of extractSpecifiers(source)) {
      const resolved = resolveSpecifierToFile(specifier, file);
      if (resolved && !visited.has(resolved)) stack.push(resolved);
    }
  }

  return { visited, violations };
}

describe("dev-instance CLI is never reachable from the real app (#1258)", () => {
  it("never reaches scripts/dev-instance from the API entry point", () => {
    const entry = resolve(REPO_ROOT, "apps/api/src/server.ts");
    const { visited, violations } = walkImportGraph(entry);
    expect(visited.size).toBeGreaterThan(1); // sanity: the walk actually traversed imports
    expect(violations).toEqual([]);
  });

  it("never reaches scripts/dev-instance from the worker entry point", () => {
    const entry = resolve(REPO_ROOT, "apps/worker/src/worker.ts");
    const { visited, violations } = walkImportGraph(entry);
    expect(visited.size).toBeGreaterThan(1); // sanity: the walk actually traversed imports
    expect(violations).toEqual([]);
  });
});
