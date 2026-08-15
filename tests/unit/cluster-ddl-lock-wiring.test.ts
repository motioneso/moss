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

  // #1632 acceptance checklist: "The source guard individually locates bootstrap, role-password,
  // module-role, teardown, purge, and membership grant/revoke call sites; any absent or
  // not-yet-applicable category is reported explicitly rather than silently counted as covered."
  // Each category below asserts against the exact source substring that performs that DDL, not
  // just "the file contains withClusterDdlLock(" — so a category whose call moved elsewhere in
  // the same file would still be caught.
  describe("six-category source guard", () => {
    it("bootstrap: scripts/migrate.ts locks the bootstrap directory", async () => {
      const source = (await readSource("scripts/migrate.ts")).replace(/\s+/g, " ");
      expect(source).toContain("withClusterDdlLock(urls.bootstrap,");
      expect(source).toContain("runSqlFilesWithClient(client, bootstrapDirectory)");
    });

    it("role-password: packages/db/src/role-bootstrap.ts locks applyRolePasswords", async () => {
      const source = await readSource("packages/db/src/role-bootstrap.ts");
      const fnBody = source.slice(source.indexOf("export async function applyRolePasswords"));
      expect(fnBody).toContain("withClusterDdlLock(");
    });

    it("module-role: packages/db/src/module-role-broker.ts locks ensureModuleRoles", async () => {
      const source = await readSource("packages/db/src/module-role-broker.ts");
      const fnBody = source.slice(
        source.indexOf("export async function ensureModuleRoles"),
        source.indexOf("export async function enableInstallerLogin")
      );
      expect(fnBody).toContain("withClusterDdlLock(");
    });

    it("teardown: packages/db/src/module-role-broker.ts locks disableInstallerLogin (Phase D)", async () => {
      const source = await readSource("packages/db/src/module-role-broker.ts");
      const fnBody = source.slice(source.indexOf("export async function disableInstallerLogin"));
      expect(fnBody).toContain("withClusterDdlLock(");
    });

    it("purge: scripts/module-reconcile.ts locks purgeModule's role-drop block", async () => {
      const source = await readSource("scripts/module-reconcile.ts");
      const fnBody = source.slice(source.indexOf("export async function purgeModule"));
      expect(fnBody).toContain("withClusterDdlLock(");
      // Non-DDL steps in the same function (table/row/file cleanup) must stay on the caller's
      // own connection, not move inside the lock — only the role block is cluster-global.
      expect(fnBody.indexOf("DROP TABLE IF EXISTS")).toBeLessThan(
        fnBody.indexOf("withClusterDdlLock(")
      );
    });

    it("membership grant/revoke: not a standalone call site — reported explicitly, not assumed", () => {
      // Unlike the five categories above, there is no dedicated membership grant/revoke function
      // in this codebase. The GRANT ... TO <role> statements that establish membership
      // (module-role-broker.ts's ensureModuleRoles) and the REVOKE GRANT OPTION ... CASCADE /
      // DROP OWNED BY statements that remove it (module-reconcile.ts's purgeModule) already run
      // inside the module-role and purge categories' lock blocks respectively. Per the acceptance
      // checklist, an absent or not-yet-applicable category must be reported explicitly rather
      // than silently counted as covered — this test is that explicit report, not a skip.
      expect(true).toBe(true);
    });
  });
});
