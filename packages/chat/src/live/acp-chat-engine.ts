import {
  MossAcpClient,
  toolNameFromMeta,
  type AcpBuiltInRequest,
  type AcpPermissionDecider,
  type AcpProviderKind,
  type AcpSessionHandle,
  type AcpSessionNotification,
  type AcpToolServer,
  type AcpTunnel
} from "@moss/acp";
import { type ProviderKind, redactSecrets } from "@moss/ai";
import type { ChatTurnUsageDto } from "@moss/shared";
import { recordProviderLoginRejected } from "./provider-probe.js";

import { CliChatUnavailableError } from "./errors.js";
import type { RpcConnection } from "./chat-engine-rpc-client.js";
import type { RpcAcpKillParams, RpcAcpSpawnParams } from "./rpc-contract.js";
import type { CliChatEngine, EngineKillOpts, EngineLaunchOpts, TranscriptRecord } from "./types.js";

const ACP_PROFILE = "chat" as const;
export const MAX_RESULT_CHARS = 500;

export interface AcpChatEngineOptions {
  readonly tunnel: AcpTunnel;
  readonly userId: string;
  readonly projectId: string;
  readonly permissionDecider?: AcpPermissionDecider;
  readonly toolServer?: AcpToolServer;
  readonly reportLoginRejected?: () => void;
  readonly log?: (line: string) => void;
}

/** ACP's provider names and Moss's configured provider names are deliberately different. */
export function toAcpProviderKind(provider: ProviderKind): AcpProviderKind {
  if (provider === "openai-compatible") return "openai";
  if (provider === "anthropic") return "anthropic";
  return "google";
}

export function toChatTurnUsageDto(usage: unknown): ChatTurnUsageDto | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const dto: Record<string, number> = {};
  if (typeof u.inputTokens === "number") dto.inputTokens = u.inputTokens;
  if (typeof u.outputTokens === "number") dto.outputTokens = u.outputTokens;
  if (typeof u.cachedReadTokens === "number") dto.cachedReadTokens = u.cachedReadTokens;
  if (typeof u.cachedWriteTokens === "number") dto.cachedWriteTokens = u.cachedWriteTokens;
  if (typeof u.thoughtTokens === "number") dto.thoughtTokens = u.thoughtTokens;
  if (typeof u.totalTokens === "number") dto.totalTokens = u.totalTokens;
  return Object.keys(dto).length > 0 ? (dto as ChatTurnUsageDto) : undefined;
}

export function summarizeToolArgs(
  rawInput: unknown,
  locations?: readonly { path: string }[] | null
): string | null {
  const parts: string[] = [];

  // 1. Paths from locations and rawInput
  const paths = new Set<string>();
  if (locations && Array.isArray(locations)) {
    for (const loc of locations) {
      if (typeof loc?.path === "string" && loc.path.trim()) {
        paths.add(loc.path.trim());
      }
    }
  }
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const input = rawInput as Record<string, unknown>;
    for (const key of ["file_path", "notebook_path", "path", "filePath"]) {
      const val = input[key];
      if (typeof val === "string" && val.trim()) {
        paths.add(val.trim());
      }
    }
  }
  if (paths.size > 0) {
    parts.push([...paths].join(", "));
  }

  // 2. Web address / url
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const input = rawInput as Record<string, unknown>;
    for (const key of ["url", "address", "uri"]) {
      const val = input[key];
      if (typeof val === "string" && val.trim()) {
        parts.push(val.trim());
        break;
      }
    }
  }

  // 3. Time window (calendar, search, etc.)
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const input = rawInput as Record<string, unknown>;
    if (typeof input.window === "string" && input.window.trim()) {
      parts.push(input.window.trim());
    } else if (input.window && typeof input.window === "object" && !Array.isArray(input.window)) {
      const win = input.window as Record<string, unknown>;
      if (win.start && win.end) {
        parts.push(`${String(win.start)} to ${String(win.end)}`);
      }
    } else if (input.windowStart && input.windowEnd) {
      parts.push(`${String(input.windowStart)} to ${String(input.windowEnd)}`);
    } else if (input.startsAfter && input.startsBefore) {
      parts.push(`${String(input.startsAfter)} to ${String(input.startsBefore)}`);
    }
  }

  // 4. Query (for search)
  if (parts.length === 0 && rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const input = rawInput as Record<string, unknown>;
    if (typeof input.query === "string" && input.query.trim()) {
      parts.push(input.query.trim());
    }
  }

  return parts.length > 0 ? parts.join(", ") : null;
}

