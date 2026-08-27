// #1975: cancelModuleBuild's own decisions — which rows the statement is allowed to match. The
// database's row-level security only narrows this to the owning user; the status filter (only a
// build still "planning" or "building" can be cancelled) is the extra condition this test pins
// down. Drop it and a finished build could be flipped back to "cancelled" after the fact. Same
// fake-database style as repository-external-modules-throw-away.test.ts.
import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { cancelModuleBuild } from "../../packages/settings/src/module-builds-repository.js";

interface Captured {
  table?: string;
  where: Array<[string, string, unknown]>;
}

function fakeScopedDb(captured: Captured, numUpdatedRows: bigint): DataContextDb {
  const chain = {
    set: () => chain,
    where: (column: string, op: string, value: unknown) => {
      captured.where.push([column, op, value]);
      return chain;
    },
    executeTakeFirst: async () => ({ numUpdatedRows })
  };
  const db = {
    updateTable: (table: string) => {
      captured.table = table;
      return chain;
    }
  };
  return { db, [dataContextBrand]: true } as unknown as DataContextDb;
}

describe("cancelModuleBuild", () => {
  it("cancels a build owned by the caller that is still planning or building", async () => {
    const captured: Captured = { where: [] };
    const scopedDb = fakeScopedDb(captured, 1n);

    const cancelled = await cancelModuleBuild(scopedDb, "b1", "user-a");

    expect(cancelled).toBe(true);
    expect(captured.table).toBe("app.module_builds");
    expect(captured.where).toEqual([
      ["id", "=", "b1"],
      ["owner_user_id", "=", "user-a"],
      ["status", "in", ["planning", "building"]]
    ]);
  });

  it("reports nothing cancelled when no row matched (wrong owner or wrong status)", async () => {
    const captured: Captured = { where: [] };
    const scopedDb = fakeScopedDb(captured, 0n);

    const cancelled = await cancelModuleBuild(scopedDb, "b1", "user-a");

    expect(cancelled).toBe(false);
  });
});
