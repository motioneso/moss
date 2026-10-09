import { Client } from "pg";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDatabase, type MossDatabase } from "@moss/db";
import { handleUpgradeCheckJob, UPGRADE_NOTIFY_QUEUE } from "@moss/jobs";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const ownerId = "00000000-0000-4000-8000-0000000000a1";

let worker: Kysely<MossDatabase>;
let bootstrap: Client;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  await bootstrap.query(
    `INSERT INTO app.users (id, email, name, is_instance_admin, is_bootstrap_owner, status)
     VALUES ($1, 'upgrade-owner@example.test', 'Upgrade Owner', true, true, 'active')`,
    [ownerId]
  );
  worker = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 1 });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  delete process.env.JARVIS_APP_VERSION;
  await worker?.destroy();
  await bootstrap?.end();
});

describe("upgrade check as the worker role", () => {
  it("saves the latest release and queues the owner notice", async () => {
    process.env.JARVIS_APP_VERSION = "1.0.0";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ tag_name: "v1.1.0", body: "Release notes" })
      }))
    );
    const boss = { send: vi.fn(async () => "job-id") };

    await handleUpgradeCheckJob(worker, boss as never);

    const rows = await sql<{ value: { version: string; notes: string } }>`
      SELECT value FROM app.instance_settings WHERE key = 'latest_release'
    `.execute(worker);
    expect(rows.rows[0]?.value.version).toBe("v1.1.0");
    expect(boss.send).toHaveBeenCalledWith(
      UPGRADE_NOTIFY_QUEUE,
      expect.objectContaining({ actorUserId: ownerId, version: "v1.1.0" }),
      expect.anything()
    );
  });
});
