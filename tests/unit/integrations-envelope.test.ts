import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { DataContextRunner } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import {
  createIntegrationsActiveModulesResolver,
  createIntegrationsCipher,
  INTEGRATION_SUMMARY
} from "@moss/integrations";
import type { ConnectionRow, DiscoveredTool } from "@moss/integrations";

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r()))
      });
    });
  });
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

const ctx: ToolContext = { actorUserId: "actor-1", requestId: "req-1", chatSessionId: "sess-1" };

async function buildExecute(baseUrl: string, tool: DiscoveredTool) {
  const resolver = createIntegrationsActiveModulesResolver(async () => [], {
    dataContext: fakeDataContext(),
    cipher: createIntegrationsCipher(),
    logger: { warn: () => {} },
    repository: {
      listConnections: async () => [
        connection({ id: "conn-1", name: "Conn", baseUrl, discoveredTools: [tool] })
      ],
      loadCredentialEnvelope: async () => null
    } as never
  });
  const modules = await resolver("actor-1");
  const tools = modules[0]!.assistantTools ?? [];
  return tools[0]!.execute!;
}

function getTool(name: string, extra: Partial<DiscoveredTool> = {}): DiscoveredTool {
  return {
    name,
    description: name,
    group: "",
    inputSchema: {},
    readOnly: true,
    invoke: { method: "GET", path: "/x", params: [], hasBody: false },
    ...extra
  };
}

function postTool(name: string, extra: Partial<DiscoveredTool> = {}): DiscoveredTool {
  return {
    name,
    description: name,
    group: "",
    inputSchema: {},
    invoke: { method: "POST", path: "/x", params: [], hasBody: false },
    ...extra
  };
}

describe("integration outcome envelope", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("wraps a successful read-only tool call as status ok, action read", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ temp: 70 }));
    });
    close = started.close;

    const execute = await buildExecute(started.baseUrl, getTool("get_state"));
    const result = await execute({}, {}, ctx);

    expect(result.data).toMatchObject({
      status: "ok",
      action: "read",
      summary: INTEGRATION_SUMMARY.readOk
    });
    expect((result.data as { detail: unknown }).detail).toEqual({
      status: 200,
      result: { temp: 70 }
    });
  });

  it("wraps a successful non-read-only tool call as status ok, action performed", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ done: true }));
    });
    close = started.close;

    const execute = await buildExecute(started.baseUrl, postTool("switch_off"));
    const result = await execute({}, {}, ctx);

    expect(result.data).toMatchObject({
      status: "ok",
      action: "performed",
      summary: INTEGRATION_SUMMARY.performedOk
    });
  });

  it("treats an absent readOnly hint as performed, not read", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({}));
    });
    close = started.close;

    const execute = await buildExecute(started.baseUrl, getTool("bare", { readOnly: undefined }));
    const result = await execute({}, {}, ctx);

    expect((result.data as { action: string }).action).toBe("performed");
  });

  it("wraps a failed call as status error with the call-failed summary", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "boom" }));
    });
    close = started.close;

    const execute = await buildExecute(started.baseUrl, getTool("get_state"));
    const result = await execute({}, {}, ctx);

    expect(result.data).toMatchObject({
      status: "error",
      summary: INTEGRATION_SUMMARY.callFailed
    });
  });

  it("passes the service payload through byte-identical as detail", async () => {
    const payload = { nested: { a: [1, 2, 3] }, secretLike: "sk-not-a-real-secret" };
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    close = started.close;

    const execute = await buildExecute(started.baseUrl, getTool("get_state"));
    const result = await execute({}, {}, ctx);

    expect((result.data as { detail: { result: unknown } }).detail.result).toEqual(payload);
  });
});
