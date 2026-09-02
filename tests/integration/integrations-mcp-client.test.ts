import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  callMcpTool,
  createMcpConnectionCache,
  discoverMcpTools,
  IntegrationUserError
} from "@moss/integrations";

const SECRET = "sk-super-secret-mcp-value";

const TOOLS = [
  {
    name: "add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"]
    }
  },
  {
    // A root-level `anyOf` combinator alongside the object type the MCP wire schema requires.
    // `convertOpenApiSpec` would never emit this, but a real MCP server can. Discovery must
    // still report it as-is — the skip is a registration-time decision made later (Task 8),
    // not a discovery-time one.
    name: "either",
    description: "Accepts either shape",
    inputSchema: {
      type: "object",
      anyOf: [{ properties: { x: { type: "string" } } }, { properties: { y: { type: "number" } } }]
    }
  }
];

function buildServer(): Server {
  const server = new Server(
    { name: "fixture-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "add") {
      const { a, b } = req.params.arguments as { a: number; b: number };
      return { content: [{ type: "text", text: String(a + b) }] };
    }
    return { isError: true, content: [{ type: "text", text: `Unknown tool ${req.params.name}` }] };
  });
  return server;
}

async function startMcpServer() {
  let seenAuth = "";
  let initializeCount = 0;

  // Stateless mode (sessionIdGenerator: undefined): the SDK's own docs build a fresh Server +
  // transport pair per request rather than reusing one Server, since a Server can only ever be
  // connected to a single transport at a time.
  const httpServer = createServer((req, res) => {
    seenAuth = req.headers.authorization ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        // A held client only ever sends "initialize" once, at connect time — a fresh connect
        // per call would send it again on every call. Counting it is how the test below observes
        // connection reuse without reaching into the client's internals.
        if (body?.method === "initialize") initializeCount += 1;
        const server = buildServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      })();
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    getSeenAuth: () => seenAuth,
    getInitializeCount: () => initializeCount,
    close: () => new Promise<void>((r) => httpServer.close(() => r()))
  };
}

describe("discoverMcpTools / callMcpTool", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("discovers both tools as DiscoveredTools with an empty group and no invoke", async () => {
    const fixture = await startMcpServer();
    close = fixture.close;

    const tools = await discoverMcpTools(fixture.url, SECRET, { kind: "bearer" });

    expect(fixture.getSeenAuth()).toBe(`Bearer ${SECRET}`);
    expect(tools).toHaveLength(2);
    for (const t of tools) {
      expect(t.group).toBe("");
      expect(t.invoke).toBeUndefined();
    }
    const either = tools.find((t) => t.name === "either");
    expect(either?.inputSchema).toMatchObject({ anyOf: expect.any(Array) });
  });

  it("calls the valid tool and returns its text content", async () => {
    const fixture = await startMcpServer();
    close = fixture.close;

    const result = await callMcpTool("user-1", "conn-valid", fixture.url, null, null, "add", {
      a: 2,
      b: 3
    });

    expect(result.ok).toBe(true);
    expect(result.data.result).toBe("5");
  });

  it("never leaks the credential value into a thrown error", async () => {
    try {
      await discoverMcpTools("http://127.0.0.1:1", SECRET, { kind: "bearer" });
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message ?? err)).not.toContain(SECRET);
    }
  });

  it("wraps a callMcpTool connect failure in a plain-English error that does not leak the credential", async () => {
    try {
      await callMcpTool(
        "user-1",
        "conn-bad-1",
        "http://127.0.0.1:1",
        SECRET,
        { kind: "bearer" },
        "add",
        { a: 1, b: 2 }
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationUserError);
      const message = String((err as Error).message ?? err);
      expect(message).not.toContain(SECRET);
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("never leaks a query-placed credential into a callMcpTool connect failure", async () => {
    try {
      await callMcpTool(
        "user-1",
        "conn-bad-2",
        "http://127.0.0.1:1",
        SECRET,
        { kind: "query", name: "api_key" },
        "add",
        { a: 1, b: 2 }
      );
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message ?? err)).not.toContain(SECRET);
    }
  });

  it("reuses one connection across several calls in a burst (#2175 Task 9)", async () => {
    const fixture = await startMcpServer();
    close = fixture.close;
    const cache = createMcpConnectionCache();

    for (let i = 0; i < 3; i++) {
      const result = await callMcpTool(
        "user-1",
        "conn-burst",
        fixture.url,
        null,
        null,
        "add",
        { a: 1, b: i },
        { cache }
      );
      expect(result.ok).toBe(true);
    }

    expect(fixture.getInitializeCount()).toBe(1);
  });

  it("never pools a held connection across users, even for the same connection id", async () => {
    const fixture = await startMcpServer();
    close = fixture.close;
    const cache = createMcpConnectionCache();

    await callMcpTool("user-a", "conn-shared", fixture.url, null, null, "add", { a: 1, b: 1 }, {
      cache
    });
    await callMcpTool("user-b", "conn-shared", fixture.url, null, null, "add", { a: 1, b: 1 }, {
      cache
    });

    expect(fixture.getInitializeCount()).toBe(2);
  });

  it("reconnects once, without surfacing an error, when a held connection is stale", async () => {
    const fixture = await startMcpServer();
    close = fixture.close;
    const cache = createMcpConnectionCache();

    const first = await callMcpTool(
      "user-1",
      "conn-stale",
      fixture.url,
      null,
      null,
      "add",
      { a: 2, b: 2 },
      { cache }
    );
    expect(first.ok).toBe(true);
    expect(fixture.getInitializeCount()).toBe(1);

    // The fixture server drops its whole HTTP process below, simulating the held client's
    // transport having gone bad server-side (e.g. a restart) between two calls in the same burst.
    await fixture.close();
    const replacement = await startMcpServer();
    close = replacement.close;

    // Same actor+connection key, but callMcpTool only ever sees `url` as a parameter to the
    // connect() it retries with, never as part of the cache key — pointing it at the new
    // fixture's URL stands in for "the same connection is reachable again after the outage".
    const second = await callMcpTool(
      "user-1",
      "conn-stale",
      replacement.url,
      null,
      null,
      "add",
      { a: 3, b: 3 },
      { cache }
    );
    expect(second.ok).toBe(true);
    expect(second.data.result).toBe("6");
    expect(replacement.getInitializeCount()).toBe(1);
  });
});
