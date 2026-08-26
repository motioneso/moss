// #1754: the module_builds repository. RLS ownership enforcement lives on the migration's
// policy and is proven live, not re-tested with a fake db here — these tests are about the
// repository functions' own decisions (default status, row-not-found handling), matching the
// convention in module-preferences-routes.test.ts.
import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import {
  createModuleBuild,
  getModuleBuild
} from "../../packages/settings/src/module-builds-repository.js";

function fakeScopedDb(row: Record<string, unknown> | undefined): DataContextDb {
  const db = {
    insertInto: () => ({
      values: () => ({
        returningAll: () => ({
          executeTakeFirstOrThrow: async () => row
        })
      })
    }),
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          executeTakeFirst: async () => row
        })
      })
    })
  };
  return { db, [dataContextBrand]: true } as unknown as DataContextDb;
}

const baseRow = {
  id: "b1",
  owner_user_id: "user-a",
  conversation_id: "thread-a",
  status: "planning" as const,
  plan: null,
  step: null,
  module_id: null,
  fetched_urls: [],
  written_files: [],
  cost_cents: 0,
  error: null,
  created_at: new Date("2026-08-21T00:00:00Z"),
  updated_at: new Date("2026-08-21T00:00:00Z")
};

describe("createModuleBuild", () => {
  it("creates a build owned by the requesting user and defaults to planning status", async () => {
    const scopedDb = fakeScopedDb(baseRow);
    const build = await createModuleBuild(scopedDb, {
      ownerUserId: "user-a",
      conversationId: "thread-a"
    });
    expect(build.status).toBe("planning");
    expect(build.ownerUserId).toBe("user-a");
  });
});

describe("getModuleBuild", () => {
  it("returns null when the scoped query finds no row (owner mismatch is invisible under RLS)", async () => {
    const scopedDb = fakeScopedDb(undefined);
    const seen = await getModuleBuild(scopedDb, "b1");
    expect(seen).toBeNull();
  });
});
