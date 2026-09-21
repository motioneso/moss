import { describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";

import { DRIFT_DISABLED_REASON, reconcileExternalModules } from "@moss/module-registry";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import { ExternalModuleJobReconciler } from "@moss/module-registry/node";

const discovery = (id: string, packageHash: string): ExternalModuleDiscovery => ({
  id,
  dir: `/modules/${id}`,
  manifest: {
    schemaVersion: 1,
    id,
    name: `Name ${id}`,
    version: "0.1.0",
    publisher: "Acme",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.1.0" }
  },
  manifestHash: `sha256:m-${id}`,
  packageHash
});

describe("reconcileExternalModules (#917)", () => {
  it("marks a discovery with no row as discovered + inactive", () => {
    const { modules, driftDisable } = reconcileExternalModules([discovery("a", "sha256:1")], []);
    expect(modules).toHaveLength(1);
    expect(modules[0]).toMatchObject({
      id: "a",
      status: "discovered",
      active: false,
      drifted: false
    });
    expect(driftDisable).toEqual([]);
  });

  it("marks an enabled row with matching hash as active", () => {
    const { modules, driftDisable } = reconcileExternalModules(
      [discovery("a", "sha256:1")],
      [
        {
          id: "a",
          status: "enabled",
          packageHash: "sha256:1",
          disabledReason: null,
          ownerUserId: null
        }
      ]
    );
    expect(modules[0]).toMatchObject({ id: "a", status: "enabled", active: true, drifted: false });
    expect(driftDisable).toEqual([]);
  });

  it("auto-disables (drift) an enabled row whose hash no longer matches", () => {
    const { modules, driftDisable } = reconcileExternalModules(
      [discovery("a", "sha256:NEW")],
      [
        {
          id: "a",
          status: "enabled",
          packageHash: "sha256:OLD",
          disabledReason: null,
          ownerUserId: null
        }
      ]
    );
    expect(modules[0]).toMatchObject({
      id: "a",
      status: "disabled",
      active: false,
      drifted: true,
      disabledReason: DRIFT_DISABLED_REASON
    });
    expect(driftDisable).toEqual([{ id: "a", reason: DRIFT_DISABLED_REASON }]);
  });

  it("keeps an explicitly disabled row disabled and carries its reason", () => {
    const { modules } = reconcileExternalModules(
      [discovery("a", "sha256:1")],
      [
        {
          id: "a",
          status: "disabled",
          packageHash: "sha256:1",
          disabledReason: "admin turned it off",
          ownerUserId: null
        }
      ]
    );
    expect(modules[0]).toMatchObject({
      id: "a",
      status: "disabled",
      active: false,
      drifted: false
    });
    expect(modules[0]!.disabledReason).toBe("admin turned it off");
  });

  it("ignores a row whose module is no longer on disk", () => {
    const { modules } = reconcileExternalModules(
      [],
      [
        {
          id: "ghost",
          status: "enabled",
          packageHash: "sha256:1",
          disabledReason: null,
          ownerUserId: null
        }
      ]
    );
    expect(modules).toEqual([]);
  });

  it("does not disable a draft module whose package hash no longer matches (#1753)", () => {
    const { modules, driftDisable } = reconcileExternalModules(
      [discovery("videos-draft", "sha256:NEW")],
      [
        {
          id: "videos-draft",
          status: "draft",
          packageHash: "sha256:OLD",
          disabledReason: null,
          ownerUserId: "user-a"
        }
      ]
    );
    expect(modules[0]).toMatchObject({
      id: "videos-draft",
      status: "draft",
      active: true,
      drifted: false,
      disabledReason: null,
      ownerUserId: "user-a"
    });
    expect(driftDisable).toEqual([]);
  });

  it("still disables a shipped module whose package hash no longer matches", () => {
    const { modules } = reconcileExternalModules(
      [discovery("videos", "sha256:NEW")],
      [
        {
          id: "videos",
          status: "enabled",
          packageHash: "sha256:OLD",
          disabledReason: null,
          ownerUserId: null
        }
      ]
    );
    expect(modules[0]).toMatchObject({ id: "videos", status: "disabled", active: false });
  });

  it("sorts output modules by id", () => {
    const { modules } = reconcileExternalModules(
      [discovery("b", "sha256:1"), discovery("a", "sha256:1")],
      []
    );
    expect(modules.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("carries navigation from the manifest through to the reconciled module", () => {
    const nav = [{ id: "a", label: "A", path: "/" }];
    const withNav: ExternalModuleDiscovery = {
      ...discovery("a", "sha256:1"),
      manifest: { ...discovery("a", "sha256:1").manifest, navigation: nav }
    };
    const { modules } = reconcileExternalModules([withNav], []);
    expect(modules[0]?.navigation).toEqual(nav);
  });

  it("defaults navigation to an empty array when the manifest declares none", () => {
    const { modules } = reconcileExternalModules([discovery("a", "sha256:1")], []);
    expect(modules[0]?.navigation).toEqual([]);
  });
});

describe("ExternalModuleJobReconciler library-queue guard ([task:uat-pgboss-delete-grant])", () => {
  it("purges an orphan module queue but never deletes the job library's own queue", async () => {
    const calls: string[] = [];
    const boss = {
      getSchedules: async () => [
        { name: "__pgboss__send-it", key: "__pgboss__send-it/cron" },
        { name: "ghostmod.main", key: "ghostmod/daily" }
      ],
      getQueues: async () => [{ name: "__pgboss__send-it" }, { name: "ghostmod.jobs" }],
      unschedule: async (name: string, key: string) => {
        calls.push(`unschedule:${name}:${key}`);
      },
      deleteQueue: async (name: string) => {
        calls.push(`delete:${name}`);
      }
    } as unknown as PgBoss;
    const reconciler = new ExternalModuleJobReconciler({
      boss,
      discoveries: () => [],
      reservedQueueNames: new Set<string>(["api.inbox"]),
      isModuleEnabled: async () => true,
      listActiveUserIds: async () => []
    });

    await reconciler.reconcileAll();

    expect(calls).toEqual(["unschedule:ghostmod.main:ghostmod/daily", "delete:ghostmod.jobs"]);
  });
});
