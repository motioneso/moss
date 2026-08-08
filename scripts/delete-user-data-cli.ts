/**
 * CLI entrypoint for user deletion (`pnpm delete:user`). Split from
 * `delete-user-data.ts` (#801 Phase A, QA on PR #816) because the CLI needs
 * `@moss/module-registry` (to derive `moduleDeletionTables` from module
 * `dataLifecycle.deletion` declarations) while the library file must never
 * reference it, in ANY form:
 *
 * - A static import in the library would create a package cycle
 *   (settings -> delete-user-data -> module-registry -> settings).
 * - Even a guarded dynamic `import("@moss/module-registry")` breaks both
 *   runtime paths (esbuild-trap #357 class):
 *   1. Bundles: esbuild statically resolves literal dynamic imports, inlining
 *      module-registry into the api/worker bundles via the settings chain. That
 *      closes the pre-existing jobs <-> settings cycle into a bigger loop and
 *      esbuild mis-emits a non-async `__esm` init wrapper containing `await`
 *      (`SyntaxError: Unexpected reserved word` at boot in dist/server.js and
 *      dist/worker.js).
 *   2. CLI (tsx from source): the dynamic import deadlocks — module-registry's
 *      graph statically imports delete-user-data.ts itself (via settings), and
 *      that module is still mid-evaluation while awaiting `main()`, so the
 *      import can never settle (Node exits 13, "unsettled top-level await").
 *
 * A separate entry file has neither problem: nothing imports this file, so it
 * is never bundled and never part of a cycle — the static imports below are
 * safe and fully type-checked.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertOperatorConfirmsTargetOwner, createDatabase, getMossDatabaseUrls } from "@moss/db";
import { getExternalModuleDeletionTables, getModuleDeletionTables } from "@moss/module-registry";

import { deleteUserData } from "./delete-user-data.js";

// External (post-deploy-installed) module manifests are not yet loadable at CLI run time — the
// #860 pluggable-modules loader that will list them hasn't landed. getExternalModuleDeletionTables
// is wired here with an empty list so the merge point exists and needs no further change once that
// loader ships; MODULE_DELETION_TABLES sweep coverage is unaffected either way (#914 spec D6).
const installedExternalManifests: Parameters<typeof getExternalModuleDeletionTables>[0] = [];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.userId) {
    throw new Error(
      "Usage: pnpm delete:user -- --user-id <uuid> [--actor-user-id <uuid>] " +
        "[--execute --confirm-user-id <uuid> --confirm-owner-email <email>]"
    );
  }

  if (args.execute) {
    // #1383: prove this run is pointed at the instance the operator thinks it is before any
    // destructive DML runs on the bootstrap connection — independent of --confirm-user-id,
    // which only confirms the target user, not the target database.
    const db = createDatabase({ connectionString: getMossDatabaseUrls().migration });
    try {
      await assertOperatorConfirmsTargetOwner(db, args.confirmOwnerEmail);
    } finally {
      await db.destroy();
    }
  }

  const result = await deleteUserData({
    actorUserId: args.actorUserId,
    confirmUserId: args.confirmUserId,
    dryRun: !args.execute,
    userId: args.userId,
    moduleDeletionTables: [
      ...getModuleDeletionTables(),
      ...getExternalModuleDeletionTables(installedExternalManifests)
    ]
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.dryRun) {
    console.log(
      "Dry run only — no rows or vault data deleted. On --execute, the user's on-disk " +
        "vault subtree is removed via VaultContext after the DB commit."
    );
  } else if (result.vaultDeleted) {
    console.log(`Removed on-disk vault subtree for user ${result.userId}.`);
  }
}

function parseArgs(args: readonly string[]): {
  readonly actorUserId?: string;
  readonly confirmOwnerEmail?: string;
  readonly confirmUserId?: string;
  readonly execute: boolean;
  readonly userId?: string;
} {
  return {
    actorUserId: readFlag(args, "--actor-user-id"),
    confirmOwnerEmail: readFlag(args, "--confirm-owner-email"),
    confirmUserId: readFlag(args, "--confirm-user-id"),
    execute: args.includes("--execute"),
    userId: readFlag(args, "--user-id")
  };
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);

  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (!value) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

// Run only when executed directly (`tsx scripts/delete-user-data-cli.ts`) —
// mirrors the guard convention of the other operator scripts. Nothing imports
// this file, but the guard keeps that invariant enforced rather than assumed.
const isThisModuleEntry =
  import.meta.url.endsWith("delete-user-data-cli.ts") ||
  import.meta.url.endsWith("delete-user-data-cli.js");
if (
  isThisModuleEntry &&
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await main();
}
