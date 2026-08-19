import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import {
  assertOperatorConfirmsTargetOwner,
  createDatabase,
  getMossDatabaseUrls,
  NoBootstrapOwnerFoundError,
  type MossDatabase
} from "@moss/db";
import { sql, type Kysely } from "kysely";

const POSTGRES_CONTAINER = "jarv1s-postgres";

export interface RestorePlanInput {
  readonly allowEmptyTarget?: boolean;
  readonly backupFile: string;
  readonly confirmDatabase?: string;
  readonly confirmOwnerEmail?: string;
  readonly confirmRestore?: boolean;
  readonly connectionString?: string;
  readonly execute?: boolean;
}

/**
 * #1468: extends the #1383 target-identity guard to the restore path. A restore's `--clean
 * --if-exists` drops and recreates every object in the target, so proving the operator is
 * pointed at the instance they think they are matters as much here as for secret rewrap.
 *
 * `allowEmptyTarget` is a narrow, explicit opt-out for the one case the base guard can't pass
 * through on its own: restoring into a target with nothing to confirm identity against. That
 * covers a fresh, never-migrated database (no `app.users` schema), a migrated-but-empty one
 * (schema present, zero rows), AND — because `assertOperatorConfirmsTargetOwner` can't tell
 * these apart from a single failed lookup — a schema that's populated but has no row flagged
 * `is_bootstrap_owner` (see `tests/integration/restore-database-target-guard.test.ts`'s third
 * case). A `TargetIdentityMismatchError` — a real bootstrap-owner row that doesn't match the
 * supplied email — is never suppressed by this flag; it only widens the "there's nothing to
 * confirm against" case that would otherwise throw `NoBootstrapOwnerFoundError` unconditionally.
 * QA finding N2 on PR #1647: tightening this to require the "populated but unflagged" case to
 * go through a separate, more explicit opt-out is a real follow-up, deliberately deferred —
 * it's a behavior change to a destructive-operation guard, not a QA-RED fix.
 */
export async function assertRestoreTargetIdentity(
  db: Kysely<MossDatabase>,
  input: { readonly confirmOwnerEmail?: string; readonly allowEmptyTarget?: boolean }
): Promise<{ readonly id: string; readonly email: string } | null> {
  const schemaCheck = await sql<{ to_regclass: string | null }>`
    SELECT to_regclass('app.users')
  `.execute(db);

  const usersTableExists = schemaCheck.rows[0]?.to_regclass !== null;

  if (!usersTableExists) {
    if (!input.allowEmptyTarget) {
      throw new NoBootstrapOwnerFoundError();
    }
    return null;
  }

  try {
    return await assertOperatorConfirmsTargetOwner(db, input.confirmOwnerEmail);
  } catch (error) {
    if (error instanceof NoBootstrapOwnerFoundError && input.allowEmptyTarget) {
      return null;
    }
    throw error;
  }
}

export interface RestorePlan {
  readonly backupFile: string;
  readonly database: string;
  readonly dockerCommand: "docker";
  readonly env: Readonly<Record<"PGPASSWORD", string>>;
  readonly execute: boolean;
  readonly host: string;
  readonly restoreArgs: readonly string[];
}

