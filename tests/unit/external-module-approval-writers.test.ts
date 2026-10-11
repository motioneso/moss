import { describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import {
  listExternalModuleStates,
  markExternalModuleRemoved,
  setExternalModuleDraft,
  setExternalModuleEnabled,
  shipExternalModule,
  updateExternalModuleStaging,
  writeExternalModuleDisabledRow
} from "../../packages/settings/src/repository-external-modules.js";

function captureDb() {
  const writes: Record<string, unknown>[] = [];
  const selected: string[][] = [];
  const predicates: unknown[][] = [];
  const chain = {
    values: (row: Record<string, unknown>) => {
      writes.push(row);
      return chain;
    },
    set: (row: Record<string, unknown>) => {
      writes.push(row);
      return chain;
    },
    onConflict: (build: (oc: unknown) => unknown) => {
      build({
        column: () => ({ doUpdateSet: (row: Record<string, unknown>) => writes.push(row) })
      });
      return chain;
    },
    select: (columns: string[]) => {
      selected.push(columns);
      return chain;
    },
    where: (...args: unknown[]) => {
      predicates.push(args);
      return chain;
    },
    orderBy: () => chain,
    execute: async () => [
      {
        id: "demo",
        status: "enabled",
        package_hash: "package",
        manifest_hash: "manifest",
        descriptor_approved_by: "actor",
        disabled_reason: null,
        owner_user_id: null
      }
    ],
    executeTakeFirst: async () => ({ numUpdatedRows: 1n })
  };
  const db = { insertInto: () => chain, updateTable: () => chain, selectFrom: () => chain };
  return {
    scopedDb: { db, [dataContextBrand]: true } as unknown as DataContextDb,
    writes,
    selected,
    predicates
  };
}
const input = {
  id: "demo",
  manifestHash: "manifest",
  packageHash: "package",
  actorUserId: "actor",
  requestId: "req"
};

describe("add-on approval repository writes", () => {
  it("current-hash instance-admin enable accepts the installation on insert and reapproval", async () => {
    // The admin /api/admin/external-modules/:id endpoint supplies discovery hashes.
    // /api/me/modules changes deny rows and never invokes this acceptance writer.
    const { scopedDb, writes } = captureDb();
    await setExternalModuleEnabled(scopedDb, input, vi.fn());
    expect(writes).toHaveLength(2);
    for (const row of writes)
      expect(row).toMatchObject({
        manifest_hash: "manifest",
        package_hash: "package",
        descriptor_approved_by: "actor"
      });
  });

  it("draft shipping attributes the accepted hashes to the shipping owner", async () => {
    const { scopedDb, writes, predicates } = captureDb();
    expect(await shipExternalModule(scopedDb, input, vi.fn())).toBe(true);
    expect(writes[0]).toMatchObject({
      manifest_hash: "manifest",
      package_hash: "package",
      descriptor_approved_by: "actor"
    });
    expect(predicates).toContainEqual(["owner_user_id", "=", "actor"]);
    expect(predicates).toContainEqual(["status", "=", "draft"]);
  });

  it("draft creation clears any prior acceptance on both insert and replacement", async () => {
    const { scopedDb, writes } = captureDb();
    await setExternalModuleDraft(scopedDb, { ...input, ownerUserId: "actor" }, vi.fn());
    expect(writes).toHaveLength(2);
    for (const row of writes) expect(row.descriptor_approved_by).toBeNull();
  });

  it.each(["module.external_disable", "module.external_auto_disable"] as const)(
    "%s clears acceptance",
    async (action) => {
      const { scopedDb, writes } = captureDb();
      await writeExternalModuleDisabledRow(
        scopedDb,
        { ...input, reason: "disabled" },
        action,
        vi.fn()
      );
      expect(writes).toHaveLength(2);
      for (const row of writes) expect(row.descriptor_approved_by).toBeNull();
    }
  );

  it("removal clears acceptance", async () => {
    const { scopedDb, writes } = captureDb();
    await markExternalModuleRemoved(scopedDb, input, vi.fn());
    expect(writes[0]?.descriptor_approved_by).toBeNull();
  });

  it("staging records the downloader without granting approval before acceptance", async () => {
    const { scopedDb, writes } = captureDb();
    await updateExternalModuleStaging(
      scopedDb,
      { ...input, stagedVersion: "2", stagedPackageHash: "new-package" },
      vi.fn()
    );
    expect(writes[0]).toMatchObject({ staged_by: "actor", descriptor_approved_by: null });
    expect(writes[1]).toMatchObject({ staged_by: "actor" });
    expect(writes[1]).not.toHaveProperty("descriptor_approved_by");
    expect(writes[1]).not.toHaveProperty("manifest_hash");
  });

  it("reads the actual accepted-hash and approval columns into runtime state", async () => {
    const { scopedDb, selected } = captureDb();
    expect(await listExternalModuleStates(scopedDb)).toEqual([
      {
        id: "demo",
        status: "enabled",
        packageHash: "package",
        manifestHash: "manifest",
        descriptorApprovedByUserId: "actor",
        disabledReason: null,
        ownerUserId: null
      }
    ]);
    expect(selected[0]).toEqual(
      expect.arrayContaining(["manifest_hash", "descriptor_approved_by"])
    );
  });
});
