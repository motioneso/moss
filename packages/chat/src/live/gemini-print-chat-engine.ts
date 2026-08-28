/**
 * #2028 — the one-shot Google chat engine: one `gemini` process per turn, no multiplexer session.
 *
 * This replaces the Antigravity (`agy`) engine that shipped here before. That engine could never
 * have worked on a real install: the binary it launched is not the one the installer puts on the
 * box, and the transcript path it read from does not exist for any Google CLI we ship.
 *
 * Everything below was measured against `@google/gemini-cli@0.57.0`, the version pinned in the
 * cli-runner catalog:
 *
 *   - The reply is read from the process's own standard output (`-o stream-json`, one JSON object
 *     per line), NOT from the CLI's saved chat file. The saved file is a change log of edits to a
 *     conversation object, not a transcript, and its short-id path cannot be computed up front.
 *   - The session id is ours: `--session-id <uuid>` opens the conversation, `--resume <uuid>`
 *     continues it. Passing both makes the CLI refuse to start, so they are never combined.
 *   - `--skip-trust` is required. A freshly created session folder is untrusted, and an untrusted
 *     folder silently downgrades the approval mode back to "default", which then blocks forever on
 *     a prompt no web user can see.
 *   - `TMPDIR` points at the session folder because the CLI writes crash reports into the
 *     temporary directory and those reports quote the founder's prompt verbatim. Pointing it here
 *     puts them inside the folder the purge already deletes.
 *   - `--approval-mode yolo` is safe ONLY because the settings file written at launch registers
 *     zero built-in tools, so there is nothing for the model to run. See `writeSettings` below.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { parseTranscript, type Multiplexer, type TmuxIo } from "@moss/ai";

import { modelOverrideFlag, sanitizeInput, shellQuote } from "./cli-engine-helpers.js";
import {
  GEMINI_OUTPUT_FILENAME,
  GEMINI_STDERR_FILENAME,
  persistGeminiSessionIdentity,
  purgeGeminiConversation
} from "./private-transcript-cleanup.js";
import type { ChatRecordKind, CliChatEngine, EngineLaunchOpts, TranscriptRecord } from "./types.js";

const PROMPT_FILENAME = ".jarvis-gemini-prompt.txt";

export interface GeminiPrintChatEngineOpts {
  /** Ignored by this engine; accepted so every engine takes the same options shape. */
  readonly mux?: Multiplexer;
  /** Base dir whose `.gemini` holds the CLI's own state. */
  readonly homeBase?: string;
  /** Test seam: pin the conversation id instead of generating one. */
  readonly sessionId?: string;
}

export class GeminiPrintChatEngine implements CliChatEngine {
  readonly provider = "google" as const;
  private readonly homeBase?: string;
  private readonly sessionId: string;
  private neutralDir: string | null = null;
  private launchOpts: EngineLaunchOpts | null = null;
  private currentProcess: ChildProcess | null = null;
  private hasSubmitted = false;

  constructor(
    _threadKey: string,
    private readonly io: TmuxIo,
    opts: GeminiPrintChatEngineOpts = {}
  ) {
    this.homeBase = opts.homeBase;
    this.sessionId = opts.sessionId ?? randomUUID();
  }

