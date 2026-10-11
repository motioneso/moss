import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { resolveQueryKeyToken } from "../../apps/web/src/api/query-keys.js";

// Read the actual key declarations, including factory returns and module-owned web/settings
// keys. A fabricated list of module ids would pass even after a real cache prefix drifted.
function sourcesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [path] : [];
  });
}
const frontendFiles = [
  ...sourcesUnder("apps/web/src"),
  ...readdirSync("packages", { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? ["web", "settings"].flatMap((surface) => {
          const path = `packages/${entry.name}/src/${surface}`;
          try {
            return sourcesUnder(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          }
        })
      : []
  )
];
const frontendSource = frontendFiles.map((path) => ({ path, text: readFileSync(path, "utf8") }));
const prefixes = new Set<string>();
for (const { path, text } of frontendSource) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  function collectArrays(node: ts.Node): void {
    if (ts.isArrayLiteralExpression(node)) {
      const first = node.elements[0];
      if (first && ts.isStringLiteral(first)) prefixes.add(first.text);
    }
    ts.forEachChild(node, collectArrays);
  }
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      /(?:Keys|_KEY|Key)$/.test(node.name.text)
    )
      collectArrays(node.initializer);
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "queryKey") {
      collectArrays(node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

// These modules genuinely have no React Query-owned view. Do not add dummy refresh keys:
// scratchpad has no screen, commitments is surfaced through generated briefing content,
// and workflow approval cards use a direct five-second poll instead of the query cache.
const NO_QUERY_VIEW = new Map([
  ["scratchpad", "/api/scratchpad"],
  ["jarvis.commitments", "/api/commitments"],
  ["workflows", "/api/workflows"]
]);
const manifests = getBuiltInModuleManifests().filter(
  (manifest) => (manifest.routes?.length ?? 0) > 0
);

describe("route-owning module query refresh coverage", () => {
  it.each(manifests)(
    "$id has real module-prefixed keys or resolvable refresh tokens",
    (manifest) => {
      if (NO_QUERY_VIEW.has(manifest.id)) return;
      const tokens = manifest.chatRefreshTokens ?? [];
      expect(prefixes.has(manifest.id) || tokens.length > 0, manifest.id).toBe(true);
      for (const token of tokens) {
        const key = resolveQueryKeyToken(token);
        expect(key, `${manifest.id}: ${token}`).toBeDefined();
        expect(key?.length).toBeGreaterThan(0);
      }
    }
  );

  it("keeps every no-query exception tied to a route-owning module with no cached frontend", () => {
    for (const [id, route] of NO_QUERY_VIEW) {
      const manifest = manifests.find((item) => item.id === id);
      expect(manifest, id).toBeDefined();
      expect(prefixes.has(id), id).toBe(false);
      expect(manifest?.chatRefreshTokens).toBeUndefined();
      expect(manifest?.navigation ?? []).toEqual([]);
      expect(manifest?.settings ?? []).toEqual([]);
      const readers = frontendSource
        .filter(({ text }) => text.includes(route))
        .map(({ path }) => path);
      expect(readers, id).toEqual(
        id === "workflows"
          ? [
              "apps/web/src/api/workflows-client.ts",
              "apps/web/src/chat/use-chat-stream.ts",
              "apps/web/src/chat/workflow-approval-card.tsx"
            ]
          : []
      );
    }
    for (const { text, path } of frontendSource.filter(({ text }) =>
      text.includes("/api/workflows")
    )) {
      expect(text, path).not.toMatch(/\buse(?:Infinite)?Quer(?:y|ies)\s*\(/);
    }
    const stream = readFileSync("apps/web/src/chat/use-chat-stream.ts", "utf8");
    expect(stream).toContain("listWorkflowApprovals()");
    expect(stream).toContain("setInterval(() => void refreshWorkflowApprovals(), 5_000)");
  });

  it("includes actual independent module key declarations in the source walk", () => {
    for (const id of ["news", "sports", "meetings", "workshop", "backtrack"])
      expect(prefixes.has(id), id).toBe(true);
    expect(manifests.map((manifest) => manifest.id)).toContain("jarvis.goals");
    expect(
      manifests.find((manifest) => manifest.id === "jarvis.goals")?.chatRefreshTokens
    ).toContain("goals.list");
  });
});
