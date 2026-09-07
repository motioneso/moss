/**
 * Moss as an ACP client, Workshop side (#2369 slice 1).
 *
 * One internal interface for the rest of Moss: open a session, send a prompt,
 * stream events, answer permission, cancel, close. The adapter subprocess runs on
 * the cli-runner host; this client owns the protocol over the line tunnel.
 *
 * Slice 1 advertises no file or terminal capabilities (files and commands are
 * Moss tools, so a later protocol version never touches file handling). The
 * caller hands over Moss's own tool server at session open: its address plus a
 * per-session bearer, carried inside the session request over the runner socket.
 * From there the adapter passes the entry, bearer and all, into the agent
 * launch, so the bearer reaches the agent process command line, where any box
 * login can read it. That exposure is inherent to the outside-agent design. It
 * stays cheap because the token is per-session, narrowed to Workshop tools,
 * given a fixed end time, and revoked when the session closes.
 */

import {
  ClientSideConnection,
  type Client,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason
} from "@agentclientprotocol/sdk";

import { checkAgentCapabilities, type AcpSurface } from "./capabilities.js";
import { createTunnelStream } from "./stream.js";
import type { AcpTunnel } from "./tunnel.js";

export interface AcpSessionHandle {
  readonly sessionId: string;
  readonly cwd: string;
}

/**
 * Moss's own tool server, handed to the agent when a session opens. The URL is
 * the address the agent reaches the tool server at, and the Bearer is the
 * per-session token minted for that session. Both travel inside the
 * `session/new` payload over the runner socket, and from there into the agent
 * process command line. Plan for the Bearer [REDACTED] exposed to box logins, never
 * for it staying inside the socket: mint it per session with a fixed end time,
 * narrowed to Workshop tools, and revoke it on close.
 */
export interface AcpToolServer {
  readonly url: string;
  readonly bearer: string;
  /** Runs on the phase-one session end path, so the caller can revoke the Bearer. */
  readonly onClose?: () => void;
}

export interface AcpPromptResult {
  readonly stopReason: StopReason;
  readonly text: string;
  readonly toolCallsSeen: number;
}

export interface AcpClientEvents {
  onSessionUpdate?: (notification: SessionNotification) => void;
}

/**
 * Answers one built-in permission request for a session. Phase 4 wires this to
 * the gateway's shared approval card via `decideAcpPermission`; without a
 * decider the client stays deny-closed.
 */
export interface AcpPermissionDecider {
  decide(
    request: RequestPermissionRequest,
    session: AcpSessionHandle
  ): Promise<RequestPermissionResponse>;
}

