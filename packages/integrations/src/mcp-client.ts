import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CredentialPlacement } from "@moss/shared";

import { applyCredential } from "./credentials.js";
import { IntegrationUserError } from "./errors.js";
import { DISCOVERY_TIMEOUT_MS, TOOL_CALL_TIMEOUT_MS } from "./limits.js";
import { mcpConnectionCache, type McpConnectionCache } from "./mcp-connection-cache.js";
import type { DiscoveredTool } from "./openapi-convert.js";

async function connect(
  rawUrl: string,
  secret: string | null,
  placement: CredentialPlacement | null
) {
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

interface McpToolLike {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly destructiveHint?: boolean;
  };
}

export function mapMcpTool(t: McpToolLike): DiscoveredTool {
  const a = t.annotations;
  return {
    name: t.name,
    description: t.description ?? t.name,
    group: "",
    inputSchema: (t.inputSchema as Record<string, unknown> | undefined) ?? null,
    readOnly: typeof a?.readOnlyHint === "boolean" ? a.readOnlyHint : undefined,
    idempotent: typeof a?.idempotentHint === "boolean" ? a.idempotentHint : undefined,
    destructive: typeof a?.destructiveHint === "boolean" ? a.destructiveHint : undefined
  };
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
    return res.tools.map((t) => mapMcpTool(t as McpToolLike));
  } finally {
    await client.close().catch(() => {});
  }
}

export async function callMcpTool(
  actorUserId: string,
  connectionId: string,
  url: string,
  secret: string | null,
  placement: CredentialPlacement | null,
  toolName: string,
  input: Record<string, unknown>,
  deps?: { cache?: McpConnectionCache }
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const cache = deps?.cache ?? mcpConnectionCache;
  const doConnect = () =>
    connect(url, secret, placement).catch(() => {
      throw new IntegrationUserError("Could not reach an MCP server at that URL.");
    });
  return cache.withClient(actorUserId, connectionId, doConnect, async (client) => {
    const res = await client.callTool({ name: toolName, arguments: input }, undefined, {
      timeout: TOOL_CALL_TIMEOUT_MS
    });
    const text =
      (res.content as { type: string; text?: string }[] | undefined)
        ?.filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n") ?? "";
    return { ok: res.isError !== true, data: { result: text } };
  });
}
