import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CredentialPlacement } from "@moss/shared";

import { applyCredential } from "./credentials.js";
import { IntegrationUserError } from "./errors.js";
import { DISCOVERY_TIMEOUT_MS, retryOnce, TOOL_CALL_TIMEOUT_MS } from "./limits.js";
import type { DiscoveredTool } from "./openapi-convert.js";

async function connect(rawUrl: string, secret: string | null, placement: CredentialPlacement | null) {
  const url = new URL(rawUrl);
  const headers = new Headers();
  applyCredential(placement, secret, url, headers);
  const requestInit = { headers: Object.fromEntries(headers.entries()) };
  const client = new Client({ name: "moss-integrations", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
  } catch {
    await client.connect(new SSEClientTransport(url, { requestInit }));
  }
  return client;
}

export async function discoverMcpTools(
  url: string,
  secret: string | null,
  placement: CredentialPlacement | null
): Promise<DiscoveredTool[]> {
  const client = await connect(url, secret, placement).catch(() => {
    throw new IntegrationUserError("Could not reach an MCP server at that URL.");
  });
  try {
    const res = await client.listTools({}, { timeout: DISCOVERY_TIMEOUT_MS });
    return res.tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      group: "",
      inputSchema: (t.inputSchema as Record<string, unknown> | undefined) ?? null
    }));
  } finally {
    await client.close().catch(() => {});
  }
}

export async function callMcpTool(
  url: string,
  secret: string | null,
  placement: CredentialPlacement | null,
  toolName: string,
  input: Record<string, unknown>
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const client = await connect(url, secret, placement);
  try {
    const res = await retryOnce(() =>
      client.callTool({ name: toolName, arguments: input }, undefined, { timeout: TOOL_CALL_TIMEOUT_MS })
    );
    const text =
      (res.content as { type: string; text?: string }[] | undefined)
        ?.filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n") ?? "";
    return { ok: res.isError !== true, data: { result: text } };
  } finally {
    await client.close().catch(() => {});
  }
}
