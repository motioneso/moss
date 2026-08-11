/**
 * Claude adapter for the persistent provider chat runtime (#1557 Phase 1, P1.3/P1.4).
 *
 * One warm child process serves every turn on a session until reaped — piped stdio (not the
 * detached/ignore pattern in `claude-print-chat-engine.ts`), fed one `stream-json` user frame per
 * `submitTurn`, decoded push-style through the bounded `PersistentStreamDecoder` (P1.2). Admission
 * is fail-closed: `launch()` never resolves, and no user frame is ever written, until the
 * server-side MCP session for the minted token has both initialized and listed tools
 * (`createMcpReadinessProbe`, P1.4) — `--strict-mcp-config` alone does not guarantee that.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_MODEL_SENTINEL, type ProviderKind, type TmuxIo } from "@moss/ai";

import { PersistentStreamDecoder } from "./persistent-stream-decoder.js";
import { writeClaudePermissionHook } from "./claude-permission-hook.js";
import type {
  CancelOutcome,
  ChildState,
  McpReadinessProbe,
  ProviderChatRuntime,
  ProviderRuntimeKind,
  ReapReason,
  RecoveryOutcome,
  RuntimeHealth
} from "./provider-runtime.js";
import type { EngineLaunchOpts } from "./types.js";
import { vaultReadOnlyToolPatterns } from "./vault-allowlist.js";

const PERSONA_FILENAME = "persona.md";
const CLAUDE_MCP_FILENAME = ".jarvis-claude-persistent-mcp.json";

export const NEUTRAL_ADMISSION_FAILURE =
  "The assistant session could not be verified as ready and was not started.";
export const NEUTRAL_LAUNCH_FAILURE = "The assistant session could not be started.";
export const NEUTRAL_CRASH_FAILURE =
  "The assistant session ended unexpectedly and could not be recovered.";

export interface ClaudePersistentRuntimeOpts {
  readonly io: Pick<TmuxIo, "run" | "writeFile">;
  readonly credentialFile?: string;
  /** Injected for tests; production callers rely on the default (piped-stdio, process-group spawn). */
  readonly spawnChild?: (command: string, cwd: string) => ChildProcessWithoutNullStreams;
}

type PersistentLaunchOpts = EngineLaunchOpts & { readonly mcpReadiness: McpReadinessProbe };

export class ClaudePersistentRuntime implements ProviderChatRuntime {
  readonly kind: ProviderRuntimeKind = "persistent";
  readonly provider: ProviderKind = "anthropic";

  private readonly io: Pick<TmuxIo, "run" | "writeFile">;
  private readonly credentialFile?: string;
  private readonly spawnChild: (command: string, cwd: string) => ChildProcessWithoutNullStreams;

  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder: PersistentStreamDecoder | null = null;
  private launchOpts: PersistentLaunchOpts | null = null;

  private state: ChildState = "launching";
  private turnsCompleted = 0;
  private lastResultAt: number | null = null;

  private currentTurnId: string | null = null;
  private lastSubmittedText: string | null = null;
  private frameAcceptedForTurn = false;
  private toolActivityForTurn = false;
  private recoveredForTurn = false;

  constructor(opts: ClaudePersistentRuntimeOpts) {
    this.io = opts.io;
    this.credentialFile = opts.credentialFile;
    this.spawnChild =
      opts.spawnChild ??
      ((command, cwd) =>
        spawn("bash", ["-lc", command], {
          cwd,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"]
        }) as ChildProcessWithoutNullStreams);
  }

  async launch(opts: PersistentLaunchOpts): Promise<void> {
    if (!opts.mcpToken || !opts.mcpServerUrl) {
      throw new Error(NEUTRAL_LAUNCH_FAILURE);
    }

    this.launchOpts = opts;
    this.state = "launching";
    this.turnsCompleted = 0;
    this.lastResultAt = null;
    this.currentTurnId = null;
    this.frameAcceptedForTurn = false;
    this.toolActivityForTurn = false;
    this.recoveredForTurn = false;

    const personaPath = await this.resolvePersonaPath(opts);
    const command = await this.buildCommand(opts, personaPath);

    const decoder = new PersistentStreamDecoder({
      killChild: () => void this.killChildProcess()
    });
    this.decoder = decoder;

    const child = this.spawnChild(command, opts.neutralDir);
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => decoder.write(chunk));
    child.stdout.on("end", () => decoder.end());
    child.stderr.resume();
    child.on("error", () => undefined);

