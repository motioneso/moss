/**
 * Moss as an ACP client, Workshop side (#2369 slice 1).
 *
 * One internal interface for the rest of Moss: open a session, send a prompt,
 * stream events, answer permission, cancel, close. The adapter subprocess runs on
 * the cli-runner host; this client owns the protocol over the line tunnel.
 *
 * Slice 1 advertises no file or terminal capabilities (files and commands are
 * Moss tools, so a later protocol version never touches file handling) and hands
 * over no tool server yet — that arrives in the next phase.
 */

import {
  ClientSideConnection,
  type Client,
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

export interface AcpPromptResult {
  readonly stopReason: StopReason;
  readonly text: string;
  readonly toolCallsSeen: number;
}

export interface AcpClientEvents {
  onSessionUpdate?: (notification: SessionNotification) => void;
}

/**
 * Phase 1 permission posture: anything the policy does not explicitly allow is
 * denied, and slice 1 allows nothing yet — the shared approval card arrives with
 * the next phase. Denial is the protocol's cancelled outcome, which aborts the
 * tool use without retrying it.
 */
function denyPermission(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

export class MossAcpClient {
  private readonly connections = new Map<string, ClientSideConnection>();
  private readonly texts = new Map<string, string[]>();
  private readonly toolCalls = new Map<string, number>();

  constructor(
    private readonly tunnel: AcpTunnel,
    private readonly events: AcpClientEvents = {}
  ) {}

  async openSession(
    sessionKey: string,
    projectId: string,
    surface: AcpSurface = "workshop"
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
    const session = await connection.newSession({ cwd, mcpServers: [] });
    this.connections.set(session.sessionId, connection);
    this.texts.set(session.sessionId, []);
    this.toolCalls.set(session.sessionId, 0);
    return { sessionId: session.sessionId, cwd };
  }

  async prompt(handle: AcpSessionHandle, text: string): Promise<AcpPromptResult> {
    const connection = this.requireConnection(handle.sessionId);
    const response = await connection.prompt({
      sessionId: handle.sessionId,
      prompt: [{ type: "text", text }]
    });
    const chunks = this.texts.get(handle.sessionId) ?? [];
    return {
      stopReason: response.stopReason,
      text: chunks.join(""),
      toolCallsSeen: this.toolCalls.get(handle.sessionId) ?? 0
    };
  }

  async cancel(handle: AcpSessionHandle): Promise<void> {
    const connection = this.requireConnection(handle.sessionId);
    await connection.cancel({ sessionId: handle.sessionId });
  }

  async close(handle: AcpSessionHandle): Promise<void> {
    this.connections.delete(handle.sessionId);
    this.texts.delete(handle.sessionId);
    this.toolCalls.delete(handle.sessionId);
  }

  private requireConnection(sessionId: string): ClientSideConnection {
    const connection = this.connections.get(sessionId);
    if (!connection) throw new Error("ACP session is not open");
    return connection;
  }

  private createClientHandler(): Client {
    return {
      requestPermission: async () => denyPermission(),
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
