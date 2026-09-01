import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { DataContextRunner } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import {
  createCallMemory,
  createIntegrationsActiveModulesResolver,
  createIntegrationsCipher,
  INTEGRATION_SUMMARY
} from "@moss/integrations";
import type { ConnectionRow, DiscoveredTool } from "@moss/integrations";

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(req.url ?? "");
    handler(req, res);
  });
  return new Promise<{ baseUrl: string; calls: string[]; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          calls,
          close: () => new Promise<void>((r) => server.close(() => r()))
        });
      });
    }
  );
}

function connection(overrides: Partial<ConnectionRow>): ConnectionRow {
  return {
    id: "conn-1",
    ownerUserId: "owner",
    name: "Conn",
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

function fakeDataContext(): DataContextRunner {
  return {
    withDataContext: async (_ctx: unknown, work: (scopedDb: unknown) => unknown) => work({})
  } as unknown as DataContextRunner;
}

function readTool(name: string, extra: Partial<DiscoveredTool> = {}): DiscoveredTool {
  return {
    name,
    description: name,
    group: "",
    inputSchema: {},
    readOnly: true,
    invoke: { method: "GET", path: `/${name}`, params: [], hasBody: false },
    ...extra
  };
}

function performedTool(name: string, extra: Partial<DiscoveredTool> = {}): DiscoveredTool {
  return {
    name,
    description: name,
    group: "",
    inputSchema: {},
    invoke: { method: "POST", path: `/${name}`, params: [], hasBody: false },
    ...extra
  };
}

const ctx: ToolContext = { actorUserId: "actor-1", requestId: "req-1", chatSessionId: "sess-1" };

async function buildTools(
  baseUrl: string,
  tools: DiscoveredTool[],
  connOverrides: Partial<ConnectionRow> = {}
) {
  const resolver = createIntegrationsActiveModulesResolver(async () => [], {
    dataContext: fakeDataContext(),
    cipher: createIntegrationsCipher(),
    logger: { warn: () => {} },
    callMemory: createCallMemory(),
    repository: {
      listConnections: async () => [
        connection({ baseUrl, discoveredTools: tools, ...connOverrides })
      ],
      loadCredentialEnvelope: async () => null
    } as never
  });
  const modules = await resolver("actor-1");
  const manifestTools = modules[0]!.assistantTools ?? [];
  return Object.fromEntries(manifestTools.map((t) => [t.name.split(".").pop(), t.execute!]));
}

describe("integration in-burst duplicate suppression (#2175 Task 3)", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("serves a repeated read from the store instead of calling the service again", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ on: true }));
    });
    close = started.close;

    const { get_state } = await buildTools(started.baseUrl, [readTool("get_state")]);
    const first = await get_state!({}, {}, ctx);
    const second = await get_state!({}, {}, ctx);

    expect(started.calls).toHaveLength(1);
    expect(first.data).toMatchObject({
      status: "ok",
      action: "read",
      summary: INTEGRATION_SUMMARY.readOk
    });
    expect(second.data).toMatchObject({
      status: "ok",
      action: "read",
      summary: INTEGRATION_SUMMARY.blockedRead
    });
    expect((second.data as { detail: unknown }).detail).toEqual(
      (first.data as { detail: unknown }).detail
    );
  });

  it("re-runs a read for real once a performed call on the connection succeeds", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    close = started.close;

    const { get_state, turn_off } = await buildTools(started.baseUrl, [
      readTool("get_state"),
      performedTool("turn_off")
    ]);

    await get_state!({}, {}, ctx);
    await turn_off!({}, {}, ctx);
    await get_state!({}, {}, ctx);

    const stateCalls = started.calls.filter((u) => u === "/get_state");
    expect(stateCalls).toHaveLength(2);
  });

  it("blocks a repeated performed call and reports it plainly", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    close = started.close;

    const { turn_off } = await buildTools(started.baseUrl, [performedTool("turn_off")]);
    const first = await turn_off!({}, {}, ctx);
    const second = await turn_off!({}, {}, ctx);

    expect(started.calls).toHaveLength(1);
    expect(first.data).toMatchObject({ status: "ok", summary: INTEGRATION_SUMMARY.performedOk });
    expect(second.data).toMatchObject({
      status: "ok",
      summary: INTEGRATION_SUMMARY.blockedPerformed
    });
    expect((second.data as { detail: unknown }).detail).toBeUndefined();
  });

  it("re-runs a repeated performed call the service marked idempotent", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    close = started.close;

    const { skip_track } = await buildTools(started.baseUrl, [
      performedTool("skip_track", { idempotent: true })
    ]);
    await skip_track!({}, {}, ctx);
    await skip_track!({}, {}, ctx);

    expect(started.calls).toHaveLength(2);
  });

  it("re-runs a repeated performed call for a tool named in the connection's escape hatch", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    close = started.close;

    const { volume_up } = await buildTools(started.baseUrl, [performedTool("volume_up")], {
      unsuppressedTools: ["volume_up"]
    });
    await volume_up!({}, {}, ctx);
    await volume_up!({}, {}, ctx);

    expect(started.calls).toHaveLength(2);
  });

  it("does not block a repeated performed call after a failed attempt", async () => {
    let attempt = 0;
    const started = await startServer((_req, res) => {
      attempt += 1;
      if (attempt === 1) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    close = started.close;

    const { turn_off } = await buildTools(started.baseUrl, [performedTool("turn_off")]);
    const first = await turn_off!({}, {}, ctx);
    const second = await turn_off!({}, {}, ctx);

    expect(started.calls).toHaveLength(2);
    expect(first.data).toMatchObject({ status: "error" });
    expect(second.data).toMatchObject({ status: "ok", summary: INTEGRATION_SUMMARY.performedOk });
  });
});