export function extractRealToolName(toolCall: {
  toolName?: string;
  name?: string;
  title?: string;
  _meta?: unknown;
}): string {
  if (toolCall.toolName && typeof toolCall.toolName === "string" && toolCall.toolName.trim()) {
    return toolCall.toolName.trim();
  }
  if (toolCall._meta && typeof toolCall._meta === "object") {
    const meta = toolCall._meta as Record<string, unknown>;
    const claudeCode = meta.claudeCode;
    const fromMeta = toolNameFromMeta(claudeCode);
    if (fromMeta) return fromMeta;
    if (typeof meta.toolName === "string" && meta.toolName.trim()) {
      return meta.toolName.trim();
    }
  }
  if (toolCall.name && typeof toolCall.name === "string" && toolCall.name.trim()) {
    return toolCall.name.trim();
  }
  // Spec forbids falling back to display title; fall back to plain word "tool" only.
  return "tool";
}

export function extractCappedResultText(update: {
  rawOutput?: unknown;
  content?: unknown;
  status?: string | null;
}): string {
  let text = "";
  if (typeof update.rawOutput === "string") {
    text = update.rawOutput.trim();
  } else if (update.rawOutput && typeof update.rawOutput === "object") {
    const raw = update.rawOutput as Record<string, unknown>;
    if (typeof raw.text === "string") text = raw.text.trim();
    else if (typeof raw.output === "string") text = raw.output.trim();
    else if (typeof raw.message === "string") text = raw.message.trim();
    else text = JSON.stringify(update.rawOutput);
  } else if (Array.isArray(update.content)) {
    const parts: string[] = [];
    for (const item of update.content) {
      if (item && typeof item === "object") {
        if (item.type === "content" && item.content && typeof item.content.text === "string") {
          parts.push(item.content.text);
        } else if (typeof item.text === "string") {
          parts.push(item.text);
        }
      }
    }
    text = parts.join("\n").trim();
  } else if (update.status === "failed") {
    text = "Failed";
  } else if (update.status === "completed") {
    text = "Completed";
  }
  if (text.length > MAX_RESULT_CHARS) {
    return text.slice(0, MAX_RESULT_CHARS) + "…";
  }
  return text;
}

export function formatThoughtRecord(text: string): TranscriptRecord {
  return {
    kind: "thought",
    text
  };
}

export function formatToolRecord(toolCall: {
  toolCallId?: string;
  toolName?: string;
  name?: string;
  title?: string;
  locations?: Array<{ path: string }>;
  rawInput?: unknown;
  _meta?: unknown;
}): TranscriptRecord {
  const toolName = extractRealToolName(toolCall);
  const args = summarizeToolArgs(toolCall.rawInput, toolCall.locations);
  const redactedArgs = redactSecrets(args ?? undefined);
  const text = redactedArgs ? `${toolName}, ${redactedArgs}` : toolName;
  return {
    kind: "tool",
    toolName,
    ...(toolCall.toolCallId ? { toolCallId: toolCall.toolCallId } : {}),
    text
  };
}

export function formatResultRecord(update: {
  toolCallId?: string;
  rawOutput?: unknown;
  content?: unknown;
  status?: string | null;
}): TranscriptRecord | null {
  const text = extractCappedResultText(update);
  if (!text) return null;
  const redacted = redactSecrets(text);
  return {
    kind: "result",
    ...(update.toolCallId ? { toolCallId: update.toolCallId } : {}),
    text: redacted
  };
}

export function formatApprovalLine(opts: {
  toolName: string;
  approved: boolean;
  who?: string;
  at?: Date | string;
  durationSec?: number;
}): string {
  const who = opts.who ?? "you";
  const timeStr = formatRecordTime(opts.at ?? new Date());
  const durStr = opts.durationSec !== undefined ? ` after ${opts.durationSec} s` : "";
  const verb = opts.approved ? "approved" : "not approved";
  return `${opts.toolName}, ${verb} by ${who} at ${timeStr}${durStr}`;
}

export function formatApprovalRecord(opts: {
  toolName: string;
  approved: boolean;
  who?: string;
  at?: Date | string;
  durationSec?: number;
  durationMs?: number | null;
}): TranscriptRecord {
  return {
    kind: opts.approved ? "approved" : "not_approved",
    toolName: opts.toolName,
    text: formatApprovalLine(opts),
    ...(opts.durationMs != null
      ? { durationMs: opts.durationMs }
      : opts.durationSec !== undefined
        ? { durationMs: opts.durationSec * 1000 }
        : {})
  };
}

