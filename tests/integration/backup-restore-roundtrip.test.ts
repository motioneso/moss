// #3199: a backup restored by scripts/restore-database.ts must keep ownership and grants, so the
// app runtime role can read its rows under RLS. Runs through the gate's throwaway Postgres
// container (found by its published port); never point it at the shared dev database.
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { createBackupPlan } from "../../scripts/backup-database.js";
import { createRestorePlan } from "../../scripts/restore-database.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;
const execFileAsync = promisify(execFile);

const RESTORED_DB = "restoretest_3199";

function withDatabase(url: string, database: string): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
}

function findGateContainer(port: string): string {
  const result = spawnSync("docker", [
    "ps",
    "--filter",
    `publish=${port}`,
    "--format",
    "{{.Names}}"
  ]);
  const name = result.stdout.toString().trim().split("\n")[0];
  if (!name) throw new Error(`No container publishes port ${port}`);
  return name;
}

async function pipeToFile(args: readonly string[], env: Record<string, string>, file: string) {
  const { stdout } = await execFileAsync("docker", [...args], {
    env: { ...process.env, ...env },
    encoding: "buffer",
    maxBuffer: 256 * 1024 * 1024
  });
  await writeFile(file, stdout);
}

async function pipeFromFile(args: readonly string[], env: Record<string, string>, file: string) {
  const data = await readFile(file);
  await new Promise<void>((resolve, reject) => {
    const child = execFile("docker", [...args], { env: { ...process.env, ...env } }, (error) =>
      error ? reject(error) : resolve()
    );
    child.stdin?.end(data);
  });
}

async function query<T extends pg.QueryResultRow>(
  url: string,
  text: string,
  values: unknown[] = []
) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

describe("backup and restore round trip", () => {
  const bootstrapUrl = connectionStrings.bootstrap;
  const port = new URL(bootstrapUrl).port;
  let container = "";
  let workDir = "";

  beforeAll(async () => {
    await resetFoundationDatabase();
    container = findGateContainer(port);
    workDir = await mkdtemp(join(tmpdir(), "moss-3199-"));
    await query(bootstrapUrl, `DROP DATABASE IF EXISTS ${RESTORED_DB}`);
    await query(bootstrapUrl, `CREATE DATABASE ${RESTORED_DB}`);
  }, 120_000);

  afterAll(async () => {
    await query(bootstrapUrl, `DROP DATABASE IF EXISTS ${RESTORED_DB}`);
    await rm(workDir, { recursive: true, force: true });
  });

  it("restores a database the app runtime role can read under RLS, with owners intact", async () => {
    const dumpFile = join(workDir, "db.dump");
    const backup = createBackupPlan({ connectionString: bootstrapUrl, container });
    await pipeToFile(backup.dockerArgs, backup.env, dumpFile);

    const restoredBootstrap = withDatabase(bootstrapUrl, RESTORED_DB);
    const restore = createRestorePlan({
      backupFile: dumpFile,
      confirmDatabase: RESTORED_DB,
      confirmRestore: true,
      connectionString: restoredBootstrap,
      container,
      execute: true
    });
    await pipeFromFile(restore.restoreArgs, restore.env, dumpFile);

    const owners = `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app' ORDER BY p.proname`;
    expect(await query(restoredBootstrap, owners)).toEqual(await query(bootstrapUrl, owners));

    const appUrl = withDatabase(connectionStrings.app, RESTORED_DB);
    const client = new Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.actor_user_id', $1, true)", [ids.userA]);
      const rows = await client.query<{ owner_user_id: string }>(
        "SELECT owner_user_id FROM app.rls_probe_items"
      );
      await client.query("ROLLBACK");

      expect(rows.rows.length).toBeGreaterThan(0);
      expect(new Set(rows.rows.map((r) => r.owner_user_id))).toEqual(new Set([ids.userA]));
    } finally {
      await client.end();
    }
  }, 180_000);
});
