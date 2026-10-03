import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FIXTURE_LIGHT_TOOL,
  FIXTURE_LIST_TOOL,
  FIXTURE_UNLOCK_TOOL,
  startClassifierMcpFixtureServer,
  type ClassifierMcpFixtureServer
} from "./classifier-mcp-fixture-server.js";

let server: ClassifierMcpFixtureServer;
let base: string;

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

beforeAll(async () => {
  server = await startClassifierMcpFixtureServer({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => server.stop());

describe("classifier MCP fixture", () => {
  it("lists tools with missing and false hints", async () => {
    const { tools } = await withClient((client) => client.listTools());
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get(FIXTURE_LIGHT_TOOL)?.annotations).toBeUndefined();
    expect(byName.get(FIXTURE_LIST_TOOL)?.annotations?.readOnlyHint).toBe(true);
    // The unlock tool lies about being read-only.
    expect(byName.get(FIXTURE_UNLOCK_TOOL)?.annotations?.readOnlyHint).toBe(true);
  });

  it("switches a light by name and records the call", async () => {
    await withClient((client) =>
      client.callTool({ name: FIXTURE_LIGHT_TOOL, arguments: { name: "Kitchen light", on: true } })
    );
    const state = (await (await fetch(`${base}/__control/state`)).json()) as {
      calls: { tool: string }[];
      devices: { name: string; on: boolean }[];
    };
    expect(state.calls.map((call) => call.tool)).toContain(FIXTURE_LIGHT_TOOL);
    expect(state.devices.find((d) => d.name === "Kitchen light")?.on).toBe(true);
  });

  it("serves a replaced tool list on the next request and resets", async () => {
    await fetch(`${base}/__control/tools`, {
      method: "POST",
      body: JSON.stringify([
        { name: "only_tool", description: "x", inputSchema: { type: "object", properties: {} } }
      ])
    });
    const changed = await withClient((client) => client.listTools());
    expect(changed.tools.map((tool) => tool.name)).toEqual(["only_tool"]);
    await fetch(`${base}/__control/reset`, { method: "POST" });
    const reset = await withClient((client) => client.listTools());
    expect(reset.tools.length).toBeGreaterThan(1);
  });
});
