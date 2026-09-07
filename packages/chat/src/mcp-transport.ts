import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";

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
  _meta?: {
    progressToken?: string | number;
  };
}

export interface McpTransportDependencies {
  readonly gateway: AssistantToolGateway;
  readonly tokens: SessionTokenRegistry;
  /**
   * How often to send a progress beat while a tools/call is still running.
   * Production default is 20 s, inside the client library's 60 s silence
   * limit, so a 150 s approval hold stays alive. Tests pass a small value.
   */
  readonly progressHeartbeatMs?: number;
}

/** Production heartbeat: a progress beat every 20 s while a call is held. */
export const MCP_PROGRESS_HEARTBEAT_MS = 20_000;

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
        // #2164 r21 — one info log per successful tools/list, one-way fingerprint + count only
        // (no actor content, arguments, or results).
        request.log.info(
          { tokenFingerprint: mcpSessionRateLimitKey(request), toolCount: tools.length },
          "mcp tools/list observed"
        );
        return reply.code(200).send({ jsonrpc: "2.0", id, result: { tools } });
      }

      if (method === "tools/call") {
        const params = body.params as McpToolCallParams | undefined;
        if (!params?.name) {
          return reply.code(200).send(jsonRpcError(id, -32602, "tools/call requires params.name"));
        }
        const progressToken = params._meta?.progressToken;
        if (progressToken !== undefined && acceptsEventStream(request.headers.accept)) {
          // Held-call heartbeat (spec section 6.1): the caller reads progress
          // notifications, so keep them coming every 20 s while the gateway
          // hold runs, then close the stream with the real result. Any other
          // caller gets today's single held response below, never worse.
          const call = deps.gateway
            .callTool(token, params.name, params.arguments ?? {})
            .catch((err) => {
              request.log.error({ err }, "mcp tools/call failed");
              return null;
            });
          reply.hijack();
          const raw = reply.raw;
          raw.writeHead(200, MCP_SSE_HEADERS);
          await streamToolCallWithProgress(raw, call, {
            id,
            progressToken,
            heartbeatMs: deps.progressHeartbeatMs ?? MCP_PROGRESS_HEARTBEAT_MS
          });
          return;
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

/**
 * True when the caller reads server-sent events: its Accept header names the
 * event-stream media type. Only then can progress notifications reach it.
 */
export function acceptsEventStream(accept: string | string[] | undefined): boolean {
  if (typeof accept !== "string") return false;
  return accept.split(",").some((part) => part.split(";")[0]?.trim() === "text/event-stream");
}

export interface ProgressStreamOptions {
  readonly id: string | number | null;
  readonly progressToken: string | number;
  readonly heartbeatMs: number;
  /** Total cap for one streamed call; defaults to MCP_STREAM_MAX_DURATION_MS. */
  readonly maxDurationMs?: number;
}

/**
 * Total cap for one streamed call: the 150 s approval hold plus room for a
 * long tool run afterwards. A stuck handler must close the connection instead
 * of holding it open forever.
 */
export const MCP_STREAM_MAX_DURATION_MS = 600_000;

/**
 * Headers for the hijacked SSE response. `reply.hijack()` bypasses the
 * onSend hooks where @fastify/helmet sets the security headers, so they are
 * repeated here (values mirror apps/api/src/server.ts).
 */
export const MCP_SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};

/**
 * Sends a progress beat every heartbeat while the tool call is still running,
 * then closes the stream with the real result. Each beat echoes the caller's
 * progress token so its client clock resets instead of timing the held call
 * out. Resolves once the stream is ended; a dropped connection just stops.
 */
export async function streamToolCallWithProgress(
  raw: ServerResponse,
  call: Promise<GatewayToolResponse | null>,
  options: ProgressStreamOptions
): Promise<void> {
  let beats = 0;
  let closed = false;
  let answered = false;
  const cleanup = (): void => {
    clearInterval(timer);
    clearTimeout(limit);
    raw.off("close", onClose);
  };
  const onClose = (): void => {
    closed = true;
    cleanup();
    finishGate();
  };
  // The function must settle when the stream ends even if the call never
  // does: the cap and a dropped connection each resolve their own gate, and
  // the result path below only runs for the call winning the race.
  let finishGate!: () => void;
  const finished = new Promise<void>((resolve) => {
    finishGate = resolve;
  });
  raw.on("close", onClose);
  // Flush the head immediately. `writeHead` only buffers it — Node puts nothing
  // on the wire until the first body write, so the first twenty seconds would
  // otherwise go out silently and defeat the beat. A comment frame is inert by
  // the SSE spec (same workaround as /api/chat/stream in live-routes.ts).
  raw.write(": connected\n\n");
  const timer = setInterval(() => {
    if (closed || answered) return;
    beats += 1;
    raw.write(
      `data: ${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: {
          progressToken: options.progressToken,
          progress: beats,
          message: "Approval still pending"
        }
      })}\n\n`
    );
  }, options.heartbeatMs);
  const limit = setTimeout(
    () => {
      if (closed || answered) return;
      answered = true;
      cleanup();
      raw.write(
        `data: ${JSON.stringify(jsonRpcError(options.id, -32603, "Tool call timed out."))}\n\n`
      );
      raw.end();
      finishGate();
    },
    options.maxDurationMs ?? MCP_STREAM_MAX_DURATION_MS
  );
  const response = await Promise.race([call, finished]);
  cleanup();
  if (closed || answered) return;
  answered = true;
  const frame =
    response === null || response === undefined
      ? jsonRpcError(options.id, -32603, "Internal error")
      : { jsonrpc: "2.0", id: options.id, result: gatewayResponseToMcp(response) };
  raw.write(`data: ${JSON.stringify(frame)}\n\n`);
  raw.end();
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
