import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { DataContextRunner } from "@moss/db";
import type { ModuleAssistantToolManifest, ToolContext } from "@moss/module-sdk";
import {
  createCallMemory,
  createIntegrationsActiveModulesResolver,
  createIntegrationsCipher,
  createResolverCache,
  emptySortMap,
  toolRiskInputs,
  toolSortFingerprint,
  withSendWithoutAsking,
  withSortResult,
  type ClassifierSortMap,
  type ConnectionRow,
  type DiscoveredTool
} from "@moss/integrations";
import type { IntegrationClassifierRisk } from "@moss/shared";

/**
 * #2984 R2.3, spec 8.3: a connected tool's sorted-safe mark is read from the owner's own row at
 * call time, so a later sort, send choice or definition change counts at the next call.
 */

const ctx: ToolContext = { actorUserId: "actor-1", requestId: "req-1", chatSessionId: "sess-1" };

function webTool(method: string, extra: Partial<DiscoveredTool> = {}): DiscoveredTool {
  return {
    name: "updateMovie",
    description: "Change a movie",
    group: "",
    inputSchema: {},
    invoke: { method, path: "/x", params: [], hasBody: false },
    ...extra
  };
}

function sorted(
  tool: DiscoveredTool,
  risk: IntegrationClassifierRisk,
  map: ClassifierSortMap = emptySortMap()
): ClassifierSortMap {
  const next = withSortResult(map, tool.name, {
    status: "current",
    risk,
    readableName: "Readable",
    sortFingerprint: toolSortFingerprint(toolRiskInputs(tool)),
    sortedAt: "2026-10-04T00:00:00.000Z"
  });
  if (!next) throw new Error("sort result was not storable");
  return next;
}

function connection(overrides: Partial<ConnectionRow>): ConnectionRow {
  return {
    id: "conn-1",
    ownerUserId: "actor-1",
    name: "Conn",
    kind: "openapi",
    transport: "http",
    url: "http://example.com",
    credentialPlacement: null,
    hasCredential: false,
    enabled: true,
    baseUrl: "http://127.0.0.1:9",
    specPasted: false,
    enabledGroups: [],
    enabledTools: [],
    mutedTools: [],
    unsuppressedTools: [],
    classifierEnabled: false,
    classifierPreparation: { version: 1, entries: {} },
    classifierSort: emptySortMap(),
    classifierKeptOutTools: [],
    discoveredTools: [],
    lastDiscoveryAt: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  };
}

const SCOPED_DB = { scoped: true };

/**
 * The listing is built once from `listed`. `fresh` is what the owner's row holds when the hook
 * runs; reassign it between calls to model a later change.
 */
async function build(listed: ConnectionRow) {
  const state: { fresh: ConnectionRow | null | "throws"; reads: unknown[] } = {
    fresh: listed,
    reads: []
  };
  const dataContext = {
    withDataContext: async (_ctx: unknown, work: (scopedDb: unknown) => unknown) => work(SCOPED_DB)
  } as unknown as DataContextRunner;
  const resolver = createIntegrationsActiveModulesResolver(async () => [], {
    dataContext,
    cipher: createIntegrationsCipher(),
    logger: { warn: () => {} },
    callMemory: createCallMemory(),
    resolverCache: createResolverCache(),
    repository: {
      listConnections: async () => [listed],
      loadCredentialEnvelope: async () => null,
      getConnection: async (scopedDb: unknown, id: string) => {
        state.reads.push({ scopedDb, id });
        if (state.fresh === "throws") throw new Error("row unreadable");
        return state.fresh;
      }
    } as never
  });
  const modules = await resolver("actor-1");
  const tool = modules[0]!.assistantTools![0]! as ModuleAssistantToolManifest;
  const ask = () => Promise.resolve(tool.runsWithoutAsking!(SCOPED_DB, ctx));
  return { tool, ask, state };
}

