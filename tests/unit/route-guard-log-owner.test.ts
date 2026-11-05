import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerRouteEnablementGuard } from "@moss/module-registry";
import type { MossModuleManifest } from "@moss/module-sdk";

// #3978 slice 2C: once the guard knows who a module request is for, every record the request
// logs carries that user as owner. A request with no signed-in user stays unowned.

const OWNER = "00000000-0000-4000-8000-0000000000c1";
const manifests = [
  { id: "demo", routes: [{ method: "GET", path: "/demo" }] }
] as unknown as MossModuleManifest[];

async function run(authenticated: boolean): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  const server = Fastify({
    logger: { level: "info", stream: { write: (c: string) => void lines.push(c) } as never }
  });
  registerRouteEnablementGuard(server, {
    manifests,
    resolveActiveModules: async () => manifests,
    resolveAccessContext: async () => {
      if (!authenticated) throw new Error("no session");
      return { actorUserId: OWNER, requestId: "r1" };
    }
  });
  server.get("/demo", async (request) => {
    request.log.warn("from the handler");
    return { ok: true };
  });
  await server.inject("/demo");
  await server.close();
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("route guard log owner", () => {
  it("tags handler and completion records with the signed-in user", async () => {
    const records = await run(true);
    const warn = records.find((r) => r.msg === "from the handler");
    expect(warn?.actorUserId).toBe(OWNER);
    const done = records.find((r) => r.msg === "request completed");
    expect(done?.actorUserId).toBe(OWNER);
  });

  it("leaves an unauthenticated request unowned", async () => {
    const records = await run(false);
    const warn = records.find((r) => r.msg === "from the handler");
    expect(warn).toBeDefined();
    expect(warn?.actorUserId).toBeUndefined();
  });
});