  async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
    this.neutralDir = opts.neutralDir;
    this.launchOpts = opts;
    this.hasSubmitted = false;
    if (opts.personaText !== undefined) {
      await this.io.writeFile(join(opts.neutralDir, "persona.md"), opts.personaText);
    }
    await this.writeSettings(opts.neutralDir);
    // Written before the first turn on purpose: a crash mid-turn still leaves the boot sweep a
    // pointer to everything this session put on disk.
    await persistGeminiSessionIdentity(this.io, opts.neutralDir, this.sessionId);
    return { offset: 0 };
  }

  async submit(text: string): Promise<void> {
    if (this.neutralDir === null || this.launchOpts === null)
      throw new Error("GeminiPrintChatEngine.submit called before launch()");
    const promptPath = join(this.neutralDir, PROMPT_FILENAME);
    await this.io.writeFile(promptPath, sanitizeInput(text));
    const sessionFlag = this.hasSubmitted
      ? `--resume ${this.sessionId}`
      : `--session-id ${this.sessionId}`;
    this.hasSubmitted = true;
    const parts = [
      `cd ${shellQuote(this.neutralDir)} &&`,
      `TMPDIR=${shellQuote(this.neutralDir)}`,
      "gemini",
      "-p",
      `"$(cat ${shellQuote(promptPath)})"`,
      "-o",
      "stream-json",
      "--approval-mode",
      "yolo",
      "--skip-trust",
      sessionFlag
    ];
    const modelFlag = modelOverrideFlag(this.launchOpts);
    if (modelFlag) parts.push(modelFlag);
    // Append, never truncate: `readNew` tracks a byte offset into one growing file across turns.
    parts.push(
      `>> ${shellQuote(join(this.neutralDir, GEMINI_OUTPUT_FILENAME))}`,
      `2>> ${shellQuote(join(this.neutralDir, GEMINI_STDERR_FILENAME))}`
    );
    this.currentProcess = spawn("bash", ["-lc", parts.join(" ")], {
      cwd: this.neutralDir,
      detached: true,
      stdio: "ignore"
    });
    this.currentProcess.on("error", () => undefined);
    this.currentProcess.unref();
  }

  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    if (this.neutralDir === null) return { records: [], offset: afterOffset, complete: false };
    let jsonl: string;
    try {
      jsonl = await this.io.readFile(join(this.neutralDir, GEMINI_OUTPUT_FILENAME));
    } catch {
      return { records: [], offset: afterOffset, complete: false };
    }
    const parsed = parseTranscript("google", jsonl, afterOffset);
    const records: TranscriptRecord[] = parsed.events.map((event) => ({
      kind: event.kind as ChatRecordKind,
      text: event.text
    }));
    if (parsed.complete && parsed.reply !== null)
      records.push({ kind: "reply", text: parsed.reply });
    return { records, offset: jsonl.length, complete: parsed.complete };
  }

  async isAlive(): Promise<boolean> {
    return (
      this.currentProcess !== null &&
      this.currentProcess.exitCode === null &&
      this.currentProcess.signalCode === null
    );
  }

  async interrupt(): Promise<void> {
    if (this.currentProcess !== null) this.currentProcess.kill("SIGINT");
  }

  async kill(): Promise<void> {
    if (this.currentProcess !== null) this.currentProcess.kill();
    this.currentProcess = null;
  }

  async purgeTranscripts(): Promise<void> {
    if (this.neutralDir === null) return;
    if (!(await purgeGeminiConversation(this.io, this.neutralDir, this.homeBase)))
      throw new Error("Could not purge Gemini conversation transcript");
  }

  /**
   * An empty `tools.core` list is an allowlist that matches nothing, so the CLI registers no
   * built-in tools at all — no file writes, no shell. That is what makes `--approval-mode yolo`
   * safe here: automatic approval of an empty tool set approves nothing. Chat with Gemini
   * therefore has no Jarv1s tools in this change; see the pull request for why that is deliberate.
   */
  private async writeSettings(neutralDir: string): Promise<void> {
    const settingsDir = join(neutralDir, ".gemini");
    await this.io.run("mkdir", ["-p", settingsDir]);
    const path = join(settingsDir, "settings.json");
    await this.io.writeFile(path, JSON.stringify({ tools: { core: [] as string[] } }, null, 2));
    // No secret in this file, but the session folder keeps every file 0600 (section 6.2).
    const chmod = await this.io.run("chmod", ["600", path]);
    if (chmod.code !== 0) {
      await this.io.run("rm", ["-f", path]);
      throw new Error(`Could not lock down Gemini settings file: ${chmod.stderr ?? ""}`.trim());
    }
  }
}