export interface AcpPromptOptions {
  /**
   * Caller-side deadline for one prompt turn. A hung agent cancels instead of
   * hanging the caller forever. Defaults to ten minutes.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Deny-closed fallback: anything the policy does not explicitly allow is
 * denied, and anything unrecognised is refused without asking. Denial is the
 * protocol's cancelled outcome, which aborts the tool use without retrying it.
 * With a permission decider wired (phase 4), the policy answers first and only
 * this fallback denies.
 */
function denyPermission(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

/**
 * The session opening carries one tool server entry: Moss's own, over HTTP,
 * with the session Bearer as an Authorization header. The capability gate
 * already proved the agent takes HTTP tool servers before we get here.
 */
function toMcpServerEntry(toolServer: AcpToolServer): McpServer {
  return {
    type: "http",
    name: "moss",
    url: toolServer.url,
    headers: [{ name: "Authorization", value: `Bearer ${toolServer.bearer}` }]
  };
}

export class MossAcpClient {
  private readonly connections = new Map<string, ClientSideConnection>();
  private readonly texts = new Map<string, string[]>();
  private readonly toolCalls = new Map<string, number>();
  private readonly closers = new Map<string, () => void>();
  private readonly sessionCwds = new Map<string, string>();

  constructor(
    private readonly tunnel: AcpTunnel,
    private readonly events: AcpClientEvents = {},
    private readonly permissionDecider: AcpPermissionDecider | null = null
  ) {}

  async openSession(
    sessionKey: string,
    projectId: string,
    surface: AcpSurface = "workshop",
    toolServer?: AcpToolServer
  ): Promise<AcpSessionHandle> {
    const { cwd } = await this.tunnel.spawn(sessionKey, projectId);
    const stream = createTunnelStream(this.tunnel, sessionKey);
    const connection = new ClientSideConnection(() => this.createClientHandler(), stream);
    const init = await connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "moss", version: "0.1.0" }
    });
    checkAgentCapabilities(surface, init);
    const session = await connection.newSession({
      cwd,
      mcpServers: toolServer ? [toMcpServerEntry(toolServer)] : [],
      // The agent's own file and shell tools stay off on purpose: files and
      // commands are Moss tools, and the vendor default prompt is not a policy
      // we accept. The runner-side settings file denies them a second time.
      _meta: { disableBuiltInTools: true }
    });
    this.connections.set(session.sessionId, connection);
    this.texts.set(session.sessionId, []);
    this.toolCalls.set(session.sessionId, 0);
    this.sessionCwds.set(session.sessionId, cwd);
    if (toolServer?.onClose) this.closers.set(session.sessionId, toolServer.onClose);
    return { sessionId: session.sessionId, cwd };
  }

  async prompt(
    handle: AcpSessionHandle,
    text: string,
    options: AcpPromptOptions = {}
  ): Promise<AcpPromptResult> {
    const connection = this.requireConnection(handle.sessionId);
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const response = await Promise.race([
        connection.prompt({
          sessionId: handle.sessionId,
          prompt: [{ type: "text", text }]
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void connection.cancel({ sessionId: handle.sessionId }).catch(() => undefined);
            reject(new Error(`ACP prompt timed out after ${timeoutMs} ms`));
          }, timeoutMs);
        })
      ]);
      const chunks = this.texts.get(handle.sessionId) ?? [];
      return {
        stopReason: response.stopReason,
        text: chunks.join(""),
        toolCallsSeen: this.toolCalls.get(handle.sessionId) ?? 0
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async cancel(handle: AcpSessionHandle): Promise<void> {
    const connection = this.requireConnection(handle.sessionId);
    await connection.cancel({ sessionId: handle.sessionId });
  }

  async close(handle: AcpSessionHandle): Promise<void> {
    this.connections.delete(handle.sessionId);
    this.texts.delete(handle.sessionId);
    this.toolCalls.delete(handle.sessionId);
    this.sessionCwds.delete(handle.sessionId);
    // The phase-one end path: the tool server Bearer [REDACTED] working the moment the
    // outside session closes, so run the caller's revoke hook here.
    const onClose = this.closers.get(handle.sessionId);
    this.closers.delete(handle.sessionId);
    onClose?.();
  }

  private requireConnection(sessionId: string): ClientSideConnection {
    const connection = this.connections.get(sessionId);
    if (!connection) throw new Error("ACP session is not open");
    return connection;
  }

  /**
   * Fail closed: no decider, no known folder, or a throwing decider all refuse
   * without asking anyone.
   */
  private async answerPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const cwd = this.sessionCwds.get(params.sessionId);
    if (!this.permissionDecider || !cwd) return denyPermission();
    try {
      return await this.permissionDecider.decide(params, { sessionId: params.sessionId, cwd });
    } catch {
      return denyPermission();
    }
  }

  private createClientHandler(): Client {
    return {
      requestPermission: async (params) => this.answerPermission(params),
      sessionUpdate: async (params) => {
        this.events.onSessionUpdate?.(params);
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk") {
          const content = (update as { content?: unknown }).content;
          if (
            content &&
            typeof content === "object" &&
            (content as { type?: unknown }).type === "text"
          ) {
            const chunks = this.texts.get(params.sessionId);
            chunks?.push((content as { text?: string }).text ?? "");
          }
        }
        if (update.sessionUpdate === "tool_call") {
          this.toolCalls.set(params.sessionId, (this.toolCalls.get(params.sessionId) ?? 0) + 1);
        }
      }
    };
  }
}