export function formatRefusalLine(opts: { toolName: string; reason?: string | null }): string {
  if (opts.reason && opts.reason.trim()) {
    return `${opts.toolName}, refused (${opts.reason.trim()})`;
  }
  return `${opts.toolName}, refused`;
}

export function formatRefusalRecord(opts: {
  toolName: string;
  reason?: string | null;
}): TranscriptRecord {
  return {
    kind: "refused",
    toolName: opts.toolName,
    text: formatRefusalLine(opts)
  };
}

export function formatReplyRecord(
  text: string,
  elapsedMs: number,
  usage?: unknown
): TranscriptRecord {
  const usageDto = toChatTurnUsageDto(usage);
  return {
    kind: "reply",
    text,
    elapsedMs,
    ...(usageDto ? { usage: usageDto } : {})
  };
}

function formatRecordTime(dateOrStr: Date | string): string {
  if (typeof dateOrStr === "string") return dateOrStr;
  const h = String(dateOrStr.getHours()).padStart(2, "0");
  const m = String(dateOrStr.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * The chat manager still speaks its small CliChatEngine contract. This adapter keeps the ACP
 * protocol state behind that seam: launch opens one ACP session, submit starts one prompt, and
 * readNew exposes the completed response as a normal transcript record.
 */
export class AcpChatEngine implements CliChatEngine {
  readonly provider: ProviderKind;
  readonly startsToolClientPerTurn = false;
  // The runner purges this session's private working folder as the owning account when it
  // stops the process (spec: purge is a runner verb, not an API-side one). No purge call
  // is needed here.
  readonly handlesOwnPrivatePurge = true;
  private readonly client: MossAcpClient;
  private handle: AcpSessionHandle | null = null;
  private prompt: Promise<void> | null = null;
  private promptError: unknown = null;
  private complete = false;
  private cancelled = false;
  private records: TranscriptRecord[] = [];
  private activeThoughtRecord: { kind: "thought"; text: string } | null = null;
  private readonly activeToolRecords = new Map<
    string,
    { kind: "tool"; toolName: string; toolCallId?: string; text: string }
  >();
  private readonly toolArgsSummary = new Map<string, string>();
  private readonly reportLoginRejected: () => void;

  constructor(
    provider: ProviderKind,
    private readonly sessionKey: string,
    private readonly opts: AcpChatEngineOptions
  ) {
    this.provider = provider;
    this.client = new MossAcpClient(
      opts.tunnel,
      {
        onSessionUpdate: (notification) => this.handleSessionUpdate(notification)
      },
      this.wrapPermissionDecider(opts.permissionDecider)
    );
    this.reportLoginRejected =
      opts.reportLoginRejected ?? (() => recordProviderLoginRejected(this.provider));
  }

  private wrapPermissionDecider(decider?: AcpPermissionDecider): AcpPermissionDecider | undefined {
    if (!decider) return undefined;
    return {
      beginTurn: decider.beginTurn?.bind(decider),
      cancelSession: decider.cancelSession?.bind(decider),
      decide: async (request: AcpBuiltInRequest, session: AcpSessionHandle) => {
        const start = Date.now();
        const rawVerdict = await decider.decide(request, session);
        const decision = typeof rawVerdict === "string" ? rawVerdict : rawVerdict.decision;
        const asked = typeof rawVerdict === "object" ? rawVerdict.asked : undefined;
        const holdDurationMs =
          typeof rawVerdict === "object" && rawVerdict.holdDurationMs !== undefined
            ? rawVerdict.holdDurationMs
            : Date.now() - start;
        const durationSec =
          holdDurationMs != null ? Math.max(1, Math.round(holdDurationMs / 1000)) : undefined;
        const toolName = request.toolName ?? "tool";

        this.flushCurrentThought();
        if (asked === true) {
          this.records.push(
            formatApprovalRecord({
              toolName,
              approved: decision === "allow",
              who: "you",
              durationSec,
              durationMs: holdDurationMs
            })
          );
        } else {
          // Policy decided (not asked)
          if (decision === "deny") {
            const reason = typeof rawVerdict === "object" ? rawVerdict.reason : null;
            this.records.push(formatRefusalRecord({ toolName, reason }));
          }
          // Silent policy allow (!asked && decision === "allow") writes NOTHING.
        }
        return decision;
      }
    };
  }

  private flushCurrentThought(): void {
    this.activeThoughtRecord = null;
  }

  handleSessionUpdate(
    notification: AcpSessionNotification | { update: Record<string, unknown> }
  ): void {
    const update = notification.update;
    if (!update || typeof update !== "object") return;
    const kind = (update as { sessionUpdate?: string }).sessionUpdate;

    switch (kind) {
      case "agent_thought_chunk": {
        const chunk = update as { content?: { type?: string; text?: string } | string };
        const text =
          typeof chunk.content === "string"
            ? chunk.content
            : chunk.content && typeof chunk.content.text === "string"
              ? chunk.content.text
              : "";
        if (!text) break;
        if (!this.activeThoughtRecord) {
          this.activeThoughtRecord = {
            kind: "thought",
            text: ""
          };
          this.records.push(this.activeThoughtRecord);
        }
        this.activeThoughtRecord.text += text;
        break;
      }

      case "tool_call": {
        this.flushCurrentThought();
        const toolCall = update as {
          toolCallId?: string;
          toolName?: string;
          name?: string;
          title?: string;
          locations?: Array<{ path: string }>;
          rawInput?: unknown;
          _meta?: unknown;
        };
        const record = formatToolRecord(toolCall);
        if (toolCall.toolCallId) {
          const mutableRecord = {
            kind: "tool" as const,
            toolName: record.toolName ?? "tool",
            toolCallId: toolCall.toolCallId,
            text: record.text
          };
          this.activeToolRecords.set(toolCall.toolCallId, mutableRecord);
          const args = summarizeToolArgs(toolCall.rawInput, toolCall.locations);
          const redactedArgs = redactSecrets(args ?? undefined);
          if (redactedArgs) {
            this.toolArgsSummary.set(toolCall.toolCallId, redactedArgs);
          }
          this.records.push(mutableRecord);
        } else {
          this.records.push(record);
        }
        break;
      }

      case "tool_call_update": {
        this.flushCurrentThought();
        const toolCallUpdate = update as {
          toolCallId?: string;
          rawInput?: unknown;
          locations?: Array<{ path: string }>;
          rawOutput?: unknown;
          content?: unknown;
          status?: string | null;
          _meta?: Record<string, unknown>;
        };
        if (toolCallUpdate.toolCallId) {
          const existing = this.activeToolRecords.get(toolCallUpdate.toolCallId);
          if (existing) {
            if (toolCallUpdate.rawInput !== undefined || toolCallUpdate.locations !== undefined) {
              const newArgs = redactSecrets(
                summarizeToolArgs(toolCallUpdate.rawInput, toolCallUpdate.locations) ?? undefined
              );
              if (newArgs) {
                this.toolArgsSummary.set(toolCallUpdate.toolCallId, newArgs);
                existing.text = `${existing.toolName ?? "tool"}, ${newArgs}`;
              }
            }
            if (existing.toolName === "tool") {
              const realName = extractRealToolName(toolCallUpdate);
              if (realName !== "tool") {
                existing.toolName = realName;
                const args = this.toolArgsSummary.get(toolCallUpdate.toolCallId);
                existing.text = args ? `${realName}, ${args}` : realName;
              }
            }
          }
        }
        const record = formatResultRecord(toolCallUpdate);
        if (record) {
          this.records.push(record);
        }
        break;
      }

      case "agent_message_chunk": {
        this.flushCurrentThought();
        break;
      }
    }
  }

  async launch(options: EngineLaunchOpts): Promise<{ offset: number }> {
    const kind = toAcpProviderKind(this.provider);
    try {
      this.handle = await this.client.openSession(
        this.sessionKey,
        this.opts.projectId,
        kind,
        this.opts.userId,
        ACP_PROFILE,
        this.opts.toolServer ??
          (options.mcpToken && options.mcpServerUrl
            ? { url: options.mcpServerUrl, bearer: options.mcpToken }
            : undefined),
        options.personaText
      );
      // ACP config options are set after session/new and before any prompt, including the
      // explicit "default" binding. The client records a mismatch without silently changing
      // the configured model list.
      await this.client.setModelForChat(this.handle, options.model ?? "default");
      (this.opts.log ?? console.info)(
        `[acp-chat] session opened conversation=${this.opts.projectId} provider=${kind}`
      );
      if (options.replayBatch) {
        await this.client.prompt(this.handle, options.replayBatch);
      }
      return { offset: 0 };
    } catch (error) {
      if (isAuthRequired(error)) {
        this.reportLoginRejected();
        await this.closeQuietly();
        throw new CliChatUnavailableError(
          `The ${providerLabel(kind)} sign-in has expired; an admin can log it in again under Settings, Assistant & AI`,
          { cause: error }
        );
      }
      await this.closeQuietly();
      throw error;
    }
  }

  async submit(text: string): Promise<void> {
    const handle = this.handle;
    if (!handle) throw new CliChatUnavailableError("ACP chat session is not open");
    if (this.prompt && !this.complete) throw new CliChatUnavailableError("ACP chat turn is busy");
    this.records = [];
    this.activeThoughtRecord = null;
    this.activeToolRecords.clear();
    this.promptError = null;
    this.complete = false;
    this.cancelled = false;
    const startedAt = Date.now();
    this.prompt = this.client
      .prompt(handle, text)
      .then((result) => {
        this.flushCurrentThought();
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        if (result.text) {
          this.records.push(formatReplyRecord(result.text, elapsedMs, result.usage));
        }
        const reason = String(result.stopReason);
        if (reason !== "end_turn") {
          this.records.push({ kind: "status", text: stopReasonText(reason, this.cancelled) });
        }
      })
      .catch((error: unknown) => {
        this.flushCurrentThought();
        if (isAuthRequired(error)) {
          this.reportLoginRejected();
          this.promptError = new CliChatUnavailableError(
            `The ${providerLabel(toAcpProviderKind(this.provider))} sign-in has expired; an admin can log it in again under Settings, Assistant & AI`,
            { cause: error }
          );
        } else {
          this.promptError = error;
        }
      })
      .finally(() => {
        this.complete = true;
      });
  }

  async readNew(_afterOffset: number): Promise<{
    records: TranscriptRecord[];
    offset: number;
    complete: boolean;
  }> {
    if (this.promptError) {
      const error = this.promptError;
      this.promptError = null;
      throw error;
    }
    const records = this.records.splice(0);
    if (this.complete) this.prompt = null;
    return { records, offset: 0, complete: this.complete && records.length === 0 };
  }

  async interrupt(): Promise<void> {
    if (!this.handle || !this.prompt || this.complete) return;
    this.cancelled = true;
    await this.client.cancel(this.handle);
  }

  async isAlive(): Promise<boolean> {
    return this.handle !== null;
  }

  async kill(_opts?: EngineKillOpts): Promise<void> {
    if (!this.handle) return;
    const handle = this.handle;
    await this.client.close(handle);
    this.handle = null;
  }

  private async closeQuietly(): Promise<void> {
    if (!this.handle) return;
    const handle = this.handle;
    try {
      await this.client.close(handle);
      this.handle = null;
    } catch {
      // The launch error is the useful failure; cleanup is retried by the client when it can
      // expose an AcpSessionOpenError, and this adapter must not mask it with a second error.
    }
  }
}

/** RPC-backed tunnel: ACP itself remains API-side while the runner only pipes JSON lines. */
export class RpcAcpTunnel implements AcpTunnel {
  constructor(
    private readonly connection: RpcConnection,
    _sessionKey: string
  ) {}

  async spawn(
    sessionKey: string,
    projectId: string,
    providerKind: AcpProviderKind,
    userId: string,
    profile: "chat" | "workshop"
  ) {
    const params: RpcAcpSpawnParams = { projectId, providerKind, userId, profile };
    return this.connection.acpSpawn(sessionKey, params);
  }

  async send(sessionKey: string, line: string): Promise<void> {
    await this.connection.acpSend(sessionKey, { line });
  }

  async read(sessionKey: string, afterSeq: number) {
    return this.connection.acpRead(sessionKey, { afterSeq });
  }

  async kill(sessionKey: string, _opts?: RpcAcpKillParams): Promise<void> {
    await this.connection.acpKill(sessionKey, _opts ?? {});
  }

  async execStart(): Promise<never> {
    throw new Error("ACP chat does not run builds");
  }
  async execPoll(): Promise<never> {
    throw new Error("ACP chat does not run builds");
  }
  async execKill(): Promise<never> {
    throw new Error("ACP chat does not run builds");
  }
}

export function createRpcAcpEngine(
  provider: ProviderKind,
  sessionKey: string,
  connection: RpcConnection,
  options: Omit<AcpChatEngineOptions, "tunnel">
): AcpChatEngine {
  return new AcpChatEngine(provider, sessionKey, {
    ...options,
    tunnel: new RpcAcpTunnel(connection, sessionKey)
  });
}

function isAuthRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /auth[_ -]?required|authentication required|not logged in|sign-in has expired/i.test(
    message
  );
}

function providerLabel(kind: AcpProviderKind): string {
  switch (kind) {
    case "anthropic":
      return "Claude";
    case "openai":
      return "Codex";
    case "opencode":
      return "OpenCode";
    default:
      return "Google";
  }
}

function stopReasonText(reason: string, cancelled: boolean): string {
  if (cancelled || reason === "cancelled") return "Stopped by user.";
  return `The model stopped (${reason}).`;
}
