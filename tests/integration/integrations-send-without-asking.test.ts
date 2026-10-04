import Fastify from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  DataContextRunner,
  type AccessContext,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import {
  connectionSlug,
  createIntegrationsActiveModulesResolver,
  createIntegrationsCipher,
  createResolverCache,
  IntegrationsRepository,
  registerIntegrationsRoutes,
  toolRiskInputs,
  toolSortFingerprint,
  type ClassifierSortResult,
  type DiscoveredTool
} from "@moss/integrations";
import type { ModuleAssistantToolManifest } from "@moss/module-sdk";
import type { IntegrationClassifierRisk, IntegrationDetail } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

/**
 * #2984 R2.3, spec 8.3: the owner-only send-without-asking request, and the sorted-safe mark read
 * through the caller's own row-level security.
 */

const repository = new IntegrationsRepository();

const BROADCAST: DiscoveredTool = {
  name: "HassBroadcast",
  description: "Broadcast a message through the home.",
  group: "",
  inputSchema: { type: "object", properties: { message: { type: "string" } } }
};
const TURN_ON: DiscoveredTool = {
  name: "HassTurnOn",
  description: "Turn a device on.",
  group: "",
  inputSchema: { type: "object", properties: { name: { type: "string" } } }
};
const DELETE_ALL: DiscoveredTool = {
  name: "HassDeleteAll",
  description: "Delete every automation.",
  group: "",
  inputSchema: { type: "object", properties: {} }
};

function sortedAs(tool: DiscoveredTool, risk: IntegrationClassifierRisk): ClassifierSortResult {
  return {
    status: "current",
    risk,
    readableName: "Readable name",
    sortFingerprint: toolSortFingerprint(toolRiskInputs(tool)),
    sortedAt: new Date().toISOString()
  };
}

function context(actorUserId: string): AccessContext {
  return { actorUserId, requestId: `req:send-without-asking:${actorUserId}` };
}

