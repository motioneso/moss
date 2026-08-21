// #1754: setExternalModuleDraft's own decisions (row shape, audit action) — RLS enforcement
// (current_actor_is_admin() on INSERT/UPDATE) lives on the migration's policy and is proven
// live elsewhere, not re-tested with a fake db here, matching module-builds-repository.test.ts.
import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { setExternalModuleDraft } from "../../packages/settings/src/repository-external-modules.js";

function fakeScopedDb(captured: { values?: unknown }): DataContextDb {
  const db = {
    insertInto: () => ({
      values: (v: unknown) => {
        captured.values = v;
        return {
          onConflict: (build: (oc: unknown) => unknown) => {
            build({ column: () => ({ doUpdateSet: (u: unknown) => u }) });
            return { execute: async () => undefined };
          }
        };
      }
    })
  };
  return { db, [dataContextBrand]: true } as unknown as DataContextDb;
}

describe("setExternalModuleDraft", () => {
  it("writes a draft row owned by the builder and a metadata-only audit event", async () => {
    const captured: { values?: unknown } = {};
    const scopedDb = fakeScopedDb(captured);
    const audited: unknown[] = [];

    await setExternalModuleDraft(
      scopedDb,
      {
        id: "videos",
        manifestHash: "sha256:m",
        packageHash: "sha256:p",
        ownerUserId: "user-a",
        actorUserId: "user-a",
        requestId: "req-1"
      },
      async (event) => {
        audited.push(event);
      }
    );

    expect(captured.values).toMatchObject({
      id: "videos",
      status: "draft",
      manifest_hash: "sha256:m",
      package_hash: "sha256:p",
      owner_user_id: "user-a",
      enabled_by: null,
      enabled_at: null
    });
    expect(audited).toEqual([
      {
        actorUserId: "user-a",
        action: "module.external_install_draft",
        targetType: "module",
        targetId: "videos",
        metadata: { moduleId: "videos" },
        requestId: "req-1"
      }
    ]);
  });
});
