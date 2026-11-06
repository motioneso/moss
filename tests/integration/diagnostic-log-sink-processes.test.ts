import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// #3978 slice 2C: two real operating-system processes, each with its own canary secret, each
// emit one real warning. Both must land in the table, masked, with their owner.

const OWNER_API = "00000000-0000-4000-8000-000000003c01";
const OWNER_WORKER = "00000000-0000-4000-8000-000000003c02";
const CANARY_API = "API-CANARY-91357";
const CANARY_WORKER = "WORKER-CANARY-48210";
const child = resolve(import.meta.dirname, "helpers/log-sink-child.ts");
const tsx = resolve(import.meta.dirname, "../../node_modules/.bin/tsx");

let boot: pg.Client;

function run(kind: "api" | "worker", owner: string, canary: string) {
  return new Promise<{ code: number | null; out: string }>((done) => {
    const proc = spawn(tsx, [child, kind, owner, canary], { env: process.env });
    let out = "";
    proc.stdout.on("data", (d) => (out += String(d)));
    proc.stderr.on("data", (d) => (out += String(d)));
    proc.on("close", (code) => done({ code, out }));
  });
}

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  boot = new Client({ connectionString: connectionStrings.bootstrap });
  await boot.connect();
  await boot.query(
    `INSERT INTO app.users (id, email, name, status) VALUES
      ($1, 'sink-api@example.test', 'Sink Api', 'active'),
      ($2, 'sink-worker@example.test', 'Sink Worker', 'active')`,
    [OWNER_API, OWNER_WORKER]
  );
});

afterAll(async () => {
  await boot?.end();
});

describe("log sink across two processes", () => {
  it("stores an API warning and a worker warning, masked and owner-tagged", async () => {
    const [api, worker] = await Promise.all([
      run("api", OWNER_API, CANARY_API),
      run("worker", OWNER_WORKER, CANARY_WORKER)
    ]);
    expect(api.code, api.out).toBe(0);
    expect(worker.code, worker.out).toBe(0);
    expect(api.out).not.toContain(CANARY_API);
    expect(worker.out).not.toContain(CANARY_WORKER);

    const { rows } = await boot.query(
      `SELECT process, level, component, connection_kind, event_code, owner_user_id, message, context
       FROM app.diagnostic_log_records ORDER BY process`
    );
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(CANARY_API);
    expect(everything).not.toContain(CANARY_WORKER);
    const apiRow = rows.find((r) => r.process === "api");
    const workerRow = rows.find((r) => r.process === "worker");
    expect(apiRow).toMatchObject({
      component: "connectors",
      connection_kind: "google",
      event_code: "auth-failed",
      owner_user_id: OWNER_API
    });
    expect(apiRow.message).toContain("api warning");
    expect(workerRow).toMatchObject({
      component: "email",
      connection_kind: "imap",
      event_code: "sync-failed",
      owner_user_id: OWNER_WORKER
    });
    expect(workerRow.message).toContain("worker warning");
  }, 60_000);
});
