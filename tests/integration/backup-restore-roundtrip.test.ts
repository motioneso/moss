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

import { assertContainerMatchesConnection } from "../../scripts/postgres-container.js";
import { createBackupPlan } from "../../scripts/backup-database.js";
import { createRestorePlan } from "../../scripts/restore-database.js";
import { createDatabase } from "@moss/db";
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

  it("refuses a container that runs a separate copy of the cluster", async () => {
    // A base backup copied into a second server keeps the system identifier and database names.
    const copy = `moss-3199-copy-${process.pid}`;
    const sh = (args: string[]) => execFileAsync("docker", args, { maxBuffer: 256 * 1024 * 1024 });
    const bootstrap = new URL(bootstrapUrl);
    const user = decodeURIComponent(bootstrap.username);
    const password = decodeURIComponent(bootstrap.password);
    const database = bootstrap.pathname.slice(1);
    const psql = async (c: string, command: string) =>
      (
        await sh([
          "exec",
          "--env",
          `PGPASSWORD=${password}`,
          c,
          "psql",
          "-U",
          user,
          "-d",
          database,
          "-At",
          "-c",
          command
        ])
      ).stdout.trim();
    const db = createDatabase({ connectionString: bootstrapUrl });

    try {
      const image = (
        await sh(["inspect", "--format", "{{.Config.Image}}", container])
      ).stdout.trim();
      await sh(["exec", "-u", "postgres", container, "rm", "-rf", "/tmp/copy3199"]);
      await sh([
        "exec",
        "-u",
        "postgres",
        container,
        "pg_basebackup",
        "-D",
        "/tmp/copy3199",
        "-X",
        "fetch",
        "--checkpoint=fast",
        "-U",
        user
      ]);
      await sh([
        "create",
        "--name",
        copy,
        "-e",
        "PGDATA=/var/lib/postgresql/copy3199",
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        image
      ]);
      await new Promise<void>((resolve, reject) => {
        const packer = execFile(
          "docker",
          ["exec", container, "tar", "-C", "/tmp", "-cf", "-", "copy3199"],
          { encoding: "buffer", maxBuffer: 512 * 1024 * 1024 },
          (error, tar) => {
            if (error) return reject(error);
            const unpacker = execFile("docker", ["cp", "-", `${copy}:/var/lib/postgresql/`], (e) =>
              e ? reject(e) : resolve()
            );
            unpacker.stdin?.end(tar);
          }
        );
        void packer;
      });
      await sh(["start", copy]);
      for (let i = 0; i < 60; i += 1) {
        const ready = await sh(["exec", copy, "pg_isready", "-U", user]).then(
          () => true,
          () => false
        );
        if (ready) break;
        await new Promise((r) => setTimeout(r, 1000));
      }

      // Same system identifier and database name: the old identity comparison could not tell them apart.
      const control = "SELECT system_identifier FROM pg_control_system()";
      expect(await psql(copy, control)).toBe(await psql(container, control));

      const target = (name: string) => ({ container: name, database, username: user, password });

      await expect(
        assertContainerMatchesConnection(db, target(container))
      ).resolves.toBeUndefined();
      await expect(assertContainerMatchesConnection(db, target(copy))).rejects.toThrow(
        /does not reach the Postgres server/
      );
    } finally {
      await db.destroy();
      await sh(["rm", "-f", copy]).catch(() => undefined);
      await sh(["exec", container, "rm", "-rf", "/tmp/copy3199"]).catch(() => undefined);
    }
  }, 180_000);
});
