import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";

import {
  reconcileExternalModuleUserJobs,
  registerExternalModuleJobRoutes
} from "../../apps/api/src/external-module-jobs.js";
import type { ExternalModuleDiscovery } from "@moss/module-registry";

describe("external module run-now route", () => {
  it("enqueues an eligible queue with the session actor and deterministic singleton", async () => {
    const calls: unknown[][] = [];
    const boss = {
      send: async (...args: unknown[]) => {
        calls.push(args);
        return "job-1";
      }
    } as unknown as PgBoss;
    const module = {
      id: "fixture",
      manifestHash: `sha256:${"a".repeat(64)}`,
      manifest: {
        worker: {
          queues: [{ name: "fixture.sync", handler: "sync", allowManualRun: true }]
        }
      }
    } as unknown as ExternalModuleDiscovery;
    const server = Fastify();
    registerExternalModuleJobRoutes(server, {
      boss,
      discoveries: () => [module],
      resolveAccessContext: async () => ({
        actorUserId: "00000000-0000-4000-8000-000000000001",
        requestId: "request-1"
      }),
      isModuleActive: async () => true
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/modules/fixture/queues/fixture.sync/run",
      payload: { jobKind: "manual-sync" }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ jobId: "job-1" });
    expect(calls).toEqual([
      [
        "fixture.sync",
        {
          actorUserId: "00000000-0000-4000-8000-000000000001",
          moduleId: "fixture",
          jobKind: "manual-sync",
          manifestHash: module.manifestHash
        },
        {
          singletonKey: "manual:fixture:fixture.sync:00000000-0000-4000-8000-000000000001",
          singletonSeconds: 5
        }
      ]
    ]);
    await server.close();
  });

  it("unschedules one actor then signals every discovered module to reconcile", async () => {
    const calls: unknown[][] = [];
    const boss = {
      getSchedules: async () => [
        { name: "fixture.sync", key: "fixture:daily:user-1" },
        { name: "notes.sync", key: "user-1" }
      ],
      unschedule: async (...args: unknown[]) => calls.push(["unschedule", ...args]),
      send: async (...args: unknown[]) => {
        calls.push(["send", ...args]);
        return "control-1";
      }
    } as unknown as PgBoss;

    await reconcileExternalModuleUserJobs(
      boss,
      [{ id: "fixture" }, { id: "other" }] as ExternalModuleDiscovery[],
      "user-1"
    );

    expect(calls).toEqual([
      ["unschedule", "fixture.sync", "fixture:daily:user-1"],
      ["send", "platform.module-control", { moduleId: "fixture", action: "reconcile" }],
      ["send", "platform.module-control", { moduleId: "other", action: "reconcile" }]
    ]);
  });
});
