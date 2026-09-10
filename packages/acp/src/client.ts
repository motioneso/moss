/**
 * Moss as an ACP client (slice 1, chat first).
 *
 * One internal interface for the rest of Moss: open a session, send a prompt,
 * stream events, answer permission, cancel, close. The adapter subprocess runs on
 * the cli-runner host; this client owns the protocol over the line tunnel.
 *
 * Slice 1 serves the `chat` profile only: scratch folder, the agent's own
 * shell and file writes off, Moss's tool server on. The caller hands over
 * Moss's own tool server at session open: its address plus a per-session
 * bearer, carried inside the session request over the runner socket.
 */

import {
  ClientSideConnection,
  type Client,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type StopReason,
  type ToolCallLocation,
  type Usage
} from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";

import { checkAcpProfile, checkAgentCapabilities, type AcpProfile } from "./capabilities.js";
import { getAcpProviderRow, type AcpProviderKind } from "./providers.js";
import { launchOffList } from "./tool-table.js";
import { selectAllowOptionId, toolNameFromMeta, type AcpBuiltInRequest } from "./permissions.js";
import { createTunnelStream, type TunnelStream } from "./stream.js";
import type { AcpTunnel } from "./tunnel.js";

/** Announcements remembered per session; oldest dropped past the cap. */
const MAX_ANNOUNCEMENTS_PER_SESSION = 256;
/**
 * How long a permission question waits for its announcement. The race is
 * milliseconds in practice; past this the tool is unknown and refuses.
 */
const ANNOUNCEMENT_WAIT_MS = 2000;

export interface AcpSessionHandle {
  readonly sessionId: string;
  readonly cwd: string;
  /** The HOME handed to the agent process, or null when it names none. */
  readonly home: string | null;
  /** The spawned agent's own process id, or null when it could not be read. */
  readonly pid: number | null;
  /** The slot account the agent should be running as — the identity evidence to check against. */
  readonly uid: number;
  readonly gid: number;
}

/** Cleanup retained for a failed open whose runner stop can be retried. */
export interface AcpSessionCleanupHandle {
  close(): Promise<void>;
}

/** A failed open whose runner cleanup can be retried after a refused stop. */
export class AcpSessionOpenError extends Error {
  readonly startupError: unknown;
  readonly cleanupError: unknown;
  readonly cleanup: AcpSessionCleanupHandle;
  readonly retryCleanup: () => Promise<void>;

  constructor(startupError: unknown, cleanupError: unknown, cleanup: AcpSessionCleanupHandle) {
    const startupMessage =
      startupError instanceof Error ? startupError.message : String(startupError);
    const cleanupMessage =
      cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    super(
      `ACP session failed to open (${startupMessage}); cleanup failed (${cleanupMessage}); ` +
        "call cleanup.close() to finish stopping the agent",
      { cause: startupError }
    );
    this.name = "AcpSessionOpenError";
    this.startupError = startupError;
    this.cleanupError = cleanupError;
    this.cleanup = cleanup;
    this.retryCleanup = () => cleanup.close();
  }
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
  readonly usage?: Usage | null;
}

/**
 * What `setModel` did. `applied` means the agent accepted the model id
 * through the advertised `category: "model"` option. Anything else keeps the
 * session on the login's default and says so: `mismatch` when the id is not
 * one the agent accepts, `mechanism` naming the row's fallback (e.g. Codex's
 * launch-time config) when no option is advertised.
 */
export interface AcpSetModelResult {
  readonly applied: boolean;
  readonly mismatch: boolean;
  readonly mechanism: string;
  readonly note: string | null;
}

export interface AcpClientEvents {
  onSessionUpdate?: (notification: SessionNotification) => void;
}

/**
 * One announced tool use, matched to its permission question by tool call id.
 * The name comes from the agent's own announcement metadata, written by
 * adapter platform code — never from the display title.
 */
export interface AcpToolAnnouncement {
  readonly toolName: string | null;
  readonly kind: string | null;
  readonly locations: readonly ToolCallLocation[] | null;
  readonly rawInput: unknown;
}

/** Answers one announced tool ask with allow or deny. */
export type AcpPermissionDecision = "allow" | "deny";

