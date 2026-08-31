import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_MODEL_SENTINEL,
  parseTranscript,
  transcriptGlobDir,
  type Multiplexer,
  type TmuxIo
} from "@moss/ai";

import type { ChatRecordKind, CliChatEngine, EngineLaunchOpts, TranscriptRecord } from "./types.js";
import { writeClaudeOneShotPermissionHook } from "./claude-permission-hook.js";
import { vaultReadOnlyToolPatterns } from "./vault-allowlist.js";

const PROMPT_FILENAME = ".jarvis-claude-print-prompt.txt";
const PERSONA_FILENAME = "persona.md";
const CLAUDE_MCP_FILENAME = ".jarvis-claude-mcp.json";

export interface ClaudePrintChatEngineOpts {
  readonly mux?: Multiplexer;
  readonly homeBase?: string;
  readonly sessionId?: string;
  readonly credentialFile?: string;
}

export class ClaudePrintChatEngine implements CliChatEngine {
  readonly provider = "anthropic" as const;

  private readonly homeBase?: string;
  private readonly credentialFile?: string;
  private readonly sessionId: string;

  private launchOpts: EngineLaunchOpts | null = null;
  private personaPath: string | null = null;
  private transcriptPathValue: string | null = null;
  private currentProcess: ChildProcess | null = null;
  private structuredProcess: ChildProcessWithoutNullStreams | null = null;
  private structuredOutput = "";
  private structuredExited = false;
  private hasSubmitted = false;
  /** #1353 — one warning per unreadable-transcript streak, not one per 25ms poll. */
  private warnedUnreadable = false;

  constructor(
    _threadKey: string,
    private readonly io: TmuxIo,
    opts: ClaudePrintChatEngineOpts = {}
  ) {
    this.homeBase = opts.homeBase;
    this.credentialFile = opts.credentialFile;
    this.sessionId = opts.sessionId ?? randomUUID();
  }

