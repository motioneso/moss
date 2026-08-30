import { randomUUID } from "node:crypto";

import { sql } from "kysely";

import type { DataContextDb } from "../data-context.js";
import { assertDataContextDb, assertUuid } from "../data-context.js";
import type { Share, ShareLevel } from "../types.js";

export interface GrantShareInput {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly ownerUserId: string;
  readonly granteeUserId: string;
  readonly level: ShareLevel;
  readonly now?: Date;
}

export interface RevokeShareInput {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly granteeUserId: string;
}

export class SharesRepository {
  async grant(scopedDb: DataContextDb, input: GrantShareInput): Promise<Share> {
    assertDataContextDb(scopedDb);
    assertUuid(input.granteeUserId, "share grantee user id");

    const granteeResult = await sql<{ id: string }>`
      SELECT id FROM app.get_user_by_id(${input.granteeUserId}::uuid)
    `.execute(scopedDb.db);

    if (!granteeResult.rows[0]) {
      throw new Error("Share target user not found");
    }

    const now = input.now ?? new Date();

    return scopedDb.db
      .insertInto("app.shares")
      .values({
        id: randomUUID(),
        resource_type: input.resourceType,
        resource_id: input.resourceId,
        owner_user_id: input.ownerUserId,
        grantee_user_id: input.granteeUserId,
        level: input.level,
        created_at: now,
        updated_at: now
      })
      .onConflict((oc) =>
        oc.columns(["resource_type", "resource_id", "grantee_user_id"]).doUpdateSet({
          level: input.level,
          updated_at: now
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async listForResource(
    scopedDb: DataContextDb,
    resourceType: string,
    resourceId: string
  ): Promise<Share[]> {
    assertDataContextDb(scopedDb);

    return scopedDb.db
      .selectFrom("app.shares")
      .selectAll()
      .where("resource_type", "=", resourceType)
      .where("resource_id", "=", resourceId)
      .orderBy("created_at")
      .execute();
  }

  async revoke(scopedDb: DataContextDb, input: RevokeShareInput): Promise<void> {
    assertDataContextDb(scopedDb);

    await scopedDb.db
      .deleteFrom("app.shares")
      .where("resource_type", "=", input.resourceType)
      .where("resource_id", "=", input.resourceId)
      .where("grantee_user_id", "=", input.granteeUserId)
      .execute();
  }

  async hasShare(
    scopedDb: DataContextDb,
    resourceType: string,
    resourceId: string,
    level: ShareLevel
  ): Promise<boolean> {
    assertDataContextDb(scopedDb);

    const result = await sql<{ ok: boolean }>`
      select app.has_share(${resourceType}, ${resourceId}::uuid, ${level}) as ok
    `.execute(scopedDb.db);

    return result.rows[0]?.ok ?? false;
  }
}
