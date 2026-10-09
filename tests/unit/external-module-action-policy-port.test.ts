import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";

import type { DataContextDb, DataContextRunner, MossDatabase } from "@moss/db";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import { createExternalModuleRpcHandler } from "@moss/module-registry/node";

const stored = vi.hoisted(() => ({
  rows: [] as { moduleId: string; actionFamilyId: string; tier: string }[]
}));

vi.mock("@moss/ai", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  class FakeAiRepository {
    async listActionPolicies() {
      return stored.rows;
    }
  }
  return { ...original, AiRepository: FakeAiRepository };
});

describe("external worker ctx.actionPolicy port (P4)", () => {
  const module = {
    id: "finance",
    dir: "/unused",
    manifest: {
      schemaVersion: 1,
      id: "finance",
      name: "Finance",
      version: "1.0.0",
      publisher: "Jarvis",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.0.0" },
      assistantActionFamilies: [
        {
          id: "sorting",
          label: "Sorting",
          description: "Sorts transactions",
          defaultTier: "ask_each_time",
          allowedTiers: ["ask_each_time", "trusted_auto"]
        }
      ]
    },
    manifestHash: "sha256:a",
    packageHash: "sha256:a"
  } as unknown as ExternalModuleDiscovery;

  const rpc = () => {
    const scopedDb = new Kysely<MossDatabase>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler()
      }
    });
    return createExternalModuleRpcHandler({
      module,
      toolRisk: "write",
      actorUserId: randomUUID(),
      requestId: randomUUID(),
      workerDataContext: {
        withDataContext: async (_access: unknown, fn: (db: DataContextDb) => unknown) =>
          fn({ db: scopedDb } as unknown as DataContextDb)
      } as unknown as DataContextRunner,
      isActorAdmin: async () => false,
      embeddingProvider: null as never
    });
  };

  it("returns the user's stored tier for the module's own family", async () => {
    stored.rows = [{ moduleId: "finance", actionFamilyId: "sorting", tier: "trusted_auto" }];
    await expect(
      rpc()("actionPolicy.get", { familyId: "sorting" }, () => undefined)
    ).resolves.toEqual({ tier: "trusted_auto" });
  });

  it("returns the family default when the user never chose", async () => {
    stored.rows = [];
    await expect(
      rpc()("actionPolicy.get", { familyId: "sorting" }, () => undefined)
    ).resolves.toEqual({ tier: "ask_each_time" });
  });

  it("ignores another module's stored row for the same family id", async () => {
    stored.rows = [{ moduleId: "tasks", actionFamilyId: "sorting", tier: "trusted_auto" }];
    await expect(
      rpc()("actionPolicy.get", { familyId: "sorting" }, () => undefined)
    ).resolves.toEqual({ tier: "ask_each_time" });
  });

  it("rejects a family another module declared", async () => {
    stored.rows = [{ moduleId: "tasks", actionFamilyId: "task_changes", tier: "trusted_auto" }];
    await expect(
      rpc()("actionPolicy.get", { familyId: "task_changes" }, () => undefined)
    ).rejects.toMatchObject({ code: "undeclared_action_family" });
  });

  it("rejects a missing family id", async () => {
    await expect(rpc()("actionPolicy.get", {}, () => undefined)).rejects.toMatchObject({
      code: "invalid_rpc"
    });
  });
});