    try {
      await opts.mcpReadiness();
    } catch {
      await this.killChildProcess();
      throw new Error(NEUTRAL_ADMISSION_FAILURE);
    }
    this.state = "ready";
  }

  async submitTurn(turnId: string, engineText: string): Promise<void> {
    if (this.child === null || this.decoder === null) {
      throw new Error(NEUTRAL_LAUNCH_FAILURE);
    }
    if (turnId !== this.currentTurnId) {
      this.recoveredForTurn = false;
    }
    this.currentTurnId = turnId;
    this.frameAcceptedForTurn = false;
    this.toolActivityForTurn = false;
    this.decoder.beginTurn(turnId);
    this.state = "in-turn";

    const frame = `${JSON.stringify({ type: "user", message: { role: "user", content: engineText } })}\n`;
    const child = this.child;
    this.lastSubmittedText = engineText;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(frame, "utf8", (error) => (error ? reject(error) : resolve()));
    });
    this.frameAcceptedForTurn = true;
  }

  async *streamEvents(): AsyncIterable<import("./provider-runtime.js").RuntimeTurnEvent> {
    if (this.decoder === null) return;
    for await (const event of this.decoder.events()) {
      if (event.kind === "record" && event.record.kind === "tool") {
        this.toolActivityForTurn = true;
      } else if (event.kind === "turn-complete") {
        this.turnsCompleted += 1;
        this.lastResultAt = Date.now();
        this.state = "idle";
      } else if (event.kind === "turn-failed") {
        this.state = "idle";
      }
      yield event;
    }
  }

  async cancel(_turnId: string): Promise<CancelOutcome> {
    this.child?.kill("SIGINT");
    return { approvalsResolved: 0 };
  }

  async health(): Promise<RuntimeHealth> {
    return {
      alive: this.child !== null && this.child.exitCode === null && this.child.signalCode === null,
      state: this.state,
      turnsCompleted: this.turnsCompleted,
      lastResultAt: this.lastResultAt
    };
  }

  async reap(_reason: ReapReason): Promise<void> {
    this.state = "reaping";
    await this.killChildProcess();
  }

  async recover(turnId: string): Promise<RecoveryOutcome> {
    const canResubmit =
      this.currentTurnId === turnId &&
      !this.frameAcceptedForTurn &&
      !this.toolActivityForTurn &&
      !this.recoveredForTurn &&
      this.launchOpts !== null &&
      this.lastSubmittedText !== null;
    if (!canResubmit) {
      return { kind: "neutral-failure", reason: NEUTRAL_CRASH_FAILURE };
    }

    this.recoveredForTurn = true;
    try {
      await this.launch(this.launchOpts!);
      await this.submitTurn(turnId, this.lastSubmittedText!);
      return { kind: "resubmitted" };
    } catch {
      return { kind: "neutral-failure", reason: NEUTRAL_CRASH_FAILURE };
    }
  }

  private async killChildProcess(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return;

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    const signal = (kind: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch {
        child.kill(kind);
      }
    };
    signal("SIGTERM");
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000))
    ]);
    if (!graceful) {
      signal("SIGKILL");
      await exited;
    }
  }

  private async resolvePersonaPath(opts: EngineLaunchOpts): Promise<string> {
    if (opts.personaText === undefined) return opts.personaPath;
    await this.io.run("mkdir", ["-p", opts.neutralDir]);
    const path = join(opts.neutralDir, PERSONA_FILENAME);
    await this.io.writeFile(path, opts.personaText);
    await this.io.run("chmod", ["600", path]);
    return path;
  }

  private async buildCommand(opts: EngineLaunchOpts, personaPath: string): Promise<string> {
    if (!opts.mcpToken || !opts.mcpServerUrl) {
      throw new Error(NEUTRAL_LAUNCH_FAILURE);
    }
    const claudeCmd =
      this.credentialFile && existsSync(this.credentialFile)
        ? `CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shellQuote(this.credentialFile)})" claude`
        : "claude";
    const mcpConfigPath = await this.writeClaudeMcpConfig(opts);
    const settingsPath = await writeClaudePermissionHook(this.io, {
      neutralDir: opts.neutralDir,
      mcpToken: opts.mcpToken,
      mcpServerUrl: opts.mcpServerUrl
    });
    const allowedTools = ["mcp__jarvis__*", ...vaultReadOnlyToolPatterns()].join(" ");

    const parts = [
      `cd ${shellQuote(opts.neutralDir)} &&`,
      claudeCmd,
      "--print",
      "--input-format stream-json",
      "--output-format stream-json",
      "--include-partial-messages",
      "--verbose",
      "--no-session-persistence",
      "--permission-mode dontAsk",
      `--mcp-config ${shellQuote(mcpConfigPath)}`,
      `--settings ${shellQuote(settingsPath)}`,
      `--allowedTools ${shellQuote(allowedTools)}`,
      `--append-system-prompt-file ${shellQuote(personaPath)}`,
      "--strict-mcp-config"
    ];
    const modelFlag = modelOverrideFlag(opts);
    if (modelFlag) parts.push(modelFlag);
    return parts.join(" ");
  }

  private async writeClaudeMcpConfig(opts: EngineLaunchOpts): Promise<string> {
    const path = join(opts.neutralDir, CLAUDE_MCP_FILENAME);
    const mcpConfig = JSON.stringify({
      mcpServers: {
        jarvis: {
          type: "http",
          url: opts.mcpServerUrl,
          headers: { Authorization: `Bearer ${opts.mcpToken}` },
          timeout: 180000
        }
      }
    });
    await this.io.writeFile(path, mcpConfig);
    const chmod = await this.io.run("chmod", ["600", path]);
    if (chmod.code !== 0) {
      await this.io.run("rm", ["-f", path]);
      throw new Error(NEUTRAL_LAUNCH_FAILURE);
    }
    return path;
  }
}

