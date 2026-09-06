import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DataContextRunner } from "@moss/db";
import {
  createIntegrationsActiveModulesResolver,
  registerIntegrationsRoutes,
  type ConnectionRow,
  type DiscoveredTool
} from "@moss/integrations";

const ENV_KEYS = ["JARVIS_INTEGRATIONS_SECRET_KEY", "MOSS_INTEGRATIONS_SECRET_KEY"] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function tool(name: string): DiscoveredTool {
  return { name, description: name, group: "g", inputSchema: {} };
}

function connection(overrides: Partial<ConnectionRow>): ConnectionRow {
  return {
    id: "id",
    ownerUserId: "owner",
    name: "connection",
    kind: "openapi",
    transport: "http",
    url: "http://example.com",
    credentialPlacement: null,
    hasCredential: false,
    enabled: true,
    baseUrl: null,
    specPasted: false,
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    unsuppressedTools: [],
    discoveredTools: [],
    lastDiscoveryAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function fakeDataContext(connections: ConnectionRow[] = []): DataContextRunner {
  return {
    withDataContext: async (_ctx: unknown, work: (scopedDb: unknown) => unknown) =>
      work({
        [Symbol.for("test")]: true
      })
  } as unknown as DataContextRunner;
}

const silentLogger = { warn: (_obj: Record<string, unknown>, _msg: string) => {} };

describe("integrations paused without a key (#2312 slice 1)", () => {
  it("unlists credentialed connections but keeps credential-less ones", async () => {
    const repository = {
      listConnections: async () => [
        connection({
          id: "c1",
          name: "With secret",
          hasCredential: true,
          discoveredTools: [tool("t1")]
        }),
        connection({ id: "c2", name: "Open", hasCredential: false, discoveredTools: [tool("t2")] })
      ]
    };
    const resolve = createIntegrationsActiveModulesResolver(async () => [], {
      dataContext: fakeDataContext(),
      repository: repository as never,
      resolveKeyring: async () => null,
      logger: silentLogger
    });
    const modules = await resolve("actor");
    const names = modules.flatMap((m) => (m.assistantTools ?? []).map((t) => t.name));
    expect(names.some((n) => n.includes("t1"))).toBe(false);
    expect(names.some((n) => n.includes("t2"))).toBe(true);
  });

  it("answers tool calls with the setup summary instead of failing", async () => {
    const repository = {
      listConnections: async () => [
        connection({ id: "c2", name: "Open", hasCredential: false, discoveredTools: [tool("t2")] })
      ],
      loadCredentialEnvelope: async () => null
    };
    const resolve = createIntegrationsActiveModulesResolver(async () => [], {
      dataContext: fakeDataContext(),
      repository: repository as never,
      resolveKeyring: async () => null,
      logger: silentLogger
    });
    const modules = await resolve("actor");
    const listed = modules.flatMap((m) => m.assistantTools ?? []);
    expect(listed).toHaveLength(1);
    const result = (await listed[0]!.execute!({}, {}, {
      actorUserId: "actor",
      chatSessionId: "chat"
    } as never)) as { data: { status: string; summary: string } };
    expect(result.data.status).toBe("error");
    expect(result.data.summary).toContain("Encryption keys");
  });

  it("POST with a credential answers 503 naming the fix, never leaking it", async () => {
    const app = Fastify();
    registerIntegrationsRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: "u", requestId: "r" }),
      dataContext: fakeDataContext()
    } as never);
    const spec = JSON.stringify({
      openapi: "3.0.0",
      paths: { "/w": { get: { operationId: "listW", tags: ["W"] } } }
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/integrations",
      payload: {
        name: "x",
        kind: "openapi",
        url: "http://example.com/openapi.json",
        spec,
        credential: "sekret"
      }
    });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("Encryption keys");
    expect(res.body).not.toContain("sekret");
  });
});
