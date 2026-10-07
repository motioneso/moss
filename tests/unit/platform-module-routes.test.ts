import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerPlatformRoutes } from "../../apps/api/src/platform-module-routes.js";

const actor = { actorUserId: "9f861ab3-e581-4ac7-aef8-086a21aa6013", requestId: "synthetic" };

describe("platform module listing composition", () => {
  it("resolves the current actor before listing their active external modules", async () => {
    const server = Fastify();
    const active = vi.fn(async () => []);
    registerPlatformRoutes(server, { resolveAccessContext: async () => actor }, active);
    try {
      const response = await server.inject({ method: "GET", url: "/api/modules" });
      expect(response.statusCode).toBe(200);
      expect(active).toHaveBeenCalledExactlyOnceWith(actor);
      expect(response.json().modules.some((item: { id: string }) => item.id === "meetings")).toBe(
        true
      );
    } finally {
      await server.close();
    }
  });

  it.each([
    ["account_pending_approval", 403],
    ["account_deactivated", 403],
    ["session_expired", 401]
  ] as const)("refuses %s without resolving external modules", async (code, status) => {
    const server = Fastify();
    const active = vi.fn(async () => []);
    registerPlatformRoutes(
      server,
      {
        resolveAccessContext: async () => {
          throw Object.assign(new Error("synthetic"), { code });
        }
      },
      active
    );
    try {
      const response = await server.inject({ method: "GET", url: "/api/modules" });
      expect(response.statusCode).toBe(status);
      expect(active).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