describe("send without asking and the sorted-safe mark (#2984 R2.3)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await appDb.destroy();
  });

  function as<T>(actorUserId: string, run: (scopedDb: DataContextDb) => Promise<T>): Promise<T> {
    return dataContext.withDataContext(context(actorUserId), run);
  }

  async function sortedConnection(
    actorUserId: string,
    name: string,
    sorts: ReadonlyArray<[DiscoveredTool, IntegrationClassifierRisk]>
  ): Promise<string> {
    return as(actorUserId, async (scopedDb) => {
      const created = await repository.createConnection(scopedDb, {
        name,
        kind: "mcp",
        url: "https://mcp.example.com",
        baseUrl: null,
        specPasted: false,
        credentialEnvelope: null,
        credentialPlacement: null
      });
      await repository.saveDiscovery(scopedDb, created.id, [BROADCAST, TURN_ON, DELETE_ALL], null);
      if (sorts.length > 0) {
        await repository.saveClassifierToolSorts(
          scopedDb,
          created.id,
          sorts.map(([tool, risk]) => ({ toolName: tool.name, result: sortedAs(tool, risk) }))
        );
      }
      return created.id;
    });
  }

  function buildApp(actorUserId: string) {
    const app = Fastify();
    registerIntegrationsRoutes(app, {
      resolveAccessContext: async () => context(actorUserId),
      dataContext,
      cipher: createIntegrationsCipher(),
      resolverCache: createResolverCache()
    });
    return app;
  }

  function putFlag(actorUserId: string, id: string, body: unknown) {
    return buildApp(actorUserId).inject({
      method: "PUT",
      url: `/api/integrations/${id}/classifier/send-without-asking`,
      payload: body as never
    });
  }

  /** The owner's listed tool for one connection, by connection name and raw tool name. */
  async function listedTool(
    ownerUserId: string,
    connectionName: string,
    toolName: string
  ): Promise<ModuleAssistantToolManifest> {
    const resolver = createIntegrationsActiveModulesResolver(async () => [], {
      dataContext,
      cipher: createIntegrationsCipher(),
      logger: { warn: () => {} },
      resolverCache: createResolverCache(),
      repository
    });
    const slug = connectionSlug(connectionName);
    const module = (await resolver(ownerUserId)).find((m) => m.id === `integration-${slug}`);
    const tool = module?.assistantTools?.find((t) => t.name === `${slug}.${toolName}`);
    if (!tool) throw new Error(`no listed tool ${connectionName} ${toolName}`);
    return tool;
  }

  function runsWithoutAsking(tool: ModuleAssistantToolManifest, actorUserId: string) {
    const ctx = {
      actorUserId,
      requestId: `req:send-without-asking:${actorUserId}`,
      chatSessionId: "s1"
    };
    return as(actorUserId, async (scopedDb) => tool.runsWithoutAsking!(scopedDb, ctx));
  }

  it("lets the owner allow and undo sending without asking, and shows which tools ask first", async () => {
    const id = await sortedConnection(ids.userA, "Owner A home", [
      [BROADCAST, "outbound"],
      [TURN_ON, "write"],
      [DELETE_ALL, "destructive"]
    ]);

    const allowed = await putFlag(ids.userA, id, { allow: true, toolNames: [BROADCAST.name] });
    expect(allowed.statusCode).toBe(200);
    const detail = allowed.json<IntegrationDetail>();
    const byName = new Map(detail.classifierTools.map((tool) => [tool.toolName, tool]));
    expect(byName.get(BROADCAST.name)).toMatchObject({
      risk: "outbound",
      sendWithoutAsking: true,
      asksFirst: false
    });
    expect(byName.get(TURN_ON.name)).toMatchObject({ risk: "write", asksFirst: false });
    expect(byName.get(DELETE_ALL.name)).toMatchObject({ risk: "destructive", asksFirst: true });

    const undone = await putFlag(ids.userA, id, { allow: false, toolNames: [BROADCAST.name] });
    expect(undone.statusCode).toBe(200);
    expect(
      undone
        .json<IntegrationDetail>()
        .classifierTools.find((tool) => tool.toolName === BROADCAST.name)
    ).toMatchObject({ sendWithoutAsking: false, asksFirst: true });
  });

  it("refuses the whole request when any named tool is not sorted as sending things out", async () => {
    const id = await sortedConnection(ids.userA, "Owner A refuse", [
      [BROADCAST, "outbound"],
      [DELETE_ALL, "destructive"]
    ]);

    const refused = await putFlag(ids.userA, id, {
      allow: true,
      toolNames: [BROADCAST.name, DELETE_ALL.name]
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      error: "Only a tool sorted as sending things out can send without asking."
    });

    const row = await as(ids.userA, (scopedDb) => repository.getConnection(scopedDb, id));
    expect(row!.classifierSort.entries[BROADCAST.name]!.sendWithoutAsking).toBe(false);
    expect(row!.classifierSort.entries[DELETE_ALL.name]!.sendWithoutAsking).toBe(false);
  });

  it("rejects a malformed body", async () => {
    const id = await sortedConnection(ids.userA, "Owner A bad body", [[BROADCAST, "outbound"]]);
    for (const body of [
      {},
      { allow: "yes", toolNames: [BROADCAST.name] },
      { allow: true, toolNames: [] },
      { allow: true, toolNames: [7] },
      { allow: true, toolNames: ["x".repeat(201)] }
    ]) {
      expect((await putFlag(ids.userA, id, body)).statusCode).toBe(400);
    }
  });

  it("does not let another owner or an admin set the flag", async () => {
    const id = await sortedConnection(ids.userA, "Owner A private", [[BROADCAST, "outbound"]]);

    for (const other of [ids.userB, ids.adminUser]) {
      const res = await putFlag(other, id, { allow: true, toolNames: [BROADCAST.name] });
      expect(res.statusCode).toBe(404);
    }
    const row = await as(ids.userA, (scopedDb) => repository.getConnection(scopedDb, id));
    expect(row!.classifierSort.entries[BROADCAST.name]!.sendWithoutAsking).toBe(false);
  });

  it("reads the mark only through the owner's own row", async () => {
    // Owner B sorts the tools as safe on B's connection; owner A's same-named tools stay unsorted.
    const idB = await sortedConnection(ids.userB, "Owner B safe", [
      [TURN_ON, "write"],
      [BROADCAST, "outbound"]
    ]);
    await as(ids.userB, (scopedDb) =>
      repository.setClassifierSendWithoutAsking(scopedDb, idB, [BROADCAST.name], true)
    );
    await sortedConnection(ids.userA, "Owner A unsorted", []);

    const turnOnB = await listedTool(ids.userB, "Owner B safe", TURN_ON.name);
    const broadcastB = await listedTool(ids.userB, "Owner B safe", BROADCAST.name);
    expect(await runsWithoutAsking(turnOnB, ids.userB)).toBe(true);
    expect(await runsWithoutAsking(broadcastB, ids.userB)).toBe(true);

    // B's sort never marks A's unsorted tool safe.
    for (const name of [TURN_ON.name, BROADCAST.name]) {
      const toolA = await listedTool(ids.userA, "Owner A unsorted", name);
      expect(await runsWithoutAsking(toolA, ids.userA)).toBe(false);
    }

    // B's tools, checked under another owner's or an admin's data context, cannot see B's row.
    for (const other of [ids.userA, ids.adminUser]) {
      expect(await runsWithoutAsking(turnOnB, other)).toBe(false);
      expect(await runsWithoutAsking(broadcastB, other)).toBe(false);
    }
  });
});
