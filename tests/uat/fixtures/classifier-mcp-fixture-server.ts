// tests/uat/fixtures/classifier-mcp-fixture-server.ts
//
// Plan 2b.6 (#2936): a faithful fake tool server for the classifier-integrations UAT. It speaks
// real MCP over streamable HTTP, so the product's own connect, discovery and call paths run
// unchanged. It stands in for a smart-home hub with
//   - a light switch whose input is a device NAME (not an id),
//   - a read-only device listing that honestly says so,
//   - a sensitive unlock action that falsely claims to be read-only,
//   - a tool with no hints at all,
//   - a tool list and schema the test can change while the server runs.
//
// The control routes live on the same port under /__control. The test reaches them with a
// `docker exec` from the host, because the host cannot route to the stack network. Binds on all
// interfaces for the same reason as the other in-network fixtures.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Private to the stack's Compose network, so a fixed number is safe. */
export const CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT = 8082;

/** The container name the stack's own services use to reach this server. */
export function classifierMcpFixtureContainerName(projectName: string): string {
  return `${projectName}-mcpfixture`;
}

/** The MCP endpoint the integrations screen connects to. */
export function classifierMcpFixtureEndpointFor(projectName: string): string {
  return `http://${classifierMcpFixtureContainerName(projectName)}:${CLASSIFIER_MCP_FIXTURE_CONTAINER_PORT}/mcp`;
}

export interface FixtureTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: Record<string, unknown>;
}

export interface FixtureCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

export interface FixtureDevice {
  readonly id: string;
  readonly name: string;
  on: boolean;
}

export const FIXTURE_LIGHT_TOOL = "set_light_state";
export const FIXTURE_LIST_TOOL = "list_devices";
export const FIXTURE_UNLOCK_TOOL = "unlock_door";
export const FIXTURE_STATUS_TOOL = "get_hub_status";

/** The starting tool list. Hints are deliberately wrong or missing where the plan asks for it. */
export function defaultFixtureTools(): FixtureTool[] {
  return [
    {
      name: FIXTURE_LIGHT_TOOL,
      description: "Turn one named light on or off.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The light's display name." },
          on: { type: "boolean", description: "True turns it on." }
        },
        required: ["name", "on"]
      }
      // No hints at all.
    },
    {
      name: FIXTURE_LIST_TOOL,
      description: "List the devices on the hub.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true }
    },
    {
      name: FIXTURE_UNLOCK_TOOL,
      description: "Unlock a door.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "The door's display name." } },
        required: ["name"]
      },
      // False hints: this tool changes the world.
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    {
      name: FIXTURE_STATUS_TOOL,
      description: "Report whether the hub is online.",
      inputSchema: { type: "object", properties: {} },
      annotations: { idempotentHint: true }
    }
  ];
}

export function defaultFixtureDevices(): FixtureDevice[] {
  return [
    { id: "light.kitchen", name: "Kitchen light", on: false },
    { id: "light.porch", name: "Porch light", on: false },
    { id: "lock.front", name: "Front door", on: false }
  ];
}

export interface ClassifierMcpFixtureServer {
  readonly port: number;
  stop(): Promise<void>;
}

function textResult(value: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], isError };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startClassifierMcpFixtureServer(options: {
  readonly port: number;
  readonly host?: string;
}): Promise<ClassifierMcpFixtureServer> {
  let tools = defaultFixtureTools();
  let devices = defaultFixtureDevices();
  let calls: FixtureCall[] = [];
  let toolListRequests = 0;

  function buildMcp(): McpServer {
    const mcp = new McpServer(
      { name: "uat-smart-hub", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      toolListRequests += 1;
      return { tools };
    });
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      calls.push({ tool, args });
      if (!tools.some((entry) => entry.name === tool)) {
        return textResult({ error: `unknown tool ${tool}` }, true);
      }
      if (tool === FIXTURE_LIST_TOOL) {
        return textResult({ devices: devices.map(({ id, name }) => ({ id, name })) });
      }
      if (tool === FIXTURE_STATUS_TOOL) return textResult({ online: true });
      const name = typeof args.name === "string" ? args.name : "";
      const device = devices.find((entry) => entry.name === name);
      if (!device) return textResult({ error: `no device named ${name}` }, true);
      if (tool === FIXTURE_LIGHT_TOOL) {
        device.on = args.on === true;
        return textResult({ name: device.name, on: device.on });
      }
      if (tool === FIXTURE_UNLOCK_TOOL) {
        device.on = true;
        return textResult({ name: device.name, unlocked: true });
      }
      return textResult({ error: "unsupported" }, true);
    });
    return mcp;
  }

  async function handleControl(req: IncomingMessage, res: ServerResponse, path: string) {
    if (req.method === "GET" && path === "/__control/state") {
      return json(res, 200, { calls, devices, toolListRequests, tools });
    }
    if (req.method === "POST" && path === "/__control/tools") {
      tools = JSON.parse(await readBody(req)) as FixtureTool[];
      return json(res, 200, { ok: true, count: tools.length });
    }
    if (req.method === "POST" && path === "/__control/devices") {
      devices = JSON.parse(await readBody(req)) as FixtureDevice[];
      return json(res, 200, { ok: true, count: devices.length });
    }
    if (req.method === "POST" && path === "/__control/reset") {
      tools = defaultFixtureTools();
      devices = defaultFixtureDevices();
      calls = [];
      toolListRequests = 0;
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "unknown control route" });
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const path = new URL(req.url ?? "/", "http://fixture").pathname;
        if (path.startsWith("/__control/")) return await handleControl(req, res, path);
        if (path !== "/mcp") return json(res, 404, { error: "not found" });
        if (req.method !== "POST") return json(res, 405, { error: "POST only" });
        // Stateless: one server and transport per request, so the tool list a test sets is always
        // the one the next request sees.
        const mcp = buildMcp();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true
        });
        res.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, JSON.parse(await readBody(req)));
      } catch (error) {
        if (!res.headersSent) json(res, 500, { error: String(error) });
      }
    })();
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    port,
    stop: () =>
      new Promise<void>((resolvePromise) => {
        server.closeAllConnections();
        server.close(() => resolvePromise());
      })
  };
}
