import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyRolePasswords,
  assertUniqueMigrationVersions,
  buildRolePasswordPlan,
  getMossDatabaseUrls,
  loadMigrationFiles,
  runSqlFiles,
  runSqlFilesWithClient,
  runSqlMigrations,
  withClusterDdlLock
} from "@moss/db";
import { migratePgBoss } from "@moss/jobs";
import { getAllQueueDefinitions, getBuiltInSqlMigrationDirectories } from "@moss/module-registry";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const urls = getMossDatabaseUrls();

const bootstrapDirectory = join(root, "infra/postgres/bootstrap");
const migrationsDirectory = join(root, "infra/postgres/migrations");
const grantsDirectory = join(root, "infra/postgres/grants");

// The bootstrap directory creates cluster-global objects (roles, extensions), so it runs under
// the #1632 cluster-DDL lock — on that lock's guarded DDL session, whose statements stop the
// instant the lock-holding session dies, so this DDL can never run unserialized. The grants
// directory below is database-local and stays unlocked.
await withClusterDdlLock(urls.bootstrap, (client) =>
  runSqlFilesWithClient(client, bootstrapDirectory)
);

// Assign runtime role passwords from the configured connection URLs. The plan
// fails closed in production when a role password is missing or still a dev
// default, so this must run before any runtime-role connection below.
await applyRolePasswords(urls.bootstrap, buildRolePasswordPlan(urls));

const allMigrationDirectories = [migrationsDirectory, ...getBuiltInSqlMigrationDirectories()];
const allMigrationFiles = (
  await Promise.all(allMigrationDirectories.map((dir) => loadMigrationFiles(dir)))
).flat();
// Reserve package-owned SQL numbers without running them as the core owner.
// Only the restricted package installer may execute these migrations.
const moduleEntries = await readdir(join(root, "modules"), { withFileTypes: true }).catch(
  (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  }
);
const packageMigrationFiles = (
  await Promise.all(
    moduleEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = join(root, "modules", entry.name, "sql");
        const exists = await stat(directory).then(
          (info) => info.isDirectory(),
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          }
        );
        return exists ? loadMigrationFiles(directory) : [];
      })
  )
).flat();
assertUniqueMigrationVersions([...allMigrationFiles, ...packageMigrationFiles]);

const migrationResults = [
  await runSqlMigrations({
    connectionString: urls.migration,
    migrationsDirectory
  })
];

for (const moduleMigrationsDirectory of getBuiltInSqlMigrationDirectories()) {
  migrationResults.push(
    await runSqlMigrations({
      connectionString: urls.migration,
      migrationsDirectory: moduleMigrationsDirectory
    })
  );
}

await migratePgBoss(urls.migration, getAllQueueDefinitions());
await runSqlFiles(urls.migration, grantsDirectory);

const applied = migrationResults.flatMap((result) => result.applied);
const skipped = migrationResults.flatMap((result) => result.skipped);

for (const migration of applied) {
  console.log(`applied ${migration.name}`);
}

if (applied.length === 0) {
  console.log(`no SQL migrations applied; ${skipped.length} already current`);
}

console.log("pg-boss schema, queues, and runtime grants are current");