describe("connected tool runsWithoutAsking (#2984 R2.3)", () => {
  it("reads the owner's row at call time, so a new sort counts at the next call", async () => {
    const put = webTool("PUT");
    const listed = connection({ discoveredTools: [put], classifierSort: sorted(put, "write") });
    const { ask, state } = await build(listed);

    expect(await ask()).toBe(true);
    expect(state.reads).toEqual([{ scopedDb: SCOPED_DB, id: "conn-1" }]);

    state.fresh = { ...listed, classifierSort: sorted(put, "destructive") };
    expect(await ask()).toBe(false);
  });

  it("asks when the stored method changed from PUT to DELETE after a safe sort", async () => {
    const put = webTool("PUT");
    const listed = connection({ discoveredTools: [put], classifierSort: sorted(put, "write") });
    const { ask, state } = await build(listed);

    // The listing still says PUT; the refreshed row says DELETE under the old safe sort.
    state.fresh = { ...listed, discoveredTools: [webTool("DELETE")] };
    expect(await ask()).toBe(false);
  });

  it("asks when the listing's own definition no longer matches the stored one", async () => {
    const put = webTool("PUT");
    const del = webTool("DELETE");
    // A cached listing from before a refresh: the tool that would run is the DELETE one.
    const listed = connection({ discoveredTools: [del], classifierSort: sorted(put, "write") });
    const { ask, state } = await build(listed);
    state.fresh = { ...listed, discoveredTools: [put] };

    expect(await ask()).toBe(false);
  });

  it("asks when the row is gone, switched off, or missing the tool", async () => {
    const put = webTool("PUT");
    const listed = connection({ discoveredTools: [put], classifierSort: sorted(put, "write") });
    const { ask, state } = await build(listed);

    state.fresh = null;
    expect(await ask()).toBe(false);
    state.fresh = { ...listed, enabled: false };
    expect(await ask()).toBe(false);
    state.fresh = { ...listed, discoveredTools: [] };
    expect(await ask()).toBe(false);
  });

  it("lets an unreadable row fail the check, which the gateway treats as asking", async () => {
    const put = webTool("PUT");
    const listed = connection({ discoveredTools: [put], classifierSort: sorted(put, "write") });
    const { ask, state } = await build(listed);
    state.fresh = "throws";

    await expect(ask()).rejects.toThrow("row unreadable");
  });

  it("asks for Sends things out until the owner allows it", async () => {
    const post = webTool("POST");
    const outbound = sorted(post, "outbound");
    const listed = connection({ discoveredTools: [post], classifierSort: outbound });
    const { ask, state } = await build(listed);

    expect(await ask()).toBe(false);
    state.fresh = { ...listed, classifierSort: withSendWithoutAsking(outbound, post, true)! };
    expect(await ask()).toBe(true);
  });

  it("keeps manifest risk and execution policy as they are", async () => {
    const put = webTool("PUT");
    const { tool } = await build(
      connection({ discoveredTools: [put], classifierSort: sorted(put, "write") })
    );
    expect(tool.risk).toBe("outbound");
    expect(tool.executionPolicy).toBe("auto");
    expect(tool.isExternal).toBe(true);
  });
});

describe("empty-success reply follows the sort (#2984 R2.3)", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function emptyServer(): Promise<string> {
    const server = createServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () => new Promise<void>((r) => server.close(() => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function actionFor(tool: DiscoveredTool, sort: ClassifierSortMap): Promise<string> {
    const baseUrl = await emptyServer();
    const { tool: manifest } = await build(
      connection({ baseUrl, discoveredTools: [tool], classifierSort: sort })
    );
    const result = await manifest.execute!({}, {}, ctx);
    return (result.data as { action: string }).action;
  }

  it("a current Looks things up sort reads, even without the server's read hint", async () => {
    const tool = webTool("POST");
    expect(await actionFor(tool, sorted(tool, "read"))).toBe("read");
  });

  it("a current Changes things sort performs, even with the server's read hint", async () => {
    const tool = webTool("GET", { readOnly: true });
    expect(await actionFor(tool, sorted(tool, "write"))).toBe("performed");
  });

  it("an unsorted tool keeps the server's read hint", async () => {
    const tool = webTool("GET", { readOnly: true });
    expect(await actionFor(tool, emptySortMap())).toBe("read");
  });
});