/**
 * Fail-closed MCP readiness probe (P1.4): POSTs JSON-RPC `initialize` then `tools/list` to
 * `mcpServerUrl` with the child's bearer token. Rejects on a non-2xx response OR on a JSON-RPC
 * `.error` field present at HTTP 200 — `mcp-transport.ts` returns errors that way (e.g. a
 * `tools/list` resolver failure), so status-code-only checking would miss it.
 */
export function createMcpReadinessProbe(
  mcpServerUrl: string,
  mcpToken: string,
  fetchImpl: typeof fetch = fetch
): McpReadinessProbe {
  return async () => {
    await mcpRpcCall(fetchImpl, mcpServerUrl, mcpToken, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "jarvis-persistent-probe", version: "0.1.0" }
    });
    await mcpRpcCall(fetchImpl, mcpServerUrl, mcpToken, "tools/list", {});
  };
}

async function mcpRpcCall(
  fetchImpl: typeof fetch,
  mcpServerUrl: string,
  mcpToken: string,
  method: string,
  params: unknown
): Promise<void> {
  const response = await fetchImpl(mcpServerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${mcpToken}`
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!response.ok) {
    throw new Error(NEUTRAL_ADMISSION_FAILURE);
  }
  const body = (await response.json()) as { error?: unknown };
  if (body && typeof body === "object" && body.error !== undefined) {
    throw new Error(NEUTRAL_ADMISSION_FAILURE);
  }
}

function modelOverrideFlag(opts: EngineLaunchOpts): string | null {
  if (!opts.model || opts.model === DEFAULT_MODEL_SENTINEL) return null;
  return `--model ${shellQuote(opts.model)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
