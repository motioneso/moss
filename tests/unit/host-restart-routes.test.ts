import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";

import { registerHostRestartRoutes } from "@moss/settings";

// #1748 — admin "Restart app". The route's job is narrow: authorize, decide whether anything
// on the host will act, and if so create one fixed-name empty file. Each test below is named
// for the failure it catches, because every one of them looks fine in review.

interface Harness {
  readonly server: FastifyInstance;
  readonly controlDir: string;
  readonly auditActions: string[];
}

const ADMIN_ID = "11111111-1111-1111-1111-111111111111";

const buildHarness = async (options: {
  isAdmin: boolean;
  wireControlDir: boolean;
}): Promise<Harness> => {
  const controlDir = await mkdtemp(join(tmpdir(), "jarv1s-restart-"));
  const auditActions: string[] = [];
  const server = Fastify();

  registerHostRestartRoutes(server, {
    dataContext: {
      withDataContext: async (_accessContext: unknown, run: (db: never) => unknown) =>
        run({} as never)
    } as never,
    resolveAccessContext: async () => ({ actorUserId: ADMIN_ID, requestId: "req-1" }) as never,
    repository: {
      insertAuditEvent: async (_db: unknown, event: { action: string }) => {
        auditActions.push(event.action);
      }
    } as never,
    hostRestart: options.wireControlDir ? { controlDir } : undefined,
    assertAdminUser: async () => {
      if (!options.isAdmin) {
        const error = new Error("Forbidden") as Error & { statusCode: number };
        error.statusCode = 403;
        throw error;
      }
      return {} as never;
    },
    requireRequestId: () => "req-1",
    handleRouteError: (error, reply) => {
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      return reply.status(status).send({ error: (error as Error).message });
    }
  });

  await server.ready();
  return { server, controlDir, auditActions };
};

describe("host restart routes (#1748)", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = undefined as unknown as Harness;
  });

  it("rejects a non-admin POST and writes nothing to the control directory", async () => {
    harness = await buildHarness({ isAdmin: false, wireControlDir: true });
    const response = await harness.server.inject({
      method: "POST",
      url: "/api/admin/host/restart"
    });

    expect(response.statusCode).toBe(403);
    // The status code alone would pass against an implementation that writes the sentinel
    // and *then* authorizes — by which point the host has already restarted the app.
    expect(await readdir(harness.controlDir)).toEqual([]);
    expect(harness.auditActions).toEqual([]);
  });

  it("fails closed with 503 when no control directory is configured", async () => {
    harness = await buildHarness({ isAdmin: true, wireControlDir: false });
    const response = await harness.server.inject({
      method: "POST",
      url: "/api/admin/host/restart"
    });

    expect(response.statusCode).toBe(503);
  });

  it("reports the watcher missing instead of claiming a restart nobody will perform", async () => {
    harness = await buildHarness({ isAdmin: true, wireControlDir: true });
    const response = await harness.server.inject({
      method: "POST",
      url: "/api/admin/host/restart"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: false, reason: "host-watcher-absent" });
    // An implementation that writes the sentinel anyway leaves a file that fires the moment
    // someone later installs the host unit — a restart nobody asked for, at a random time.
    expect(await readdir(harness.controlDir)).toEqual([]);
  });

  it("writes exactly one empty, fixed-name sentinel when the watcher is present", async () => {
    harness = await buildHarness({ isAdmin: true, wireControlDir: true });
    await writeFile(join(harness.controlDir, "watcher-alive"), "", "utf8");

    const response = await harness.server.inject({
      method: "POST",
      url: "/api/admin/host/restart"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
    expect((await readdir(harness.controlDir)).sort()).toEqual([
      "restart-requested",
      "watcher-alive"
    ]);
    expect(harness.auditActions).toEqual(["host.restart_requested"]);
  });

  it("GET reports the watcher absent rather than defaulting to available", async () => {
    harness = await buildHarness({ isAdmin: true, wireControlDir: true });
    const response = await harness.server.inject({
      method: "GET",
      url: "/api/admin/host/restart"
    });

    expect(response.statusCode).toBe(200);
    // Defaulting to true renders an enabled button that silently does nothing — the exact
    // outcome this whole liveness check exists to prevent.
    expect(response.json()).toEqual({ hostWatcherInstalled: false, lastRequestedAt: null });
  });

  it("GET reports the watcher present and surfaces a pending request's timestamp", async () => {
    harness = await buildHarness({ isAdmin: true, wireControlDir: true });
    await writeFile(join(harness.controlDir, "watcher-alive"), "", "utf8");
    await writeFile(join(harness.controlDir, "restart-requested"), "", "utf8");

    const body = (await harness.server.inject({
      method: "GET",
      url: "/api/admin/host/restart"
    })).json() as { hostWatcherInstalled: boolean; lastRequestedAt: string | null };

    expect(body.hostWatcherInstalled).toBe(true);
    expect(body.lastRequestedAt).not.toBeNull();
  });
});
