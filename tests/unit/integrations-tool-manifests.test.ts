import { describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextRunner } from "@moss/db";
import {
  convertOpenApiSpec,
  createIntegrationsCipher,
  createIntegrationsActiveModulesResolver,
  createResolverCache,
  mapMcpTool
} from "@moss/integrations";
import type { ConnectionRow } from "@moss/integrations";
import type { DiscoveredTool } from "@moss/integrations";

function tool(
  name: string,
  group: string,
  inputSchema: Record<string, unknown> | null = {}
): DiscoveredTool {
  return { name, description: name, group, inputSchema };
}

function connection(overrides: Partial<ConnectionRow>): ConnectionRow {
  return {
    id: "id",
    ownerUserId: "owner",
    name: "connection",
    kind: "mcp",
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
    classifierEnabled: false,
    classifierPreparation: { version: 1, entries: {} },
    classifierSort: { version: 1, entries: {} },
    classifierKeptOutTools: [],
    discoveredTools: [],
    lastDiscoveryAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

function fakeDataContext(): DataContextRunner {
  return {
    withDataContext: async (_ctx: unknown, work: (scopedDb: unknown) => unknown) => work({})
  } as unknown as DataContextRunner;
}

describe("createIntegrationsActiveModulesResolver", () => {
  it.each(["actor-1", "stored-owner", "other-owner", undefined])(
    "preserves stored connection owner evidence %s without inferring authority from discovery",
    async (ownerUserId) => {
      const discovered = {
        ...tool("read_widgets", "Widgets"),
        descriptorOwnerUserId: "actor-1",
        ownerUserId: "actor-1",
        isExternal: false,
        externalContent: false
      };
      const resolver = createIntegrationsActiveModulesResolver(async () => [], {
        dataContext: fakeDataContext(),
        cipher: createIntegrationsCipher(),
        logger: { warn: () => {} },
        resolverCache: createResolverCache(),
        repository: {
          listConnections: async () => [connection({ ownerUserId, discoveredTools: [discovered] })]
        } as never
      });

      const [module] = await resolver("actor-1");

      expect(module?.assistantTools?.[0]?.descriptorOwnerUserId).toBe(ownerUserId);
      expect(module?.assistantTools?.[0]).toMatchObject({
        isExternal: true,
        externalContent: true,
        description: discovered.description,
        inputSchema: discovered.inputSchema
      });
      expect(module?.assistantTools?.[0]).not.toHaveProperty("ownerUserId");
    }
  );

  it("keeps stored owner stamps in the actor-scoped resolver cache without transferring them", async () => {
    const rows = new Map([
      ["actor-a", connection({ ownerUserId: "actor-a", discoveredTools: [tool("read_a", "")] })],
      ["actor-b", connection({ ownerUserId: "actor-b", discoveredTools: [tool("read_b", "")] })]
    ]);
    const listConnections = vi.fn(async (scopedDb: { actorUserId: string }) => {
      const row = rows.get(scopedDb.actorUserId);
      return row ? [row] : [];
    });
    const resolver = createIntegrationsActiveModulesResolver(async () => [], {
      dataContext: {
        withDataContext: async (ctx: AccessContext, work: (scopedDb: unknown) => unknown) =>
          work({ actorUserId: ctx.actorUserId })
      } as unknown as DataContextRunner,
      cipher: createIntegrationsCipher(),
      logger: { warn: () => {} },
      resolverCache: createResolverCache(),
      repository: { listConnections } as never
    });

    const firstA = await resolver("actor-a");
    const firstB = await resolver("actor-b");
    expect(firstA[0]?.assistantTools?.[0]).toMatchObject({
      name: "connection.read_a",
      descriptorOwnerUserId: "actor-a"
    });
    expect(firstB[0]?.assistantTools?.[0]).toMatchObject({
      name: "connection.read_b",
      descriptorOwnerUserId: "actor-b"
    });
    expect(await resolver("actor-a")).toEqual(firstA);
    expect(await resolver("actor-b")).toEqual(firstB);
    expect(listConnections).toHaveBeenCalledTimes(2);
    expect(await resolver("actor-with-no-connection")).toEqual([]);
  });

  it("appends synthetic modules for enabled connections without touching the base list", async () => {
    const warnings: { connection: unknown; tool: unknown }[] = [];
    const logger = {
      warn: (obj: Record<string, unknown>) =>
        warnings.push({ connection: obj.connection, tool: obj.tool })
    };

    const largeGroupTools = Array.from({ length: 31 }, (_, i) =>
      tool(`t${i}`, i < 4 ? "Live" : "Other")
    );

    const connections: ConnectionRow[] = [
      connection({
        id: "conn-home-assistant",
        name: "Home Assistant",
        kind: "mcp",
        discoveredTools: [
          tool("turn_on", ""),
          tool("turn_off", ""),
          tool("bad_schema", "", { anyOf: [{ type: "string" }] })
        ]
      }),
      connection({
        id: "conn-disabled",
        name: "Disabled Thing",
        enabled: false,
        discoveredTools: [tool("should_not_appear", "")]
      }),
      connection({
        id: "conn-large",
        name: "Large API",
        kind: "openapi",
        baseUrl: "http://large.example.com",
        discoveredTools: largeGroupTools,
        enabledGroups: ["Live"]
      })
    ];

    const baseModule = { id: "base", name: "Base" } as never;
    const resolver = createIntegrationsActiveModulesResolver(async () => [baseModule], {
      dataContext: fakeDataContext(),
      cipher: createIntegrationsCipher(),
      logger,
      resolverCache: createResolverCache(),
      repository: { listConnections: async () => connections } as never
    });

    const modules = await resolver("actor-1");

    expect(modules[0]).toBe(baseModule);
    expect(modules).toHaveLength(3); // base + home-assistant + large-api (disabled contributes nothing)

    const homeAssistant = modules.find((m) => m.id === "integration-home-assistant")!;
    const toolNames = (homeAssistant.assistantTools ?? []).map((t) => t.name);
    expect(toolNames).toEqual(["home-assistant.turn_on", "home-assistant.turn_off"]);
    expect(toolNames).not.toContain("home-assistant.bad_schema");
    expect(warnings).toEqual([{ connection: "Home Assistant", tool: "bad_schema" }]);

    for (const t of homeAssistant.assistantTools ?? []) {
      expect(t.isExternal).toBe(true);
      expect(t.externalContent).toBe(true);
      expect(t.risk).toBe("outbound");
      expect(typeof t.execute).toBe("function");
    }

    expect(modules.some((m) => m.id === "integration-disabled-thing")).toBe(false);

    const largeApi = modules.find((m) => m.id === "integration-large-api")!;
    expect((largeApi.assistantTools ?? []).map((t) => t.name)).toEqual([
      "large-api.t0",
      "large-api.t1",
      "large-api.t2",
      "large-api.t3"
    ]);
  });

  it("contributes nothing for a connection with no curated tools", async () => {
    const resolver = createIntegrationsActiveModulesResolver(async () => [], {
      dataContext: fakeDataContext(),
      cipher: createIntegrationsCipher(),
      logger: { warn: () => {} },
      resolverCache: createResolverCache(),
      repository: {
        listConnections: async () => [
          connection({ id: "empty", name: "Empty", discoveredTools: [] })
        ]
      } as never
    });

    expect(await resolver("actor-1")).toEqual([]);
  });
});

describe("integration discovery ownership boundary", () => {
  it("does not accept a descriptor owner stamp from MCP discovery", () => {
    const remote = {
      name: "read_widgets",
      description: "Read widgets",
      inputSchema: { type: "object", properties: {} },
      descriptorOwnerUserId: "forged-owner",
      annotations: { descriptorOwnerUserId: "forged-owner", readOnlyHint: true }
    };

    const discovered = mapMcpTool(remote);

    expect(discovered).not.toHaveProperty("descriptorOwnerUserId");
    expect(discovered.readOnly).toBe(true);
  });

  it("does not accept a descriptor owner stamp from OpenAPI discovery", () => {
    const discovered = convertOpenApiSpec({
      openapi: "3.0.0",
      descriptorOwnerUserId: "forged-owner",
      paths: {
        "/widgets": {
          get: {
            operationId: "read_widgets",
            summary: "Read widgets",
            descriptorOwnerUserId: "forged-owner"
          }
        }
      }
    });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).not.toHaveProperty("descriptorOwnerUserId");
    expect(discovered[0]?.readOnly).toBe(true);
  });
});