export interface AcpPermissionDecisionResult {
  readonly decision: AcpPermissionDecision;
  /** Whether a human user was asked to approve this action. */
  readonly asked?: boolean;
  /** How long the approval was held waiting for a user decision (in ms). */
  readonly holdDurationMs?: number | null;
  /** Internal reason string (e.g. "Approved by user.", "Allowed by policy.", refusal reason). */
  readonly reason?: string | null;
}

/**
 * Bridges built-in permission asks to the host's approval flow. Maps the host
 * verdict into the protocol answer; without a decider the client refuses.
 */
export interface AcpPermissionDecider {
  decide(
    request: AcpBuiltInRequest,
    session: AcpSessionHandle
  ): Promise<AcpPermissionDecision | AcpPermissionDecisionResult>;
  /** Start a prompt turn with an identity that permission asks carry. */
  beginTurn?: (sessionId: string, turnId: string) => void | Promise<void>;
  /** Settle all pending permission asks when this agent session is stopped. */
  cancelSession?: (sessionId: string) => void | Promise<void>;
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

/**
 * The advertised `category: "model"` option, if the agent offers one. Matched
 * on the semantic category only, as the spec names it; anything else is not a
 * model choice even when its id or name says otherwise.
 */
export function findModelOption(
  options: readonly SessionConfigOption[]
): SessionConfigOption | null {
  return options.find((option) => option.category === "model") ?? null;
}

/**
 * The ids the option accepts, or null when it takes free-form values. Reads
 * the select option's `options` list, including grouped options.
 */
export function acceptedOptionValues(option: SessionConfigOption): Set<string> | null {
  const options = (option as { options?: unknown }).options;
  if (options === undefined || options === null) return null;
  if (!Array.isArray(options)) return null;
  const ids = new Set<string>();
  for (const entry of options) {
    if (!entry || typeof entry !== "object") continue;
    if ("value" in entry && typeof (entry as { value?: unknown }).value === "string") {
      ids.add((entry as { value: string }).value);
    } else if ("options" in entry && Array.isArray((entry as { options?: unknown }).options)) {
      for (const nested of (entry as { options: unknown[] }).options) {
        if (
          nested &&
          typeof nested === "object" &&
          "value" in nested &&
          typeof (nested as { value?: unknown }).value === "string"
        ) {
          ids.add((nested as { value: string }).value);
        }
      }
    }
  }
  return ids;
}

export class MossAcpClient {
  private readonly connections = new Map<string, ClientSideConnection>();
  private readonly sessionKeys = new Map<string, string>();
  private readonly streams = new Map<string, TunnelStream>();
  private readonly texts = new Map<string, string[]>();
  private readonly toolCalls = new Map<string, number>();
  private readonly closers = new Map<string, () => void>();
  private readonly sessionCwds = new Map<string, string>();
  private readonly sessionHomes = new Map<string, string | null>();
  private readonly sessionPids = new Map<string, number | null>();
  private readonly sessionUids = new Map<string, number>();
  private readonly sessionGids = new Map<string, number>();
  private readonly sessionKinds = new Map<string, AcpProviderKind>();
  private readonly sessionOptions = new Map<string, readonly SessionConfigOption[]>();
  private readonly turnIds = new Map<string, string>();
  private readonly announcements = new Map<string, Map<string, AcpToolAnnouncement>>();
  private readonly announcementWaiters = new Map<string, () => void>();

  constructor(
    private readonly tunnel: AcpTunnel,
    private readonly events: AcpClientEvents = {},
    private readonly permissionDecider: AcpPermissionDecider | null = null
  ) {}

