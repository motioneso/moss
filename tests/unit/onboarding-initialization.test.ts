import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AccessContext, DataContextDb, User } from "@moss/db";
import { handleRouteError } from "@moss/module-sdk";
import {
  registerOnboardingRoutes,
  type OnboardingRoutesDependencies
} from "../../packages/settings/src/onboarding-routes.js";

// Handler-order/failure tests only. Actual auth, queue, worker and SQL are exercised
// by the installed Finance startup acceptance; these scoped database calls are mocked.
function fixture(options: { writeFails?: boolean; hookFails?: boolean } = {}) {
  const events: string[] = [];
  const actor = "00000000-0000-4000-8000-000000000001";
  const dependencies: OnboardingRoutesDependencies = {
    dataContext: {
      withDataContext: async (
        _access: AccessContext,
        run: (scope: DataContextDb) => Promise<unknown>
      ) => {
        const result = await run({} as DataContextDb);
        events.push("committed");
        return result;
      }
    } as unknown as OnboardingRoutesDependencies["dataContext"],
    resolveAccessContext: async () => ({ actorUserId: actor, requestId: "synthetic-request" }),
    repository: {
      setMemberOnboardingComplete: async () => {
        if (options.writeFails) throw new Error("synthetic write failure");
        events.push("saved");
        return { completedAt: "2026-10-30T00:00:00Z" };
      }
    } as unknown as OnboardingRoutesDependencies["repository"],
    requireKnownUser: async () => ({ id: actor, is_bootstrap_owner: false }) as User,
    assertBootstrapOwnerAdminUser: async () => {
      throw new Error("unexpected founder branch");
    },
    requireRequestId: (access) => access.requestId!,
    handleRouteError,
    onOnboardingCommitted: async (id) => {
      events.push(`hook:${id}`);
      if (options.hookFails) throw new Error("synthetic queue failure");
    }
  };
  const server = Fastify({ logger: false });
  registerOnboardingRoutes(server, dependencies);
  return { server, events, actor };
}
describe("onboarding initialization notification", () => {
  it.each(["complete", "skip"])("notifies the resolved actor after %s commits", async (verb) => {
    const { server, events, actor } = fixture();
    try {
      const response = await server.inject({ method: "POST", url: `/api/onboarding/${verb}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ completed: true });
      expect(events).toEqual(["saved", "committed", `hook:${actor}`]);
    } finally {
      await server.close();
    }
  });
  it("keeps completion successful when the queue side effect fails", async () => {
    const { server, events, actor } = fixture({ hookFails: true });
    try {
      const response = await server.inject({ method: "POST", url: "/api/onboarding/complete" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ completed: true });
      expect(events).toEqual(["saved", "committed", `hook:${actor}`]);
    } finally {
      await server.close();
    }
  });
  it("does not initialize when saving onboarding fails", async () => {
    const { server, events } = fixture({ writeFails: true });
    try {
      const response = await server.inject({ method: "POST", url: "/api/onboarding/skip" });
      expect(response.statusCode).toBe(500);
      expect(events).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
