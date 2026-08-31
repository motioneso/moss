// #1632 source-coverage guard: every production call site that issues cluster-global DDL must
// route it through withClusterDdlLock. Behaviour is pinned by the per-caller unit tests; this
// file exists so a future refactor cannot quietly drop a call site back to a bare client.
// scripts/migrate.ts is top-level module code that connects on import, so source text is the
// only way to assert its wiring without touching a database.
//
// #1013 extends the same technique to the TEST path, which #1632 left unwired and which is where
// the `tuple concurrently updated` collisions actually occur — see "test-surface routing guard".
import { readdir, readFile } from "node:fs/promises";
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

/** The one module allowed to issue the test suite's cluster-global DDL, all of it under the lock. */
const TEST_DATABASE_SOURCE = "tests/integration/test-database.ts";

const MEMBERSHIP_HELPERS = [
  "grantModuleMembershipAtSetup",
  "revokeModuleMembershipAtTeardown"
] as const;

const CLUSTER_GLOBAL_HELPERS = ["dropModuleRolesAtTeardown", ...MEMBERSHIP_HELPERS] as const;

/** Writes pg_authid — cluster-global, so it races every other gate database on the same host. */
const ROLE_DDL = /\b(?:CREATE|DROP|ALTER)\s+ROLE\b/i;
/** `GRANT <role> TO <role>` / `REVOKE <role> FROM <role>` — pg_auth_members, equally global. */
const MEMBERSHIP_DDL = /\b(?:GRANT|REVOKE)\s+jarvis_\w+\s+(?:TO|FROM)\s+jarvis_\w+/i;

async function readSource(relativePath: string): Promise<string> {
  return readFile(join(repoRoot, relativePath), "utf8");
}

/**
 * One function's body, so an assertion cannot be satisfied by a match somewhere else in the file.
 * Ends at the first closing brace in column 0, which is where Prettier puts every declaration's.
 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`no declaration of ${name} found`);
  const body = source.slice(start);
  const end = body.indexOf("\n}");
  return end === -1 ? body : body.slice(0, end);
}

/**
 * Every `.ts` file under tests/integration, discovered rather than listed: a suite added later is
 * scanned automatically, so the guard below cannot rot the way a pinned allowlist would.
 */
async function integrationSources(): Promise<string[]> {
  const entries = await readdir(join(repoRoot, "tests/integration"), { recursive: true });
  return entries
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => `tests/integration/${entry}`)
    .sort();
}

/**
 * Drop comments before scanning for DDL. The suites name `DROP ROLE` constantly — they explain why
 * the statements moved — so a raw scan of source text reports prose, not call sites. A `//`
 * preceded by `:` is left alone so a `postgres://` connection string is not read as a comment.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Remove `name(...)` call regions, so what remains is the DDL a suite issues on its OWN connection.
 * Counting parentheses is safe here because the SQL literals in these files are paren-balanced.
 */
