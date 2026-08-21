import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";

import { SettingsRepository } from "../../packages/settings/src/repository.js";
import { connectionStrings, ids } from "./test-database.js";

describe("SettingsRepository external-module state (app.external_modules, #917)", () => {
  let appDb: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  let repo: SettingsRepository;

  beforeAll(async () => {
    // Seeds userA, userB, adminUser.
    const { resetFoundationDatabase } = await import("./test-database.js");
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    runner = new DataContextRunner(appDb);
    repo = new SettingsRepository();
  });

  afterAll(async () => {
    await appDb.destroy();
  });

  it("admin can enable, then disable, an external module (audit written each time)", async () => {
    await runner.withDataContext({ actorUserId: ids.adminUser, requestId: "ext-1" }, (db) =>
      repo.setExternalModuleEnabled(db, {
        id: "acme-widgets",
        manifestHash: "sha256:m1",
        packageHash: "sha256:p1",
        actorUserId: ids.adminUser,
        requestId: "ext-1"
      })
    );

    let states = await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "ext-r1" },
      (db) => repo.listExternalModuleStates(db)
    );
    const enabled = states.find((s) => s.id === "acme-widgets");
    expect(enabled).toMatchObject({
      id: "acme-widgets",
      status: "enabled",
      packageHash: "sha256:p1"
    });

    await runner.withDataContext({ actorUserId: ids.adminUser, requestId: "ext-2" }, (db) =>
      repo.setExternalModuleDisabled(db, {
        id: "acme-widgets",
        reason: "disabled by admin",
        actorUserId: ids.adminUser,
        requestId: "ext-2"
      })
    );

    states = await runner.withDataContext({ actorUserId: ids.userA, requestId: "ext-r2" }, (db) =>
      repo.listExternalModuleStates(db)
    );
    expect(states.find((s) => s.id === "acme-widgets")).toMatchObject({
      status: "disabled",
      disabledReason: "disabled by admin"
    });

    const audit = await runner.withDataContext(
      { actorUserId: ids.adminUser, requestId: "ext-r3" },
      (db) => repo.listAdminAuditEvents(db)
    );
    const actions = audit.filter((e) => e.target_id === "acme-widgets").map((e) => e.action);
    expect(actions).toContain("module.external_enable");
    expect(actions).toContain("module.external_disable");
  });

  it("autoDisableExternalModule flips an enabled row to disabled with the drift reason", async () => {
    await runner.withDataContext({ actorUserId: ids.adminUser, requestId: "ext-4" }, (db) =>
      repo.setExternalModuleEnabled(db, {
        id: "drifter",
        manifestHash: "sha256:m",
        packageHash: "sha256:old",
        actorUserId: ids.adminUser,
        requestId: "ext-4"
      })
    );

    await runner.withDataContext({ actorUserId: ids.adminUser, requestId: "ext-5" }, (db) =>
      repo.autoDisableExternalModule(db, {
        id: "drifter",
        reason: "package changed since it was enabled",
        actorUserId: ids.adminUser,
        requestId: "ext-5"
      })
    );

    const states = await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "ext-r4" },
      (db) => repo.listExternalModuleStates(db)
    );
    expect(states.find((s) => s.id === "drifter")).toMatchObject({
      status: "disabled",
      disabledReason: "package changed since it was enabled"
    });

    const audit = await runner.withDataContext(
      { actorUserId: ids.adminUser, requestId: "ext-r5" },
      (db) => repo.listAdminAuditEvents(db)
    );
    expect(
      audit.some((e) => e.target_id === "drifter" && e.action === "module.external_auto_disable")
    ).toBe(true);
  });

  it("RLS: a NON-admin actor cannot enable an external module", async () => {
    await expect(
      runner.withDataContext({ actorUserId: ids.userA, requestId: "ext-6" }, (db) =>
        repo.setExternalModuleEnabled(db, {
          id: "sneaky",
          manifestHash: "sha256:m",
          packageHash: "sha256:p",
          actorUserId: ids.userA,
          requestId: "ext-6"
        })
      )
    ).rejects.toThrow();

    // No row leaked in (admin read sees nothing for 'sneaky').
    const states = await runner.withDataContext(
      { actorUserId: ids.adminUser, requestId: "ext-r6" },
      (db) => repo.listExternalModuleStates(db)
    );
    expect(states.some((s) => s.id === "sneaky")).toBe(false);
  });

  it("RLS: every authed actor can SELECT external-module state", async () => {
    await runner.withDataContext({ actorUserId: ids.adminUser, requestId: "ext-7" }, (db) =>
      repo.setExternalModuleEnabled(db, {
        id: "visible-to-all",
        manifestHash: "sha256:m",
        packageHash: "sha256:p",
        actorUserId: ids.adminUser,
        requestId: "ext-7"
      })
    );
    const asUserB = await runner.withDataContext(
      { actorUserId: ids.userB, requestId: "ext-r7" },
      (db) => repo.listExternalModuleStates(db)
    );
    expect(asUserB.some((s) => s.id === "visible-to-all")).toBe(true);
  });

  it("allows a draft row with an owner, and rejects a draft row without one (#1753)", async () => {
    await expect(
      runner.withDataContext({ actorUserId: ids.adminUser, requestId: "ext-8" }, (db) =>
        db.db
          .insertInto("app.external_modules")
          .values({
            id: "videos-draft",
            status: "draft",
            manifest_hash: "sha256:m",
            package_hash: "sha256:p",
            disabled_reason: null,
            enabled_by: null,
            enabled_at: null,
            owner_user_id: ids.userA,
            created_at: new Date(),
            updated_at: new Date()
          })
          .execute()
      )
    ).resolves.toBeDefined();

    await expect(
      runner.withDataContext({ actorUserId: ids.adminUser, requestId: "ext-9" }, (db) =>
        db.db
          .insertInto("app.external_modules")
          .values({
            id: "videos-draft-2",
            status: "draft",
            manifest_hash: "sha256:m",
            package_hash: "sha256:p",
            disabled_reason: null,
            enabled_by: null,
            enabled_at: null,
            owner_user_id: null,
            created_at: new Date(),
            updated_at: new Date()
          })
          .execute()
      )
    ).rejects.toThrow();
  });

  it("rejects an enabled row that carries an owner (#1753)", async () => {
    await expect(
      runner.withDataContext({ actorUserId: ids.adminUser, requestId: "ext-10" }, (db) =>
        db.db
          .insertInto("app.external_modules")
          .values({
            id: "videos-owned-enabled",
            status: "enabled",
            manifest_hash: "sha256:m",
            package_hash: "sha256:p",
            disabled_reason: null,
            enabled_by: ids.adminUser,
            enabled_at: new Date(),
            owner_user_id: ids.userA,
            created_at: new Date(),
            updated_at: new Date()
          })
          .execute()
      )
    ).rejects.toThrow();
  });
});
