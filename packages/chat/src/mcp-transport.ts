import type { FastifyInstance } from "fastify";

import type {
  AssistantToolGateway,
  GatewayToolResponse,
  NativeToolPermissionRequest,
  SessionTokenRegistry
} from "@moss/ai";
import { resolveMossEnv } from "@moss/db";
import { mcpSessionRateLimitKey } from "@moss/module-sdk/server";
import { parsePositiveIntEnv, type AiAssistantToolDto } from "@moss/shared";

const MCP_PROTOCOL_VERSION = "2024-11-05";

// Per-session rate-limit key: only a jst_<uuid> MCP Bearer token earns a per-session bucket
// (hashed to a one-way fingerprint, never the raw token; one token per user/chat session).
// Any other bearer shape — including a malformed/junk token — falls back to the shared
// per-IP bucket, so a caller cannot vary the bearer to mint fresh route-local buckets (#207);
// such requests get a 401 before consuming any AI spend.
//
// Override the limit via env: JARVIS_RL_MCP_MAX=<n> (requests per minute, default 120).
// tools/call is the only method that drives actual AI work; other methods (initialize,
// tools/list, notifications/*) are cheap but share the same counter to avoid bypass.
const MCP_MAX = parsePositiveIntEnv(resolveMossEnv(process.env, "JARVIS_RL_MCP_MAX"), 120);

interface McpRequest {
  jsonrpc: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface McpToolCallParams {
  name: string;
  arguments?: unknown;
}

export interface McpTransportDependencies {
  readonly gateway: AssistantToolGateway;
  readonly tokens: SessionTokenRegistry;
}

/**
 * Registers the MCP JSON-RPC over HTTP endpoint.
 *
 * Supported methods: initialize · notifications/initialized · tools/list · tools/call
 *
 * Security: every request must carry a valid per-session Bearer token. tools/call
 * passes the token to the gateway so identity comes only from the server-minted token
 * (never from the request body).
 */
export function registerMcpTransportRoute(
  server: FastifyInstance,
  deps: McpTransportDependencies
): void {
  server.post<{ Body: McpRequest }>(
    "/api/mcp",
    {
      config: {
        rateLimit: {
          max: MCP_MAX,
          timeWindow: "1 minute",
          keyGenerator: mcpSessionRateLimitKey
        }
      }
    },
    async (request, reply) => {
      const auth = (request.headers.authorization as string | undefined) ?? "";
      if (!auth.startsWith("Bearer ")) {
        return reply.code(401).send(jsonRpcError(null, -32600, "Missing Authorization header"));
      }
      const token = auth.slice(7);
      let identity: ReturnType<typeof deps.tokens.verify>;
      try {
        identity = deps.tokens.verify(token);
      } catch {
        return reply.code(401).send(jsonRpcError(null, -32600, "Invalid or expired session token"));
      }

      const body = request.body as McpRequest;
      const id = body.id ?? null;
      const method = body.method ?? "";

      if (method === "initialize") {
        return reply.code(200).send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "jarvis", version: "0.1.0" }
          }
        });
      }

      if (method.startsWith("notifications/")) {
        return reply.code(204).send();
      }

      if (method === "tools/list") {
        let tools;
        try {
          tools = (await deps.gateway.listToolsForActor(identity.actorUserId)).map(dtoToMcpTool);
        } catch (err) {
          // FAIL CLOSED + scrub: a resolver/DB failure must not expose the tool surface
          // nor leak err.message. Generic internal error; detail logged server-side.
          request.log.error({ err }, "mcp tools/list resolver failed");
          return reply.code(200).send(jsonRpcError(id, -32603, "Internal error"));
        }
        // #2159 — first successful tools/list for this token is the readiness signal
        // ChatSessionManager.launchSession waits on before accepting the session's first message.
        deps.tokens.markToolsListObserved(token);
        return reply.code(200).send({ jsonrpc: "2.0", id, result: { tools } });
      }

      if (method === "tools/call") {
        const params = body.params as McpToolCallParams | undefined;
        if (!params?.name) {
          return reply.code(200).send(jsonRpcError(id, -32602, "tools/call requires params.name"));
        }
        let response: GatewayToolResponse;
        try {
          response = await deps.gateway.callTool(token, params.name, params.arguments ?? {});
        } catch (err) {
          // callTool can now throw resolver/DB errors (async resolver) in addition to
          // invalid-token — never echo err.message (it may carry DB detail). Generic
          // internal error; detail logged server-side only.
          request.log.error({ err }, "mcp tools/call failed");
          return reply.code(200).send(jsonRpcError(id, -32603, "Internal error"));
        }
        return reply.code(200).send({
          jsonrpc: "2.0",
          id,
          result: gatewayResponseToMcp(response)
        });
      }

      return reply.code(200).send(jsonRpcError(id, -32601, `Method not found: ${method}`));
    }
  );
}

