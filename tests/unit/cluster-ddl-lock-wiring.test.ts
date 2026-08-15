// #1632 source-coverage guard: every production call site that issues cluster-global DDL must
// route it through withClusterDdlLock. Behaviour is pinned by the per-caller unit tests; this
// file exists so a future refactor cannot quietly drop a call site back to a bare client.
// scripts/migrate.ts is top-level module code that connects on import, so source text is the
// only way to assert its wiring without touching a database.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const LOCKED_SOURCES = [
  "packages/db/src/module-role-broker.ts",
  "packages/db/src/role-bootstrap.ts",
  "scripts/migrate.ts",
  "scripts/module-reconcile.ts"
];

async function readSource(relativePath: string): Promise<string> {
  return readFile(join(repoRoot, relativePath), "utf8");
}

describe("cluster DDL lock wiring", () => {
  it.each(LOCKED_SOURCES)("%s calls withClusterDdlLock", async (relativePath) => {
    expect(await readSource(relativePath)).toContain("withClusterDdlLock(");
  });

  it("migrate.ts locks the bootstrap directory and leaves the grants directory unlocked", async () => {
    // Whitespace-collapsed so Prettier's line wrapping can't break the assertions.
    const source = (await readSource("scripts/migrate.ts")).replace(/\s+/g, " ");
    expect(source).toContain("withClusterDdlLock(urls.bootstrap,");
    expect(source).toContain("runSqlFilesWithClient(client, bootstrapDirectory)");
    expect(source).toContain("await runSqlFiles(urls.migration, grantsDirectory);");
    // The bootstrap directory must no longer be reachable through the self-connecting wrapper.
    expect(source).not.toContain("runSqlFiles(urls.bootstrap");
  });

  it("the role broker and role bootstrap open no client of their own", async () => {
    for (const relativePath of [
      "packages/db/src/module-role-broker.ts",
      "packages/db/src/role-bootstrap.ts"
    ]) {
      expect(await readSource(relativePath), relativePath).not.toContain("new Client(");
    }
  });
});