export function createRestorePlan(input: RestorePlanInput): RestorePlan {
  if (!input.backupFile) {
    throw new Error("Restore backup file is required");
  }
  if (input.execute && !input.confirmRestore) {
    throw new Error("Restore execution requires --confirm-restore");
  }

  const url = new URL(input.connectionString ?? getMossDatabaseUrls().bootstrap);
  const database = url.pathname.replace(/^\//, "");
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);

  if (!database) {
    throw new Error("Restore database URL must include a database name");
  }
  if (!username) {
    throw new Error("Restore database URL must include a username");
  }
  if (!password) {
    throw new Error("Restore database URL must include a password");
  }

  // `--clean --if-exists` drops and recreates objects in the target database, so a
  // mistargeted connection string is destructive. Mirror the confirmUserId guard in
  // delete-user-data.ts: the operator must name the exact database back to us before
  // we will execute against it.
  if (input.execute && input.confirmDatabase !== database) {
    throw new Error(
      `Restore execution requires --confirm-database to match the target database "${database}" ` +
        `on host "${url.hostname}"`
    );
  }

  // The dump is streamed into the container over stdin (`docker exec -i … pg_restore`
  // reading the archive from stdin), so we never stage a plaintext copy of the sensitive
  // backup inside the long-lived Postgres container. No `--file`/path arg → reads stdin.
  const dockerPgRestoreArgs = [
    "--username",
    username,
    "--dbname",
    database,
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-privileges"
  ];

  return {
    dockerCommand: "docker",
    restoreArgs: [
      "exec",
      "-i",
      "--env",
      "PGPASSWORD",
      POSTGRES_CONTAINER,
      "pg_restore",
      ...dockerPgRestoreArgs
    ],
    backupFile: input.backupFile,
    database,
    host: url.hostname,
    env: {
      PGPASSWORD: password
    },
    execute: input.execute ?? false
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = createRestorePlan(args);

  if (!plan.execute) {
    console.log(`Restore target: database "${plan.database}" on host "${plan.host}".`);
    console.log(
      "Restore drill plan only. Add --execute --confirm-restore " +
        `--confirm-database ${plan.database} --confirm-owner-email <target's bootstrap owner email> ` +
        "to run pg_restore. If the target has no app.users rows yet (a fresh database), pass " +
        "--allow-empty-target instead of --confirm-owner-email."
    );
    console.log(`${plan.backupFile} | ${plan.dockerCommand} ${plan.restoreArgs.join(" ")}`);
    return;
  }

  await access(plan.backupFile);

  const db = createDatabase({
    connectionString: args.connectionString ?? getMossDatabaseUrls().bootstrap
  });
  try {
    await assertRestoreTargetIdentity(db, {
      confirmOwnerEmail: args.confirmOwnerEmail,
      allowEmptyTarget: args.allowEmptyTarget
    });
  } finally {
    await db.destroy();
  }

  console.log(
    `Restoring database "${plan.database}" on host "${plan.host}" from sensitive backup ${plan.backupFile}`
  );
  await runCommandFromFile(plan.dockerCommand, plan.restoreArgs, plan.env, plan.backupFile);
  console.log(`Restore complete from ${plan.backupFile}`);
}

function parseArgs(args: readonly string[]): RestorePlanInput {
  return {
    allowEmptyTarget: args.includes("--allow-empty-target"),
    backupFile: readRequiredFlag(args, "--input"),
    confirmDatabase: readOptionalFlag(args, "--confirm-database"),
    confirmOwnerEmail: readOptionalFlag(args, "--confirm-owner-email"),
    confirmRestore: args.includes("--confirm-restore"),
    execute: args.includes("--execute")
  };
}

function readOptionalFlag(args: readonly string[], name: string): string | undefined {
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

function readRequiredFlag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);

  if (index === -1) {
    throw new Error(
      `Usage: pnpm restore:db -- --input <backup.dump> [--execute --confirm-restore]`
    );
  }

  const value = args[index + 1];
  if (!value) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

async function runCommandFromFile(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  inputFile: string
): Promise<void> {
  const child = spawn(command, [...args], {
    env: {
      ...process.env,
      ...env
    },
    stdio: ["pipe", "inherit", "inherit"]
  });

  if (!child.stdin) {
    throw new Error(`${command} did not expose stdin for restore input`);
  }

  const exit = new Promise<void>((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} exited with status ${code ?? "unknown"}`));
    });
  });

  try {
    await Promise.all([pipeline(createReadStream(inputFile), child.stdin), exit]);
  } catch (error) {
    child.kill();
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