export function registerNativePermissionRoute(
  server: FastifyInstance,
  deps: McpTransportDependencies
): void {
  server.post<{ Body: NativePermissionBody }>("/internal/permission", async (request, reply) => {
    const auth = (request.headers.authorization as string | undefined) ?? "";
    if (!auth.startsWith("Bearer ")) {
      return reply.code(401).send({ decision: "deny", reason: "Missing Authorization header" });
    }

    const token = auth.slice(7);
    try {
      deps.tokens.verify(token);
    } catch {
      return reply.code(401).send({ decision: "deny", reason: "Invalid or expired session token" });
    }

    const permissionRequest = parseNativePermissionBody(request.body);
    if (!permissionRequest) {
      return reply.code(200).send({ decision: "deny", reason: "Invalid permission request" });
    }

    try {
      return reply
        .code(200)
        .send(await deps.gateway.requestNativeToolPermission(token, permissionRequest));
    } catch (err) {
      request.log.error({ err }, "native permission request failed");
      return reply
        .code(200)
        .send({ decision: "deny", reason: "Permission gateway failed closed." });
    }
  });
}

function dtoToMcpTool(dto: AiAssistantToolDto) {
  return {
    name: dto.name,
    description: dto.description,
    inputSchema: dto.inputSchema ?? { type: "object" as const, properties: {} }
  };
}

// #1133 — MCP tool-result content is no longer text-only: image attachments surface as
// native image blocks. Exported so tests and future block kinds share one definition.
export type McpContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export function gatewayResponseToMcp(res: GatewayToolResponse) {
  if (res.ok) {
    // #1133 — image tool results (chat.readAttachment) carry `media` past the gateway's
    // text render; emit a native MCP image content block first so image-capable engines
    // render it, with the text block after it naming the file for engines that ignore
    // image blocks (documented degradation, never a hard failure).
    const textBlock: McpContentBlock = { type: "text", text: (res.data as { text: string }).text };
    const content: McpContentBlock[] = res.media
      ? [{ type: "image", data: res.media.base64, mimeType: res.media.mimeType }, textBlock]
      : [textBlock];
    return { content, isError: false };
  }
  if ("denied" in res) {
    return {
      content: [{ type: "text", text: res.reason }],
      isError: true
    };
  }
  return {
    content: [{ type: "text", text: res.error }],
    isError: true
  };
}

function jsonRpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

interface NativePermissionBody {
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly cwd?: unknown;
}

function parseNativePermissionBody(body: NativePermissionBody): NativeToolPermissionRequest | null {
  if (!body || typeof body !== "object") return null;
  if (typeof body.tool_name !== "string") return null;
  if (
    body.tool_input !== undefined &&
    (body.tool_input === null ||
      typeof body.tool_input !== "object" ||
      Array.isArray(body.tool_input))
  ) {
    return null;
  }
  return {
    toolName: body.tool_name,
    toolInput: (body.tool_input ?? {}) as Record<string, unknown>,
    ...(typeof body.cwd === "string" ? { workingDirectory: body.cwd } : {})
  };
}
