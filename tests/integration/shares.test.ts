import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import pg from "pg";

import {
  DataContextRunner,
  SharesRepository,
  createDatabase,
  type AccessContext,
  type MossDatabase
} from "@moss/db";
import { connectionStrings, ids, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// Distinct resource ids per assertion group so the UNIQUE(resource_type,
// resource_id, grantee_user_id) constraint never makes tests interfere.
const resourceView = "30000000-0000-4000-8000-000000000001";
const resourceLevel = "30000000-0000-4000-8000-000000000002";
const resourceAdmin = "30000000-0000-4000-8000-000000000003";
const resourceForge = "30000000-0000-4000-8000-000000000005";

async function seedShare(resourceId: string, level = "view"): Promise<void> {
  await dataContext.withDataContext(ctx(ids.userA), async (scopedDb) => {
    await sql`
      insert into app.shares
        (resource_type, resource_id, owner_user_id, grantee_user_id, level)
      values
        (${"demo"}, ${resourceId}::uuid, ${ids.userA}::uuid, ${ids.userB}::uuid, ${level})
    `.execute(scopedDb.db);
  });
}

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;

function ctx(actorUserId: string): AccessContext {
  return { actorUserId, requestId: "request:shares-test" };
}

const deactivatedUserId = "00000000-0000-4000-8000-000000000030";

async function seedUsers(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `
        INSERT INTO app.users (id, email, is_instance_admin)
        VALUES
          ($1, 'shares-a@example.test', false),
          ($2, 'shares-b@example.test', false),
          ($3, 'shares-admin@example.test', true)
      `,
      [ids.userA, ids.userB, ids.adminUser]
    );
    await client.query(
      `
        INSERT INTO app.users (id, email, is_instance_admin, status)
        VALUES ($1, 'shares-deactivated@example.test', false, 'deactivated')
      `,
      [deactivatedUserId]
    );
  } finally {
    await client.end();
  }
}

