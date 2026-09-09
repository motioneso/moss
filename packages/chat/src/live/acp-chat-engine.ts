import {
  MossAcpClient,
  type AcpPermissionDecider,
  type AcpProviderKind,
  type AcpSessionHandle,
  type AcpToolServer,
  type AcpTunnel
} from "@moss/acp";
import type { ProviderKind } from "@moss/ai";
import { recordProviderLoginRejected } from "./provider-probe.js";

import { CliChatUnavailableError } from "./errors.js";
import type { RpcConnection } from "./chat-engine-rpc-client.js";
import type { RpcAcpKillParams, RpcAcpSpawnParams } from "./rpc-contract.js";
import type { CliChatEngine, EngineKillOpts, EngineLaunchOpts, TranscriptRecord } from "./types.js";

const ACP_PROFILE = "chat" as const;

export interface AcpChatEngineOptions {
  readonly tunnel: AcpTunnel;
  readonly userId: string;
  readonly projectId: string;
  readonly permissionDecider?: AcpPermissionDecider;
  readonly toolServer?: AcpToolServer;
  readonly purgeTranscripts?: () => Promise<void>;
  readonly persistSessionIdentity?: (neutralDir: string, sessionId: string) => Promise<void>;
  readonly reportLoginRejected?: () => void;
  readonly log?: (line: string) => void;
}

/** ACP's provider names and Moss's configured provider names are deliberately different. */
export function toAcpProviderKind(provider: ProviderKind): AcpProviderKind {
  if (provider === "openai-compatible") return "openai";
  if (provider === "anthropic") return "anthropic";
  return "google";
}

/**
 * The chat manager still speaks its small CliChatEngine contract. This adapter keeps the ACP
 * protocol state behind that seam: launch opens one ACP session, submit starts one prompt, and
 * readNew exposes the completed response as a normal transcript record.
 */
export class AcpChatEngine implements CliChatEngine {
  readonly provider: ProviderKind;
  readonly startsToolClientPerTurn = false;
  private readonly client: MossAcpClient;
  private handle: AcpSessionHandle | null = null;
  private prompt: Promise<void> | null = null;
  private promptError: unknown = null;
  private complete = false;
  private cancelled = false;
  private records: TranscriptRecord[] = [];
  private readonly reportLoginRejected: () => void;

  constructor(
    provider: ProviderKind,
    private readonly sessionKey: string,
    private readonly opts: AcpChatEngineOptions
  ) {
    this.provider = provider;
    this.client = new MossAcpClient(opts.tunnel, {}, opts.permissionDecider ?? null);
    this.reportLoginRejected =
      opts.reportLoginRejected ?? (() => recordProviderLoginRejected(this.provider));
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
      await this.opts.persistSessionIdentity?.(options.neutralDir, this.handle.sessionId);
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
    this.promptError = null;
    this.complete = false;
    this.cancelled = false;
    this.prompt = this.client
      .prompt(handle, text)
      .then((result) => {
        if (result.text) this.records.push({ kind: "reply", text: result.text });
        const reason = String(result.stopReason);
        if (reason !== "end_turn") {
          this.records.push({ kind: "status", text: stopReasonText(reason, this.cancelled) });
        }
      })
      .catch((error: unknown) => {
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

  async purgeTranscripts(): Promise<void> {
    await this.opts.purgeTranscripts?.();
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
