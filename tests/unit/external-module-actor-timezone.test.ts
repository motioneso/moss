process.env.TZ = "UTC";

import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextRunner } from "@moss/db";
import type { ExternalModuleDiscovery } from "../../packages/module-registry/src/external/types.js";

let storedLocale: unknown = null;

vi.mock("@moss/structured-state", () => ({
  PreferencesRepository: class {
    async get(_scopedDb: unknown, key: string): Promise<unknown> {
      return key === "locale" ? storedLocale : null;
    }
  }
}));

const { resolveActorTimezone } =
  await import("../../packages/module-registry/src/external/preferences.js");
const { ExternalModuleJobReconciler } =
  await import("../../packages/module-registry/src/external/job-reconciler.js");

const ACCESS: AccessContext = { actorUserId: "user-1", requestId: "test" };
const runner = {
  withDataContext: async (_access: AccessContext, work: (scopedDb: unknown) => unknown) => work({})
} as unknown as DataContextRunner;

describe("resolveActorTimezone (#3395)", () => {
  it("returns the shared default zone when the person saved no locale", async () => {
    storedLocale = null;
    await expect(resolveActorTimezone(runner, ACCESS)).resolves.toBe("America/Los_Angeles");
  });

  it("returns the person's saved zone", async () => {
    storedLocale = { timezone: "Europe/London", region: "en-GB", dateFormat: "24" };
    await expect(resolveActorTimezone(runner, ACCESS)).resolves.toBe("Europe/London");
  });
});

function moduleWithSchedule(tz?: string): ExternalModuleDiscovery {
  return {
    id: "demo",
    dir: "/modules/demo",
    manifest: {
      schemaVersion: 1,
      id: "demo",
      name: "Demo",
      version: "0.1.0",
      publisher: "Acme",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.1.0" },
      worker: {
        queues: [{ name: "demo.daily", jobKinds: ["demo.daily"] }],
        schedules: [
          {
            id: "demo.daily",
            cron: "0 7 * * *",
            ...(tz === undefined ? {} : { tz }),
            queue: "demo.daily",
            jobKind: "demo.daily",
            scope: "user"
          }
        ]
      }
    },
    manifestHash: `sha256:${"a".repeat(64)}`,
    packageHash: "sha256:p-demo"
  } as unknown as ExternalModuleDiscovery;
}

async function scheduledZones(
  module: ExternalModuleDiscovery,
  resolveActorTimezoneDep?: (actorUserId: string) => Promise<string>
): Promise<string[]> {
  const zones: string[] = [];
  const boss = {
    getQueue: async () => ({}),
    createQueue: async () => undefined,
    updateQueue: async () => undefined,
    getSchedules: async () => [],
    schedule: async (_name: string, _cron: string, _payload: unknown, options: { tz: string }) => {
      zones.push(options.tz);
    }
  } as unknown as PgBoss;
  const reconciler = new ExternalModuleJobReconciler({
    boss,
    discoveries: () => [module],
    isModuleEnabled: async () => true,
    listActiveUserIds: async () => ["11111111-1111-4111-8111-111111111111"],
    ...(resolveActorTimezoneDep ? { resolveActorTimezone: resolveActorTimezoneDep } : {})
  });
  await reconciler.reconcileModule("demo");
  return zones;
}

describe("ExternalModuleJobReconciler schedule zone (#3395)", () => {
  it("schedules a zoneless per-user job in the person's zone", async () => {
    await expect(
      scheduledZones(moduleWithSchedule(), async () => "Europe/London")
    ).resolves.toEqual(["Europe/London"]);
  });

  it("falls back to the shared default zone, not UTC, when no zone is resolved", async () => {
    await expect(scheduledZones(moduleWithSchedule())).resolves.toEqual(["America/Los_Angeles"]);
  });

  it("falls back to the shared default zone when reading the person's zone fails", async () => {
    await expect(
      scheduledZones(moduleWithSchedule(), async () => {
        throw new Error("preferences unavailable");
      })
    ).resolves.toEqual(["America/Los_Angeles"]);
  });

  it("keeps a zone the module declares on the schedule", async () => {
    await expect(
      scheduledZones(moduleWithSchedule("Asia/Tokyo"), async () => "Europe/London")
    ).resolves.toEqual(["Asia/Tokyo"]);
  });
});
