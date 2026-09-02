import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_MODEL_SENTINEL,
  parseTranscript,
  redactExact,
  redactSecrets,
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

/**
 * #2164 r23 security correction — the r22 window scan cut its 32-char windows from the sanitized
 * prompt with newlines left intact, while the stderr side was split on `\n` first: a window
 * straddling a prompt line boundary could never match inside one stderr line, so a multi-line
 * prompt whose every line is under 32 characters could survive an argv echo verbatim regardless
 * of total prompt length. The scrub is now line-wise on both sides: split the sanitized prompt on
 * `\n`, trim each line, and for a line of 32+ characters add its overlapping 32-char windows (as
 * before); a shorter trimmed line of at least 8 characters is added whole to a separate literal
 * set instead. A stderr line is dropped in full if it contains any window or any literal. The
 * 8-character floor is deliberate, mirroring `redactExact`'s own 4-character no-op: scrubbing
 * 1–7 character prompt lines would delete ordinary diagnostic text (`make`, `npm`, a bare path
 * segment) that r21 §3 needs to tell the two root-cause hypotheses apart. A prompt line of 7
 * characters or fewer carrying sensitive text is therefore not scrubbed here — an accepted,
 * recorded-as-follow-up residual, not a defect this round corrects.
 */
const PROMPT_FRAGMENT_SCRUB_WINDOW = 32;
const PROMPT_FRAGMENT_LITERAL_FLOOR = 8;

function scrubPromptFragments(stderrTail: string, sanitizedPrompt: string): string {
  const windows = new Set<string>();
  const literals = new Set<string>();
  for (const rawLine of sanitizedPrompt.split("\n")) {
    const line = rawLine.trim();
    if (line.length >= PROMPT_FRAGMENT_SCRUB_WINDOW) {
      for (let i = 0; i <= line.length - PROMPT_FRAGMENT_SCRUB_WINDOW; i++) {
        windows.add(line.slice(i, i + PROMPT_FRAGMENT_SCRUB_WINDOW));
      }
    } else if (line.length >= PROMPT_FRAGMENT_LITERAL_FLOOR) {
      literals.add(line);
    }
  }
  return stderrTail
    .split("\n")
    .filter((line) => {
      for (const window of windows) {
        if (line.includes(window)) return false;
      }
      for (const literal of literals) {
        if (line.includes(literal)) return false;
      }
      return true;
    })
    .join("\n");
}

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
  /**
   * #2164 r23 security correction (item 3) — a prior turn's `submit()` never kills its child on
   * this path (only teardown/Stop do), so an abandoned still-writing child could keep mutating a
   * shared `lastSubmitStderr`/`lastSubmitExitCode` pair after a later turn's `submit()` reset it,
   * corrupting the *current* turn's diagnostic with a *different* turn's stderr and exit code. Each
   * `submit()` now creates its own capture object and the child's listeners close over that local
   * object instead of `this`, so an abandoned child's writes land only in its own unreferenced,
   * garbage-collectable capture. Nothing about child process lifecycle (kill/detach/spawn) changes.
   */
  private currentCapture: { stderrTail: string; exitCode: number | null; readonly prompt: string } =
    { stderrTail: "", exitCode: null, prompt: "" };

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
    const sanitizedPrompt = sanitizeInput(prompt);
    await this.io.writeFile(promptPath, sanitizedPrompt);
    const launchLine = await this.buildCommand(this.launchOpts, promptPath);

    const capture = { stderrTail: "", exitCode: null as number | null, prompt: sanitizedPrompt };
    this.currentCapture = capture;
    this.currentProcess = spawn("bash", ["-lc", launchLine], {
      cwd: this.launchOpts.neutralDir,
      detached: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    this.currentProcess.on("error", () => undefined);
    // #2164 r21 — bounded (oldest-dropped) stderr capture for last-submit diagnostics. Security
    // correction: when a chunk pushes the accumulator over the cap, drop the leading partial
    // line (through the first newline) from the trimmed tail so a token fragment split by the
    // window boundary can never survive as an unmatched, unredactable partial match. #2164 r23 —
    // this listener closes over `capture`, not `this`, so an abandoned earlier child (never
    // killed on this path) keeps writing only into its own unreferenced capture.
    this.currentProcess.stderr?.setEncoding("utf8");
    this.currentProcess.stderr?.on("data", (chunk: string) => {
      const combined = capture.stderrTail + chunk;
      const wasTruncated = combined.length > 4096;
      let tail = combined.slice(-4096);
      if (wasTruncated) {
        const newlineIdx = tail.indexOf("\n");
        if (newlineIdx !== -1) tail = tail.slice(newlineIdx + 1);
      }
      capture.stderrTail = tail;
    });
    this.currentProcess.once("exit", (code) => {
      capture.exitCode = code;
    });
    this.currentProcess.unref();
    this.hasSubmitted = true;
  }

  /**
   * #2164 r21 (item 4) — bounded, scrubbed stderr tail + exit code from the most recent
   * `submit()`'s child process, for the per-turn readiness-gate failure diagnostic only. Never
   * includes the prompt, the reply, or the launch command line: the current turn's sanitized
   * prompt text is scrubbed line-by-line via {@link scrubPromptFragments} alongside `neutralDir`,
   * guarding against argv being echoed into stderr by an errored child — including a fragment of
   * a too-long prompt truncated by the 4096-byte stderr cap. Not part of `CliChatEngine` (out of
   * the r21 file allowlist) — callers reach it via an inline optional cast. #2164 r23 — reads and
   * scrubs against this turn's own capture, so the buffer and the scrub target can never come
   * from two different turns.
   */
  getLastSubmitDiagnostics(): { readonly stderrTail: string; readonly exitCode: number | null } {
    const { stderrTail, exitCode, prompt } = this.currentCapture;
    const scrubbed = scrubPromptFragments(
      redactExact(redactSecrets(stderrTail), this.launchOpts?.neutralDir),
      prompt
    );
    return {
      stderrTail: scrubbed,
      exitCode
    };
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
      text: event.text,
      toolName: event.toolName,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.rejected ? { rejected: event.rejected } : {})
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
