// #2267: the module_kv_worker_owner_draft policy (packages/settings/sql/0226) is the one row
// that lets a draft's own owner persist storage from the worker role. This suite proves the
// policy itself refuses everything it isn't meant to allow, at the database layer, independent
// of anything the RPC host or job handler check above it. See external-module-draft-invoke.test.ts
// for the worker's own invocation gate, and module-worker-queue-ai.test.ts for the positive,
// end-to-end owner-draft-write path.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;
let bootstrap: pg.Client;

const OWNED_BY_USER = "acme-owner-draft-user";
const OWNED_BY_ADMIN = "acme-owner-draft-admin";

beforeAll(async () => {
  await resetFoundationDatabase();
  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  await bootstrap.query(
    `INSERT INTO app.external_modules (id, status, owner_user_id, manifest_hash, package_hash)
     VALUES
       ($1, 'draft', $3, 'sha256:a', 'sha256:a'),
       ($2, 'draft', $4, 'sha256:a', 'sha256:a')`,
    [OWNED_BY_USER, OWNED_BY_ADMIN, ids.userA, ids.adminUser]
  );
});

afterAll(async () => {
  await bootstrap?.end();
});

async function attemptWorkerInsert(args: {
  actorUserId: string;
  moduleId: string;
  scope: "user" | "instance";
  ownerUserId: string | null;
}): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.worker });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_user_id', $1, true)", [args.actorUserId]);
    await client.query("SELECT set_config('app.current_module_id', $1, true)", [args.moduleId]);
    await client.query(
      `INSERT INTO app.module_kv (module_id, namespace, scope, owner_user_id, key, value)
       VALUES ($1, 'acme.state', $2, $3, 'k', '{}'::jsonb)`,
      [args.moduleId, args.scope, args.ownerUserId]
    );
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
}

describe("module_kv_worker_owner_draft policy (#2267)", () => {
  it("lets an administrator persist a user-scope row on their own draft", async () => {
    // Positive control: proves the rejections below are the policy discriminating on scope
    // and admin status, not a fixture mistake that would fail every case the same way.
    await expect(
      attemptWorkerInsert({
        actorUserId: ids.adminUser,
        moduleId: OWNED_BY_ADMIN,
        scope: "user",
        ownerUserId: ids.adminUser
      })
    ).resolves.toBeUndefined();
  });

  it("refuses a user-scope save from a draft's owner who is not an administrator", async () => {
    // ids.userA is seeded with is_instance_admin = false. Today only administrators can
    // create a draft, so this actor/ownership combination cannot occur through the product —
    // but the policy is a second, independent layer and must fail closed on its own, which is
    // exactly the disagreement between the worker's invocation gate and this storage rule.
    await expect(
      attemptWorkerInsert({
        actorUserId: ids.userA,
        moduleId: OWNED_BY_USER,
        scope: "user",
        ownerUserId: ids.userA
      })
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses an instance-wide save from a draft, even from an administrator owner", async () => {
    await expect(
      attemptWorkerInsert({
        actorUserId: ids.adminUser,
        moduleId: OWNED_BY_ADMIN,
        scope: "instance",
        ownerUserId: null
      })
    ).rejects.toThrow(/row-level security/);
  });
});
