// #1890: deleteExternalModuleDraft's own decisions — which rows the statement is allowed to
// match, and the audit event it writes. The database's own row-level security only narrows
// deleting to instance admins; the owner-only and draft-only guarantees are the two extra
// conditions on this statement, so they are what this test pins down. Drop either one and one
// admin can delete another admin's draft, or a shipped module. Uses a fake database in the same
// style as repository-external-modules-draft.test.ts.
import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { deleteExternalModuleDraft } from "../../packages/settings/src/repository-external-modules.js";

interface Captured {
  table?: string;
  where: Array<[string, string, unknown]>;
}

function fakeScopedDb(captured: Captured, numDeletedRows: bigint): DataContextDb {
  const chain = {
    where: (column: string, op: string, value: unknown) => {
      captured.where.push([column, op, value]);
      return chain;
    },
    executeTakeFirst: async () => ({ numDeletedRows })
  };
  const db = {
    deleteFrom: (table: string) => {
      captured.table = table;
      return chain;
    }
  };
  return { db, [dataContextBrand]: true } as unknown as DataContextDb;
}

describe("deleteExternalModuleDraft", () => {
  it("only matches a draft row owned by the actor, and audits the delete", async () => {
    const captured: Captured = { where: [] };
    const scopedDb = fakeScopedDb(captured, 1n);
    const audited: unknown[] = [];

    const deleted = await deleteExternalModuleDraft(
      scopedDb,
      { id: "videos", actorUserId: "user-a", requestId: "req-1" },
      async (event) => {
        audited.push(event);
      }
    );

    expect(deleted).toBe(true);
    expect(captured.table).toBe("app.external_modules");
    expect(captured.where).toEqual([
      ["id", "=", "videos"],
      ["status", "=", "draft"],
      ["owner_user_id", "=", "user-a"]
    ]);
    expect(audited).toEqual([
      {
        actorUserId: "user-a",
        action: "module.external_draft_delete",
        targetType: "module",
        targetId: "videos",
        metadata: { moduleId: "videos" },
        requestId: "req-1"
      }
    ]);
  });

  it("reports nothing deleted, and writes no audit event, when no row matched", async () => {
    const captured: Captured = { where: [] };
    const scopedDb = fakeScopedDb(captured, 0n);
    const audited: unknown[] = [];

    const deleted = await deleteExternalModuleDraft(
      scopedDb,
      { id: "someone-elses", actorUserId: "user-a", requestId: "req-1" },
      async (event) => {
        audited.push(event);
      }
    );

    expect(deleted).toBe(false);
    expect(audited).toEqual([]);
  });
});
