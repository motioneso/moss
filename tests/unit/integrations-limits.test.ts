import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { DataContextRunner } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import {
  capChars,
  createCallMemory,
  createIntegrationsActiveModulesResolver,
  createIntegrationsCipher,
  createRequestBudget,
  INTEGRATION_CALL_CEILING,
  INTEGRATION_REQUEST_CHAR_BUDGET,
  INTEGRATION_RESPONSE_CHAR_CAP,
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

function fakeDataContext(): DataContextRunner {
  return {
    withDataContext: async (_ctx: unknown, work: (scopedDb: unknown) => unknown) => work({})
  } as unknown as DataContextRunner;
}

async function buildTools(baseUrl: string, tools: DiscoveredTool[]) {
  const resolver = createIntegrationsActiveModulesResolver(async () => [], {
    dataContext: fakeDataContext(),
    cipher: createIntegrationsCipher(),
    logger: { warn: () => {} },
    callMemory: createCallMemory(),
    requestBudget: createRequestBudget(),
    repository: {
      listConnections: async () => [connection({ baseUrl, discoveredTools: tools })],
      loadCredentialEnvelope: async () => null
    } as never
  });
  const modules = await resolver("actor-1");
  const manifestTools = modules[0]!.assistantTools ?? [];
  return Object.fromEntries(manifestTools.map((t) => [t.name.split(".").pop(), t.execute!]));
}

function ctxFor(requestId: string): ToolContext {
  return { actorUserId: "actor-1", requestId, chatSessionId: `sess-${requestId}` };
}

describe("capChars (#2175 Task 4)", () => {
  it("leaves a response exactly at the cap untouched", () => {
    const detail = "x".repeat(INTEGRATION_RESPONSE_CHAR_CAP);
    const result = capChars(detail, INTEGRATION_RESPONSE_CHAR_CAP);
    expect(result.truncated).toBe(false);
    expect(result.detail).toBe(detail);
    expect(result.rawChars).toBe(INTEGRATION_RESPONSE_CHAR_CAP);
  });

  it("truncates a response one character over the cap and reports the raw size", () => {
    const detail = "x".repeat(INTEGRATION_RESPONSE_CHAR_CAP + 1);
    const result = capChars(detail, INTEGRATION_RESPONSE_CHAR_CAP);
    expect(result.truncated).toBe(true);
    expect(result.rawChars).toBe(INTEGRATION_RESPONSE_CHAR_CAP + 1);
    expect((result.detail as string).length).toBe(INTEGRATION_RESPONSE_CHAR_CAP);
  });
});

describe("request budget (#2175 Task 4)", () => {
  it("refuses the call once the per-request ceiling is reached", () => {
    const budget = createRequestBudget();
    const scope = { actorUserId: "actor-1", requestId: "req-1" };
    for (let i = 0; i < INTEGRATION_CALL_CEILING; i++) {
      expect(budget.reserveCall(scope)).toBe(true);
    }
    expect(budget.reserveCall(scope)).toBe(false);
  });

  it("refuses further calls once the combined char budget is spent", () => {
    const budget = createRequestBudget();
    const scope = { actorUserId: "actor-1", requestId: "req-1" };
    expect(budget.reserveCall(scope)).toBe(true);
    budget.recordChars(scope, INTEGRATION_REQUEST_CHAR_BUDGET);
    expect(budget.reserveCall(scope)).toBe(false);
  });

  it("keeps separate requests independent", () => {
    const budget = createRequestBudget();
    const first = { actorUserId: "actor-1", requestId: "req-1" };
    const second = { actorUserId: "actor-1", requestId: "req-2" };
    for (let i = 0; i < INTEGRATION_CALL_CEILING; i++) budget.reserveCall(first);
    expect(budget.reserveCall(first)).toBe(false);
    expect(budget.reserveCall(second)).toBe(true);
  });
});

describe("integration call ceiling and size budget end-to-end (#2175 Task 4)", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("refuses the 13th call in one request without contacting the service", async () => {
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ n: 1 }));
    });
    close = started.close;

    const { get_state } = await buildTools(started.baseUrl, [readTool("get_state")]);
    const ctx = ctxFor("req-ceiling");
    for (let i = 0; i < INTEGRATION_CALL_CEILING; i++) {
      await get_state!({}, { i }, ctx);
    }
    const refused = await get_state!({}, { n: "unique-arg" }, ctx);

    expect(started.calls).toHaveLength(INTEGRATION_CALL_CEILING);
    expect(refused.data).toMatchObject({
      status: "error",
      summary: INTEGRATION_SUMMARY.requestRefused
    });
  });

  it("truncates a single response over 8,000 characters and says so in the summary", async () => {
    const huge = "y".repeat(INTEGRATION_RESPONSE_CHAR_CAP + 1000);
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(huge);
    });
    close = started.close;

    const { get_state } = await buildTools(started.baseUrl, [readTool("get_state")]);
    const result = await get_state!({}, { q: "single" }, ctxFor("req-single"));

    expect(result.data).toMatchObject({ status: "ok", summary: INTEGRATION_SUMMARY.truncated });
  });

  it("completes the call that crosses the combined 24,000-char budget, then refuses the next one", async () => {
    const chunk = "z".repeat(8_000);
    const started = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(chunk);
    });
    close = started.close;

    const { get_state } = await buildTools(started.baseUrl, [readTool("get_state")]);
    const ctx = ctxFor("req-budget");

    const first = await get_state!({}, { a: 1 }, ctx);
    const second = await get_state!({}, { a: 2 }, ctx);
    const third = await get_state!({}, { a: 3 }, ctx);
    const fourth = await get_state!({}, { a: 4 }, ctx);

    expect(first.data).toMatchObject({ status: "ok" });
    expect(second.data).toMatchObject({ status: "ok" });
    expect(third.data).toMatchObject({ status: "ok" });
    expect(started.calls).toHaveLength(3);
    expect(fourth.data).toMatchObject({
      status: "error",
      summary: INTEGRATION_SUMMARY.requestRefused
    });
  });
});