  async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
    this.launchOpts = opts;
    this.personaPath = await this.resolvePersonaPath(opts);
    const transcriptDir = transcriptGlobDir("anthropic", opts.neutralDir, this.homeBase);
    this.transcriptPathValue = join(transcriptDir, `${this.sessionId}.jsonl`);
    return { offset: 0 };
  }

  async submit(text: string): Promise<void> {
    if (this.launchOpts === null || this.personaPath === null) {
      throw new Error("ClaudePrintChatEngine.submit called before launch()");
    }

    const promptPath = join(this.launchOpts.neutralDir, PROMPT_FILENAME);
    const prompt =
      !this.hasSubmitted && this.launchOpts.replayBatch
        ? `${this.launchOpts.replayBatch}\n\n${text}`
        : text;
    await this.io.writeFile(promptPath, sanitizeInput(prompt));
    const launchLine = await this.buildCommand(this.launchOpts, promptPath);

    this.currentProcess = spawn("bash", ["-lc", launchLine], {
      cwd: this.launchOpts.neutralDir,
      detached: true,
      stdio: "ignore"
    });
    this.currentProcess.on("error", () => undefined);
    this.currentProcess.unref();
    this.hasSubmitted = true;
  }

  async launchStructured(
    opts: EngineLaunchOpts & { readonly schema: Record<string, unknown> }
  ): Promise<{ readonly offset: number }> {
    this.launchOpts = opts;
    this.personaPath = await this.resolvePersonaPath(opts);
    const command = await this.buildStructuredCommand(opts);
    const child = spawn("bash", ["-lc", command], {
      cwd: opts.neutralDir,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.structuredProcess = child;
    this.structuredExited = false;
    this.structuredOutput = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.structuredOutput += chunk;
    });
    child.stderr.resume();
    child.once("exit", () => {
      this.structuredExited = true;
    });
    child.once("error", () => {
      this.structuredExited = true;
    });
    return { offset: 0 };
  }

  async submitStructured(text: string): Promise<void> {
    const child = this.structuredProcess;
    if (child === null || child.stdin.destroyed) {
      throw new Error("ClaudePrintChatEngine structured stream is unavailable");
    }
    const frame = `${JSON.stringify({
      type: "user",
      message: { role: "user", content: text }
    })}\n`;
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(frame, "utf8", (error) => (error ? reject(error) : resolve()));
    });
  }

  async readStructured(afterOffset: number): Promise<{
    readonly text?: string;
    readonly offset: number;
    readonly complete: boolean;
  }> {
    const slice = this.structuredOutput.slice(afterOffset);
    const lines = slice.split("\n");
    const completeLines = lines.slice(0, -1);
    const offset = this.structuredOutput.length - (lines.at(-1)?.length ?? 0);
    for (const line of completeLines) {
      const record = parseStructuredRecord(line);
      if (record.text !== undefined) return { ...record, offset, complete: true };
      if (record.complete) return { offset, complete: true };
    }
    if (this.structuredExited) return { offset: this.structuredOutput.length, complete: true };
    return { offset, complete: false };
  }

  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    if (this.transcriptPathValue === null) {
      return { records: [], offset: afterOffset, complete: false };
    }

    let jsonl: string;
    try {
      jsonl = await this.io.readFile(this.transcriptPathValue);
      this.warnedUnreadable = false;
    } catch {
      // A miss here is NORMAL for the first few polls of a turn — `claude -p` has not
      // created the transcript yet. It is a DEFECT if it never stops: the turn then
      // produces nothing until the #456 idle watchdog trips 180s later and returns an
      // empty reply with no message persisted, and nothing anywhere says why.
      //
      // #1353 was exactly that (the computed project dir did not match Claude's own
      // encoding) and took days to find because this branch was silent. Warn ONCE per
      // unreadable streak, path only — a transcript path contains no user content, but
      // the transcript itself does, so never log the body.
      if (this.hasSubmitted && !this.warnedUnreadable) {
        this.warnedUnreadable = true;
        console.warn(
          `[claude-print] transcript not readable at ${this.transcriptPathValue} — ` +
            "if this persists the turn will time out empty"
        );
      }
      return { records: [], offset: afterOffset, complete: false };
    }

    const parsed = parseTranscript("anthropic", jsonl, afterOffset);
    const records: TranscriptRecord[] = parsed.events.map((event) => ({
      kind: event.kind as ChatRecordKind,
      text: event.text
    }));
    if (parsed.complete && parsed.reply !== null) {
      records.push({ kind: "reply", text: parsed.reply });
    }
    return { records, offset: jsonl.length, complete: parsed.complete };
  }

  async isAlive(): Promise<boolean> {
    if (this.structuredProcess !== null) {
      return this.structuredProcess.exitCode === null && this.structuredProcess.signalCode === null;
    }
    return (
      this.currentProcess !== null &&
      this.currentProcess.exitCode === null &&
      this.currentProcess.signalCode === null
    );
  }

  async interrupt(): Promise<void> {
    if (this.structuredProcess !== null) {
      this.structuredProcess.kill("SIGINT");
      return;
    }
    if (this.currentProcess !== null) this.currentProcess.kill("SIGINT");
  }

  async kill(): Promise<void> {
    const child = this.structuredProcess ?? this.currentProcess;
    this.structuredProcess = null;
    this.currentProcess = null;
    this.structuredOutput = "";
    this.structuredExited = true;
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

  private async buildCommand(opts: EngineLaunchOpts, promptPath: string): Promise<string> {
    const claudeCmd =
      this.credentialFile && existsSync(this.credentialFile)
        ? `CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shellQuote(this.credentialFile)})" claude`
        : "claude";
    const sessionFlag = this.hasSubmitted
      ? `--resume ${this.sessionId}`
      : `--session-id ${this.sessionId}`;
    const parts = [
      `cd ${shellQuote(opts.neutralDir)} &&`,
      claudeCmd,
      "-p",
      sessionFlag,
      "--permission-mode dontAsk"
    ];

    if (opts.mcpToken && opts.mcpServerUrl) {
      const mcpConfigPath = await this.writeClaudeMcpConfig(opts);
      const settingsPath = await writeClaudeOneShotPermissionHook(this.io, {
        neutralDir: opts.neutralDir
      });
      parts.push(`--mcp-config ${shellQuote(mcpConfigPath)}`);
      parts.push(`--settings ${shellQuote(settingsPath)}`);
      const allowedTools = ["mcp__jarvis__*", ...vaultReadOnlyToolPatterns()].join(" ");
      parts.push(`--allowedTools ${shellQuote(allowedTools)}`);
      parts.push('--tools "Read,Glob,Grep"');
    } else {
      parts.push('--tools ""');
    }

    parts.push(
      `--append-system-prompt-file ${shellQuote(this.personaPath ?? opts.personaPath)}`,
      "--strict-mcp-config"
    );
    const modelFlag = modelOverrideFlag(opts);
    if (modelFlag) parts.push(modelFlag);
    parts.push(`"$(cat ${shellQuote(promptPath)})"`);

    return parts.join(" ");
  }

  private async buildStructuredCommand(
    opts: EngineLaunchOpts & { readonly schema: Record<string, unknown> }
  ): Promise<string> {
    const claudeCmd =
      this.credentialFile && existsSync(this.credentialFile)
        ? `CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shellQuote(this.credentialFile)})" claude`
        : "claude";
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
      '--tools ""',
      "--strict-mcp-config",
      `--json-schema ${shellQuote(JSON.stringify(opts.schema))}`,
      `--append-system-prompt-file ${shellQuote(this.personaPath ?? opts.personaPath)}`
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
      throw new Error(`Could not lock down Claude MCP config file: ${chmod.stderr ?? ""}`.trim());
    }
    return path;
  }
}

function parseStructuredRecord(line: string): {
  readonly text?: string;
  readonly complete?: boolean;
} {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return {};
  }
  if (record.type !== "result") return {};
  const candidate = record.structured_output ?? record.result;
  if (typeof candidate === "object" && candidate !== null) {
    return { text: JSON.stringify(candidate) };
  }
  if (typeof candidate === "string") {
    try {
      JSON.parse(candidate);
      return { text: candidate };
    } catch {
      return { complete: true };
    }
  }
  return { complete: true };
}

function sanitizeInput(text: string): string {
  return text.replace(/^(\s*)!+/, "$1");
}

function modelOverrideFlag(opts: EngineLaunchOpts): string | null {
  if (!opts.model || opts.model === DEFAULT_MODEL_SENTINEL) return null;
  return `--model ${shellQuote(opts.model)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
