import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getMossDatabaseUrls } from "@moss/db";
import pg from "pg";

const { Client } = pg;

export type DatabaseIsolationPlan =
  | { readonly mode: "passthrough"; readonly databaseName: string }
  | { readonly mode: "isolated"; readonly databaseName: string };

export function createDatabaseIsolationPlan(
  env: NodeJS.ProcessEnv,
  entropySuffix: string
): DatabaseIsolationPlan {
  if (env.JARVIS_PGDATABASE) {
    return { mode: "passthrough", databaseName: env.JARVIS_PGDATABASE };
  }

  return { mode: "isolated", databaseName: `jarvis_test_${entropySuffix}` };
}

// #1314: `pnpm test:integration <file>` looked like it ran only <file>, but pnpm appends CLI
// args onto the package.json script's own args rather than replacing them, so the actual
// invocation was `tsx scripts/test-integration.ts tests/integration <file>` — the whole
// directory glob plus the one file, silently. Moving the default in here (instead of baking
// it into the package.json script string) means "no args" and "args" are two distinct,
// deliberate cases instead of one string pnpm can accidentally extend.
const DEFAULT_VITEST_ARGS: readonly string[] = ["tests/integration"];

export function resolveVitestArgs(cliArgs: readonly string[]): string[] {
  return cliArgs.length > 0 ? [...cliArgs] : [...DEFAULT_VITEST_ARGS];
}

function quoteDatabaseIdentifier(databaseName: string): string {
  if (!/^[a-zA-Z0-9_]+$/.test(databaseName)) {
    throw new Error(`Refusing to use unsafe database name: ${databaseName}`);
  }
  return `"${databaseName}"`;
}

function getMaintenanceConnectionString(): string {
  // CREATE DATABASE / DROP DATABASE cannot run against the database being created/dropped,
  // so connect to the `postgres` maintenance database instead — same host/port/credentials
  // urls.ts already resolves, just with the database segment swapped.
  const { bootstrap } = getMossDatabaseUrls();
  return bootstrap.replace(/\/[^/]+$/, "/postgres");
}

async function ensureDatabaseExists(databaseName: string): Promise<void> {
  const client = new Client({ connectionString: getMaintenanceConnectionString() });
  await client.connect();
  try {
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      databaseName
    ]);
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE ${quoteDatabaseIdentifier(databaseName)}`);
    }
  } finally {
    await client.end();
  }
}

async function dropDatabaseIfExists(databaseName: string): Promise<void> {
  const client = new Client({ connectionString: getMaintenanceConnectionString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${quoteDatabaseIdentifier(databaseName)}`);
  } finally {
    await client.end();
  }
}

function runVitest(args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("vitest", ["run", ...args], {
      env: process.env,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`vitest exited with status ${code ?? "unknown"}`));
    });
  });
}

async function main(): Promise<void> {
  const entropySuffix = `${process.pid}_${randomBytes(4).toString("hex")}`;
  const plan = createDatabaseIsolationPlan(process.env, entropySuffix);

  if (plan.mode === "isolated") {
    await ensureDatabaseExists(plan.databaseName);
    // vitest.config.ts uses pool:"forks" + fileParallelism:false, so JARVIS_PGDATABASE must be
    // set in this parent process before the vitest child spawns (vitest inherits process.env at
    // spawn time) — mutating it from inside a per-file module would be too late.
  }
  process.env.JARVIS_PGDATABASE = plan.databaseName;
  process.env.JARVIS_TEST_MODULE_ROLE_SCOPE = plan.databaseName;

  try {
    await runVitest(resolveVitestArgs(process.argv.slice(2)));
  } finally {
    if (plan.mode === "isolated") {
      await dropDatabaseIfExists(plan.databaseName);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