  /**
   * The provider kind travels with the session from open time: it picks the
   * adapter row for the model fallback, and the profile gate refuses anything
   * but a ready provider on the chat profile before anything is spawned. There
   * is no default kind; a caller that does not know the provider cannot open.
   * The user id travels with it: the runner's account slot belongs to the
   * person, never the session. The profile travels too, so the runner applies
   * that surface's launch rules.
   */
  async openSession(
    sessionKey: string,
    projectId: string,
    providerKind: AcpProviderKind,
    userId: string,
    surface: AcpProfile = "workshop",
    toolServer?: AcpToolServer,
    personaText?: string
  ): Promise<AcpSessionHandle> {
    checkAcpProfile(surface, providerKind);
    const { cwd, home, pid, uid, gid } = await this.tunnel.spawn(
      sessionKey,
      projectId,
      providerKind,
      userId,
      surface
    );
    const stream = createTunnelStream(this.tunnel, sessionKey);
    const connection = new ClientSideConnection(() => this.createClientHandler(), stream);
    try {
      const init = await connection.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "moss", version: "0.1.0" }
      });
      checkAgentCapabilities(surface, init);
      const session = await connection.newSession({
        cwd,
        mcpServers: toolServer ? [toMcpServerEntry(toolServer)] : [],
        // The row's launch-time off-list, from the tool table through the row's
        // own mechanism: the agent's disallowed-tools list.
        _meta: {
          claudeCode: { options: { disallowedTools: launchOffList(surface) } },
          ...(personaText !== undefined ? { systemPrompt: personaText } : {})
        }
      });
      this.connections.set(session.sessionId, connection);
      this.sessionKeys.set(session.sessionId, sessionKey);
      this.streams.set(session.sessionId, stream);
      this.texts.set(session.sessionId, []);
      this.toolCalls.set(session.sessionId, 0);
      this.sessionCwds.set(session.sessionId, cwd);
      this.sessionHomes.set(session.sessionId, home);
      this.sessionPids.set(session.sessionId, pid);
      this.sessionUids.set(session.sessionId, uid);
      this.sessionGids.set(session.sessionId, gid);
      this.sessionKinds.set(session.sessionId, providerKind);
      this.sessionOptions.set(session.sessionId, session.configOptions ?? []);
      if (toolServer?.onClose) this.closers.set(session.sessionId, toolServer.onClose);
      return { sessionId: session.sessionId, cwd, home, pid, uid, gid };
    } catch (error) {
      let killed = false;
      let stopped = false;
      let revoked = false;
      const cleanup: AcpSessionCleanupHandle = {
        close: async (): Promise<void> => {
          if (!killed) {
            await this.tunnel.kill(sessionKey);
            killed = true;
          }
          if (!stopped) {
            await stream.stop();
            stopped = true;
          }
          if (!revoked) {
            revoked = true;
            toolServer?.onClose?.();
          }
        }
      };
      try {
        await cleanup.close();
      } catch (cleanupError) {
        throw new AcpSessionOpenError(error, cleanupError, cleanup);
      }
      throw error;
    }
  }

  async prompt(
    handle: AcpSessionHandle,
    text: string,
    options: AcpPromptOptions = {}
  ): Promise<AcpPromptResult> {
    const connection = this.requireConnection(handle.sessionId);
    const turnId = randomUUID();
    this.turnIds.set(handle.sessionId, turnId);
    await this.permissionDecider?.beginTurn?.(handle.sessionId, turnId);
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    this.texts.set(handle.sessionId, []);
    this.toolCalls.set(handle.sessionId, 0);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const response = await Promise.race([
        connection.prompt({
          sessionId: handle.sessionId,
          prompt: [{ type: "text", text }]
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.cancel(handle).catch(() => undefined);
            reject(new Error(`ACP prompt timed out after ${timeoutMs} ms`));
          }, timeoutMs);
        })
      ]);
      const chunks = this.texts.get(handle.sessionId) ?? [];
      return {
        stopReason: response.stopReason,
        text: chunks.join(""),
        toolCallsSeen: this.toolCalls.get(handle.sessionId) ?? 0,
        usage: response.usage ?? null
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async cancel(handle: AcpSessionHandle): Promise<void> {
    const connection = this.requireConnection(handle.sessionId);
    const permissionCancellation = this.cancelPendingPermissions(handle.sessionId);
    try {
      await connection.cancel({ sessionId: handle.sessionId });
    } finally {
      await permissionCancellation;
    }
  }

  /**
   * Send the model choice to the agent (slice 1 task 2). The provider kind
   * comes from the session, carried since open time, so no call path can name
   * the wrong row or silently fall back to one. Uses the advertised
   * `category: "model"` option where the agent offers one; otherwise the row's
   * launch-time fallback applies and the session stays on the login's default.
   * A mismatch (the id is not one the agent accepts) is recorded on the result
   * and never merged into any list.
   */
  async setModel(handle: AcpSessionHandle, modelId: string): Promise<AcpSetModelResult> {
    const connection = this.requireConnection(handle.sessionId);
    const providerKind = this.sessionKinds.get(handle.sessionId);
    if (!providerKind) throw new Error("ACP session is not open");
    const options = this.sessionOptions.get(handle.sessionId) ?? [];
    const option = findModelOption(options);
    const row = getAcpProviderRow(providerKind);
    if (!option) {
      return {
        applied: false,
        mismatch: false,
        mechanism: row.model,
        note: `the ${row.agent} agent advertised no model option; session stays on the login's default`
      };
    }
    const accepted = acceptedOptionValues(option);
    if (accepted !== null && !accepted.has(modelId)) {
      return {
        applied: false,
        mismatch: true,
        mechanism: row.model,
        note: `model ${modelId} is not one the ${row.agent} agent accepts`
      };
    }
    await connection.setSessionConfigOption({
      sessionId: handle.sessionId,
      configId: option.id,
      value: modelId
    });
    return { applied: true, mismatch: false, mechanism: row.model, note: null };
  }

  /** Set the requested chat model, falling back to the agent's advertised value when needed. */
  async setModelForChat(handle: AcpSessionHandle, modelId: string): Promise<AcpSetModelResult> {
    const options = this.sessionOptions.get(handle.sessionId) ?? [];
    const option = findModelOption(options);
    if (!option) return this.setModel(handle, modelId);
    const accepted = acceptedOptionValues(option);
    const current = (option as { currentValue?: unknown }).currentValue;
    const currentValue = typeof current === "string" && current.length > 0 ? current : undefined;
    const requestedIsDefault = modelId === "default" || modelId.length === 0;
    const requestedIsUnsupported = accepted !== null && !accepted.has(modelId);
    const effective =
      requestedIsDefault || requestedIsUnsupported
        ? currentValue && (accepted === null || accepted.has(currentValue))
          ? currentValue
          : accepted?.values().next().value
        : modelId;
    if (typeof effective !== "string" || effective.length === 0)
      return this.setModel(handle, modelId);
    return this.setModel(handle, effective);
  }

  /**
   * A refused or unconfirmed stop is rethrown, not swallowed: a blanket
   * catch here previously let a rejecting tunnel make close() report
   * success and stop polling, so the caller believed the session was gone
   * while the process kept running (task 5b, Astra-Reviewer round-four
   * finding, 2026-09-08). Session tracking is only torn down once the stop
   * actually succeeds, so a caller that retries after a failure still finds
   * the session to retry against.
   */
  async close(handle: AcpSessionHandle): Promise<void> {
    const sessionKey = this.sessionKeys.get(handle.sessionId);
    const stream = this.streams.get(handle.sessionId);
    await this.cancelPendingPermissions(handle.sessionId);
    if (sessionKey) {
      await this.tunnel.kill(sessionKey);
      await stream?.stop();
    }
    this.connections.delete(handle.sessionId);
    this.sessionKeys.delete(handle.sessionId);
    this.streams.delete(handle.sessionId);
    this.texts.delete(handle.sessionId);
    this.toolCalls.delete(handle.sessionId);
    this.sessionCwds.delete(handle.sessionId);
    this.sessionHomes.delete(handle.sessionId);
    this.sessionPids.delete(handle.sessionId);
    this.sessionUids.delete(handle.sessionId);
    this.sessionGids.delete(handle.sessionId);
    this.sessionKinds.delete(handle.sessionId);
    this.sessionOptions.delete(handle.sessionId);
    this.announcements.delete(handle.sessionId);
    // Wake any questions still waiting: they re-check, find nothing, refuse.
    for (const [key, wake] of [...this.announcementWaiters]) {
      if (key.startsWith(`${handle.sessionId}\n`)) {
        this.announcementWaiters.delete(key);
        wake();
      }
    }
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

  private async cancelPendingPermissions(sessionId: string): Promise<void> {
    await this.permissionDecider?.cancelSession?.(sessionId);
  }

  /** Remember one announced tool use, waking its question if already waiting. */
  private recordAnnouncement(sessionId: string, toolCallId: string, update: unknown): void {
    let table = this.announcements.get(sessionId);
    if (!table) {
      table = new Map();
      this.announcements.set(sessionId, table);
    }
    if (table.size >= MAX_ANNOUNCEMENTS_PER_SESSION) {
      const oldest = table.keys().next();
      if (!oldest.done) table.delete(oldest.value);
    }
    const fields = update && typeof update === "object" ? (update as Record<string, unknown>) : {};
    const meta = fields._meta;
    const claudeCode =
      meta && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>).claudeCode
        : null;
    const rawKind = fields.kind;
    const rawLocations = fields.locations;
    table.set(toolCallId, {
      toolName: toolNameFromMeta(claudeCode),
      kind: typeof rawKind === "string" ? rawKind : null,
      locations: Array.isArray(rawLocations) ? (rawLocations as ToolCallLocation[]) : null,
      rawInput: fields.rawInput
    });
    const waiter = this.announcementWaiters.get(`${sessionId}\n${toolCallId}`);
    if (waiter) {
      this.announcementWaiters.delete(`${sessionId}\n${toolCallId}`);
      waiter();
    }
  }

  /**
   * Wait for an announcement that may land just after its question. Event
   * driven: the arrival wakes us, otherwise a short bound expires and the
   * tool stays unknown.
   */
  private waitForAnnouncement(sessionId: string, toolCallId: string): Promise<void> {
    const key = `${sessionId}\n${toolCallId}`;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.announcementWaiters.delete(key);
        resolve();
      }, ANNOUNCEMENT_WAIT_MS);
      this.announcementWaiters.set(key, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Fail closed: no decider, no known folder, no announcement, no name, or a
   * throwing decider all refuse without asking anyone. An unnamed tool is
   * unknown by definition, and the only text available for it is the model's.
   */
  private async answerPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    const cwd = this.sessionCwds.get(params.sessionId);
    if (!this.permissionDecider || !cwd || !this.sessionHomes.has(params.sessionId)) {
      return denyPermission();
    }
    const home = this.sessionHomes.get(params.sessionId) ?? null;
    const pid = this.sessionPids.get(params.sessionId) ?? null;
    const uid = this.sessionUids.get(params.sessionId);
    const gid = this.sessionGids.get(params.sessionId);
    if (uid === undefined || gid === undefined) return denyPermission();
    const turnId = this.turnIds.get(params.sessionId) ?? randomUUID();
    this.turnIds.set(params.sessionId, turnId);
    const toolCallId = params.toolCall.toolCallId;
    let announced = this.announcements.get(params.sessionId)?.get(toolCallId);
    if (!announced) {
      await this.waitForAnnouncement(params.sessionId, toolCallId);
      announced = this.announcements.get(params.sessionId)?.get(toolCallId);
    }
    if (!announced || announced.toolName === null) {
      console.warn(
        `[acp] refusing permission ask with no announced tool name ` +
          `(session ${params.sessionId}, call ${toolCallId})`
      );
      return denyPermission();
    }
    const builtIn: AcpBuiltInRequest = {
      sessionId: params.sessionId,
      turnId,
      toolCallId,
      title: params.toolCall.title ?? "",
      rawInput: params.toolCall.rawInput,
      toolName: announced.toolName,
      kind: announced.kind,
      locations: announced.locations
    };
    try {
      const rawVerdict = await this.permissionDecider.decide(builtIn, {
        sessionId: params.sessionId,
        cwd,
        home,
        pid,
        uid,
        gid
      });
      const verdict = typeof rawVerdict === "string" ? rawVerdict : rawVerdict.decision;
      if (verdict !== "allow") return denyPermission();
      // Least privilege: single-use grant, never standing. No allow option
      // means the question itself offers nothing to take: refuse.
      const optionId = selectAllowOptionId(params.options);
      if (optionId === null) return denyPermission();
      return { outcome: { outcome: "selected", optionId } };
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
          const toolCall = update as { toolCallId?: unknown };
          if (typeof toolCall.toolCallId === "string") {
            this.recordAnnouncement(params.sessionId, toolCall.toolCallId, update);
          }
        }
      }
    };
  }
}
