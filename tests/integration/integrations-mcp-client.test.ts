import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { callMcpTool, discoverMcpTools, IntegrationUserError } from "@moss/integrations";

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
  const server = new Server({ name: "fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
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

    const result = await callMcpTool(fixture.url, null, null, "add", { a: 2, b: 3 });

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
      await callMcpTool("http://127.0.0.1:1", SECRET, { kind: "bearer" }, "add", { a: 1, b: 2 });
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
});