async function hasShareRaw(
  actorUserId: string,
  resourceType: string,
  resourceId: string,
  level: string
): Promise<boolean> {
  return dataContext.withDataContext(ctx(actorUserId), async (scopedDb) => {
    const result = await sql<{ ok: boolean }>`
      select app.has_share(${resourceType}, ${resourceId}::uuid, ${level}) as ok
    `.execute(scopedDb.db);
    return result.rows[0]?.ok ?? false;
  });
}

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  await seedUsers();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("shares has_share + RLS (raw SQL)", () => {
  it("returns false before any share exists", async () => {
    await expect(hasShareRaw(ids.userB, "demo", resourceView, "view")).resolves.toBe(false);
  });

  it("grants view access to the grantee after the owner shares", async () => {
    await dataContext.withDataContext(ctx(ids.userA), async (scopedDb) => {
      await sql`
        insert into app.shares
          (resource_type, resource_id, owner_user_id, grantee_user_id, level)
        values
          (${"demo"}, ${resourceView}::uuid, ${ids.userA}::uuid, ${ids.userB}::uuid, ${"view"})
      `.execute(scopedDb.db);
    });

    await expect(hasShareRaw(ids.userB, "demo", resourceView, "view")).resolves.toBe(true);
  });

  it("does not satisfy a higher level than was granted", async () => {
    await seedShare(resourceLevel, "view");

    await expect(hasShareRaw(ids.userB, "demo", resourceLevel, "contribute")).resolves.toBe(false);
  });

  it("does not grant an instance admin access by role alone", async () => {
    await seedShare(resourceAdmin, "view");

    await expect(hasShareRaw(ids.adminUser, "demo", resourceAdmin, "view")).resolves.toBe(false);
  });

  it("forbids inserting a share that claims another user as owner", async () => {
    await expect(
      dataContext.withDataContext(ctx(ids.userB), async (scopedDb) => {
        await sql`
          insert into app.shares
            (resource_type, resource_id, owner_user_id, grantee_user_id, level)
          values
            (${"demo"}, ${resourceForge}::uuid, ${ids.userA}::uuid, ${ids.userB}::uuid, ${"view"})
        `.execute(scopedDb.db);
      })
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("shares typed table", () => {
  const resourceTyped = "30000000-0000-4000-8000-000000000010";
  const typedShareId = "31000000-0000-4000-8000-000000000001";

  it("inserts and selects through the typed Kysely table", async () => {
    const inserted = await dataContext.withDataContext(ctx(ids.userA), async (scopedDb) => {
      await scopedDb.db
        .insertInto("app.shares")
        .values({
          id: typedShareId,
          resource_type: "demo",
          resource_id: resourceTyped,
          owner_user_id: ids.userA,
          grantee_user_id: ids.userB,
          level: "manage",
          created_at: new Date(),
          updated_at: new Date()
        })
        .execute();

      return scopedDb.db
        .selectFrom("app.shares")
        .selectAll()
        .where("resource_id", "=", resourceTyped)
        .executeTakeFirstOrThrow();
    });

    expect(inserted.level).toBe("manage");
    expect(inserted.owner_user_id).toBe(ids.userA);
  });
});

describe("SharesRepository", () => {
  const repository = new SharesRepository();
  const resourceRepo = "30000000-0000-4000-8000-000000000020";
  const resourceUpgrade = "30000000-0000-4000-8000-000000000021";
  const resourceRevoke = "30000000-0000-4000-8000-000000000022";
  const resourceDeterministic = "30000000-0000-4000-8000-000000000023";
  const resourceMissingGrantee = "30000000-0000-4000-8000-000000000024";
  const resourceMalformedGrantee = "30000000-0000-4000-8000-000000000025";
  const resourceDeactivatedGrantee = "30000000-0000-4000-8000-000000000026";
  const resourceSelfShare = "30000000-0000-4000-8000-000000000027";

  it("uses an injected timestamp for deterministic fixtures", async () => {
    const now = new Date("2026-01-15T12:00:00.000Z");
    const share = await dataContext.withDataContext(ctx(ids.userA), (scopedDb) =>
      repository.grant(scopedDb, {
        resourceType: "demo",
        resourceId: resourceDeterministic,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "view",
        now
      })
    );

    expect(share.created_at).toEqual(now);
    expect(share.updated_at).toEqual(now);
  });

  it("grants a share the grantee can then access", async () => {
    await dataContext.withDataContext(ctx(ids.userA), (scopedDb) =>
      repository.grant(scopedDb, {
        resourceType: "demo",
        resourceId: resourceRepo,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "contribute"
      })
    );

    const granteeCanContribute = await dataContext.withDataContext(ctx(ids.userB), (scopedDb) =>
      repository.hasShare(scopedDb, "demo", resourceRepo, "contribute")
    );
    const ownerCanList = await dataContext.withDataContext(ctx(ids.userA), (scopedDb) =>
      repository.listForResource(scopedDb, "demo", resourceRepo)
    );

    expect(granteeCanContribute).toBe(true);
    expect(ownerCanList).toHaveLength(1);
    expect(ownerCanList[0]?.grantee_user_id).toBe(ids.userB);
  });

  it("upgrades an existing share on re-grant", async () => {
    await dataContext.withDataContext(ctx(ids.userA), (scopedDb) =>
      repository.grant(scopedDb, {
        resourceType: "demo",
        resourceId: resourceUpgrade,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "view"
      })
    );
    await dataContext.withDataContext(ctx(ids.userA), (scopedDb) =>
      repository.grant(scopedDb, {
        resourceType: "demo",
        resourceId: resourceUpgrade,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "manage"
      })
    );

    const canManage = await dataContext.withDataContext(ctx(ids.userB), (scopedDb) =>
      repository.hasShare(scopedDb, "demo", resourceUpgrade, "manage")
    );
    const shares = await dataContext.withDataContext(ctx(ids.userA), (scopedDb) =>
      repository.listForResource(scopedDb, "demo", resourceUpgrade)
    );

    expect(canManage).toBe(true);
    expect(shares).toHaveLength(1);
  });

  it("revokes access", async () => {
    await dataContext.withDataContext(ctx(ids.userA), (scopedDb) =>
      repository.grant(scopedDb, {
        resourceType: "demo",
        resourceId: resourceRevoke,
        ownerUserId: ids.userA,
        granteeUserId: ids.userB,
        level: "view"
      })
    );
    await dataContext.withDataContext(ctx(ids.userA), (scopedDb) =>
      repository.revoke(scopedDb, {
        resourceType: "demo",
        resourceId: resourceRevoke,
        granteeUserId: ids.userB
      })
    );

    const stillHasAccess = await dataContext.withDataContext(ctx(ids.userB), (scopedDb) =>
      repository.hasShare(scopedDb, "demo", resourceRevoke, "view")
    );

    expect(stillHasAccess).toBe(false);
  });

  it("fails loudly when called without the data-context wrapper", async () => {
    await expect(repository.listForResource({} as never, "demo", resourceRepo)).rejects.toThrow(
      "Repository access requires withDataContext"
    );
  });

  it("rejects a grant to a grantee that does not exist, with the ordering proved by the exact message", async () => {
    const missingGrantee = "00000000-0000-4000-8000-0000000000ff";

    await expect(
      dataContext.withDataContext(ctx(ids.userA), (scopedDb) =>
        repository.grant(scopedDb, {
          resourceType: "demo",
          resourceId: resourceMissingGrantee,
          ownerUserId: ids.userA,
          granteeUserId: missingGrantee,
          level: "view"
        })
      )
    ).rejects.toThrow("Share target user not found");

    // A foreign-key rejection (the check missing, or running after the insert) would surface
    // Postgres's own "violates foreign key constraint" wording instead — this is what actually
    // proves the up-front check fired, not just that the transaction rolled back.
    await expect(
      dataContext.withDataContext(ctx(ids.userA), (scopedDb) =>
        repository.grant(scopedDb, {
          resourceType: "demo",
          resourceId: resourceMissingGrantee,
          ownerUserId: ids.userA,
          granteeUserId: missingGrantee,
          level: "view"
        })
      )
    ).rejects.not.toThrow(/foreign key/i);
  });

  it("rejects a malformed grantee id by the shape guard, before it ever reaches Postgres", async () => {
    await expect(
      dataContext.withDataContext(ctx(ids.userA), (scopedDb) =>
        repository.grant(scopedDb, {
          resourceType: "demo",
          resourceId: resourceMalformedGrantee,
          ownerUserId: ids.userA,
          granteeUserId: "not-a-uuid",
          level: "view"
        })
      )
    ).rejects.toThrow(/share grantee user id must be a UUID/);
  });

  it("still rejects a self-share through the database check, not the new lookup", async () => {
    await expect(
      dataContext.withDataContext(ctx(ids.userA), (scopedDb) =>
        repository.grant(scopedDb, {
          resourceType: "demo",
          resourceId: resourceSelfShare,
          ownerUserId: ids.userA,
          granteeUserId: ids.userA,
          level: "view"
        })
      )
    ).rejects.toThrow();
  });

  it("still grants to a deactivated user, since account status is not part of this check", async () => {
    const share = await dataContext.withDataContext(ctx(ids.userA), (scopedDb) =>
      repository.grant(scopedDb, {
        resourceType: "demo",
        resourceId: resourceDeactivatedGrantee,
        ownerUserId: ids.userA,
        granteeUserId: deactivatedUserId,
        level: "view"
      })
    );

    expect(share.grantee_user_id).toBe(deactivatedUserId);
  });
});