function stripCallArguments(source: string, functionNames: readonly string[]): string {
  let remaining = source;
  for (const name of functionNames) {
    for (
      let index = remaining.indexOf(`${name}(`);
      index !== -1;
      index = remaining.indexOf(`${name}(`)
    ) {
      let depth = 0;
      let end = index + name.length;
      for (; end < remaining.length; end += 1) {
        if (remaining[end] === "(") depth += 1;
        else if (remaining[end] === ")") {
          depth -= 1;
          if (depth === 0) {
            end += 1;
            break;
          }
        }
      }
      remaining = remaining.slice(0, index) + remaining.slice(end);
    }
  }
  return remaining;
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

    it("membership grant/revoke: no standalone PRODUCTION call site, but the test suite has two", async () => {
      // Unlike the five categories above, there is no dedicated membership grant/revoke function
      // on the production path. The GRANT ... TO <role> statements that establish membership
      // (module-role-broker.ts's ensureModuleRoles) and the REVOKE GRANT OPTION ... CASCADE /
      // DROP OWNED BY statements that remove it (module-reconcile.ts's purgeModule) already run
      // inside the module-role and purge categories' lock blocks respectively. Per the acceptance
      // checklist, an absent or not-yet-applicable category must be reported explicitly rather
      // than silently counted as covered — the paragraph above is that explicit report.
      //
      // #1013 amends the other half of that claim, which was true only because this guard never
      // looked outside production. The TEST path does have standalone membership call sites, and
      // their being outside any lock is exactly why pg_auth_members races went uncovered while
      // this suite stayed green. They are locked now; the routing guard below enforces it.
      const source = await readSource(TEST_DATABASE_SOURCE);
      for (const helper of MEMBERSHIP_HELPERS) {
        expect(source, helper).toContain(`export async function ${helper}(`);
      }
    });
  });

  // #1013: everything above covers the production path. The `XX000 tuple concurrently updated`
  // collisions this issue is about happened on the TEST path — parallel gate lanes run against
  // separate databases but share one Postgres cluster, so they all write the same cluster-global
  // pg_authid / pg_auth_members catalogs, and the integration suites were issuing that DDL on
  // their own unlocked connections. These cases pin the shape that fixed it: one shared locked
  // helper module, and no suite holding cluster-global DDL of its own.
  describe("test-surface routing guard", () => {
    it("runs the bootstrap reset on the lock's guarded session", async () => {
      const source = (await readSource(TEST_DATABASE_SOURCE)).replace(/\s+/g, " ");
      expect(source).toContain("withClusterDdlLock(connectionStrings.bootstrap, (client) =>");
      expect(source).toContain(
        'runSqlFilesWithClient(client, join(root, "infra/postgres/bootstrap"))'
      );
      // The bootstrap directory must not be reachable through the self-connecting wrapper, which
      // would open an unlocked connection of its own — the same defect scripts/migrate.ts had.
      expect(source).not.toContain("runSqlFiles(connectionStrings.bootstrap");
    });

    it("funnels every cluster-global helper through one locked section per call", async () => {
      const source = await readSource(TEST_DATABASE_SOURCE);
      for (const helper of CLUSTER_GLOBAL_HELPERS) {
        expect(functionBody(source, helper), helper).toContain("runClusterGlobalDdl(");
      }
      const funnel = functionBody(source, "runClusterGlobalDdl").replace(/\s+/g, " ");
      expect(funnel).toContain(
        "withClusterDdlLock( connectionStrings.bootstrap, async (client) => {"
      );
      // Callers can retarget the lock domain (#1637's defect class), so the funnel must pass their
      // options through rather than acquire against whatever the ambient env happens to name.
      expect(funnel).toContain("options.lock");
      // One acquire/release per call, never one per statement: the statement loop is INSIDE the
      // callback. The reverse is impossible anyway — nesting throws ClusterDdlLockReentrancyError.
      expect(funnel.indexOf("withClusterDdlLock(")).toBeLessThan(
        funnel.indexOf("for (const statement of statements)")
      );
    });

    it("opens exactly two locked sections: the bootstrap reset and the helper funnel", async () => {
      const source = await readSource(TEST_DATABASE_SOURCE);
      expect(source.match(/withClusterDdlLock\(/g)).toHaveLength(2);
    });

    it("keeps DROP ROLE tolerance SQLSTATE-scoped and membership fail-closed", async () => {
      const source = await readSource(TEST_DATABASE_SOURCE);
      // 2BP01 (dependent objects) only — a role another lane still owns is expected debris at
      // teardown. Anything else, including a permission or syntax failure, must still throw.
      expect(functionBody(source, "dropModuleRolesAtTeardown")).toContain('=== "2BP01"');
      for (const helper of MEMBERSHIP_HELPERS) {
        // Two arguments, no isTolerated predicate: every membership error propagates.
        expect(functionBody(source, helper), helper).toContain(
          "runClusterGlobalDdl(statements, options);"
        );
      }
    });

    it("leaves no integration suite issuing cluster-global DDL on its own connection", async () => {
      const offenders: string[] = [];
      const scanned: string[] = [];
      const membershipHelperCallers: string[] = [];
      for (const relativePath of await integrationSources()) {
        if (relativePath === TEST_DATABASE_SOURCE) continue; // the helper module itself
        const withoutComments = stripComments(await readSource(relativePath));
        const source = stripCallArguments(withoutComments, CLUSTER_GLOBAL_HELPERS);
        if (ROLE_DDL.test(source)) offenders.push(`${relativePath}: role DDL`);
        if (MEMBERSHIP_DDL.test(source)) offenders.push(`${relativePath}: membership DDL`);
        if (MEMBERSHIP_HELPERS.some((helper) => withoutComments.includes(`${helper}(`))) {
          membershipHelperCallers.push(relativePath);
        }
        scanned.push(relativePath);
      }
      // Asserted as a list so a failure names the suites rather than just reporting a count.
      expect(offenders).toEqual([]);
      // A discovery bug — wrong directory, wrong extension filter — would otherwise scan nothing
      // and report a clean surface. There are ~200 integration sources; 50 is a floor, not a count.
      expect(scanned.length).toBeGreaterThan(50);
      // The approved helper path must stay represented even when callers derive role names rather
      // than spelling out jarvis_* literals. Keep the raw detector's liveness proof separate.
      expect(membershipHelperCallers.length).toBeGreaterThan(0);
      expect(MEMBERSHIP_DDL.test("GRANT jarvis_mod_example TO jarvis_app_runtime")).toBe(true);
      expect(ROLE_DDL.test(stripComments(await readSource(TEST_DATABASE_SOURCE)))).toBe(true);
    });

    it("revokes membership before the per-database privileges that depend on it", async () => {
      // Postgres refuses to revoke a grant-option privilege while a dependent downstream grant
      // still exists, so the cluster-global membership revoke has to come first. Two sequential
      // lock sections, never one wrapping both — nesting throws.
      const checked: string[] = [];
      for (const relativePath of await integrationSources()) {
        if (relativePath === TEST_DATABASE_SOURCE) continue;
        const source = await readSource(relativePath);
        const membershipRevoke = source.indexOf("revokeModuleMembershipAtTeardown(");
        if (membershipRevoke === -1) continue;
        expect(source.indexOf("REVOKE ALL PRIVILEGES"), relativePath).toBeGreaterThan(
          membershipRevoke
        );
        checked.push(relativePath);
      }
      // Guards against the ordering case silently passing because nothing matched.
      expect(checked.length).toBeGreaterThan(0);
    });
  });
});
