import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSourceInspector, SOURCE_INSPECTOR_LIMITS } from "@moss/settings";

const temporaryDirectories: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "moss-source-inspector-"));
  temporaryDirectories.push(root);
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(root, "packages", "settings", "src"), { recursive: true });
  mkdirSync(join(root, "apps"), { recursive: true });
  writeFileSync(
    join(root, "packages/settings/src/host-diagnostics.ts"),
    'const known = "DATABASE_URL";\n'
  );
  return root;
}

afterEach(() => {
  while (temporaryDirectories.length > 0)
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe("source inspector", () => {
  it("reads and searches only allowed relative source paths", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "packages/settings/src/example.ts"), "first\nneedle here\nthird\n");
    const inspector = createSourceInspector({ workspaceRoot: root });

    await expect(
      inspector.read({ path: "packages/settings/src/example.ts", startLine: 2 })
    ).resolves.toEqual({
      path: "packages/settings/src/example.ts",
      startLine: 2,
      endLine: 3,
      text: "needle here\nthird"
    });
    await expect(
      inspector.search({ query: "needle", pathPrefix: "packages" })
    ).resolves.toMatchObject({
      matches: [{ path: "packages/settings/src/example.ts", startLine: 2, text: "needle here" }]
    });
  });

  it("rejects traversal, excluded paths, and symlinks that escape the workspace", async () => {
    const root = fixtureRoot();
    const outside = mkdtempSync(join(tmpdir(), "moss-source-inspector-outside-"));
    temporaryDirectories.push(outside);
    writeFileSync(join(outside, "secret.ts"), "outside\n");
    symlinkSync(join(outside, "secret.ts"), join(root, "packages/settings/src/link.ts"));
    const inspector = createSourceInspector({ workspaceRoot: root });

    await expect(inspector.read({ path: "../outside" })).rejects.toThrow("outside the workspace");
    await expect(inspector.read({ path: "/etc/passwd" })).rejects.toThrow("must be relative");
    await expect(inspector.read({ path: "packages/../../etc/passwd" })).rejects.toThrow(
      "outside the workspace"
    );
    await expect(inspector.read({ path: "packages/settings/src/link.ts" })).rejects.toThrow(
      "resolves outside"
    );
  });

  it("enforces excerpt, match, and response limits and rejects secret-shaped text", async () => {
    const root = fixtureRoot();
    const lines = Array.from({ length: 60 }, (_, index) => `needle ${index}`);
    writeFileSync(join(root, "packages/settings/src/many.ts"), lines.join("\n"));
    writeFileSync(
      join(root, "packages/settings/src/credentials.ts"),
      "url = postgres://user:password@host/db\n"
    );
    writeFileSync(
      join(root, "packages/settings/src/key.ts"),
      "private = -----BEGIN PRIVATE KEY-----\n"
    );
    writeFileSync(join(root, "packages/settings/src/.env"), "TOKEN=secret\n");
    const inspector = createSourceInspector({ workspaceRoot: root });

    const result = await inspector.search({ query: "needle", limit: 100 });
    expect(result.matches).toHaveLength(SOURCE_INSPECTOR_LIMITS.maxMatches);
    expect(
      result.matches.every(
        (match) => match.endLine - match.startLine < SOURCE_INSPECTOR_LIMITS.maxExcerptLines
      )
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(
      SOURCE_INSPECTOR_LIMITS.maxResponseBytes
    );
    await expect(inspector.read({ path: "packages/settings/src/credentials.ts" })).rejects.toThrow(
      "credentials in a URL"
    );
    await expect(inspector.read({ path: "packages/settings/src/key.ts" })).rejects.toThrow(
      "private key header"
    );
    const hostExcerpt = await inspector.read({ path: "packages/settings/src/host-diagnostics.ts" });
    expect(hostExcerpt.text).toContain("DATABASE_URL");
  });
});
