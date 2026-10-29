import { join } from "node:path";
import { DEFAULT_MODEL_SENTINEL, type ProviderKind, type TmuxIo } from "@moss/ai";
import type { CliChatEngine, EngineLaunchOpts, TranscriptRecord } from "./types.js";
import type { StructuredChildIdentity } from "./structured-claude-engine.js";
import { CliChatUnavailableError } from "./errors.js";
import {
  ConstrainedProcessError,
  runConstrainedStructuredProcess
} from "./constrained-structured-process.js";
import {
  prepareConstrainedClaudeProfile,
  findConstrainedClaudeExecutable,
  ConstrainedClaudeUnsupportedError,
  parseConstrainedClaudeOutput
} from "./constrained-claude-profile.js";
import {
  prepareConstrainedCodexProfile,
  parseConstrainedCodexOutput
} from "./constrained-codex-profile.js";

const MAX_PROMPT_BYTES = 65_536;
// Native JSON envelopes escape the reply; the shared validator separately caps raw content.
const MAX_OUTPUT_BYTES = 524_288;
const unavailable = () =>
  new CliChatUnavailableError("Constrained subscription summaries are unavailable");

/** Separate profile: ordinary chat and background structured callers never select this engine. */
export class ConstrainedStructuredEngine implements CliChatEngine {
  private opts?: EngineLaunchOpts & { readonly schema: Record<string, unknown> };
  private launchProfile?: {
    command: string;
    args: readonly string[];
    env: Readonly<NodeJS.ProcessEnv>;
  };
  private readonly controller = new AbortController();
  private running?: Promise<void>;
  private reply?: string;
  private failure?: Error;
  private stopFailure?: ConstrainedProcessError;
  private complete = false;
  private released = false;
  private releasing?: Promise<void>;

  constructor(
    readonly provider: ProviderKind,
    private readonly io: TmuxIo,
    private readonly homeBase: string | undefined,
    private readonly identity: StructuredChildIdentity | undefined
  ) {}

  async launch(): Promise<{ offset: number }> {
    throw unavailable();
  }
  async submit(): Promise<void> {
    throw unavailable();
  }

  async launchStructured(
    opts: EngineLaunchOpts & { readonly schema: Record<string, unknown> }
  ): Promise<{ offset: number }> {
    if (
      this.opts ||
      !this.identity ||
      !this.homeBase ||
      process.platform !== "linux" ||
      (this.provider !== "anthropic" && this.provider !== "openai-compatible") ||
      opts.mcpToken ||
      opts.mcpServerUrl ||
      opts.nativeSearch ||
      opts.replayBatch ||
      !opts.model ||
      Buffer.byteLength(JSON.stringify(opts.schema)) > 16_384
    )
      throw unavailable();
    this.opts = { ...opts, schema: structuredClone(opts.schema) };
    const model = opts.model === DEFAULT_MODEL_SENTINEL ? null : opts.model;
    const privateHome = join(opts.neutralDir, "constrained-home");
    if (this.provider === "openai-compatible") {
      if (!model || this.homeBase !== privateHome) throw unavailable();
      this.launchProfile = await prepareConstrainedCodexProfile({
        privateHome,
        model,
        schema: opts.schema,
        io: this.io,
        signal: this.controller.signal
      });
      return { offset: 0 };
    }
    const made = await this.io.run("mkdir", ["-m", "700", privateHome]);
    if (made.code !== 0) throw unavailable();
    const command = await findConstrainedClaudeExecutable();
    if (!command) throw new ConstrainedClaudeUnsupportedError();
    const token = this.identity.env?.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) throw unavailable();
    this.launchProfile = await prepareConstrainedClaudeProfile({
      token,
      privateHome,
      model,
      schema: opts.schema,
      signal: this.controller.signal,
      executablePath: command
    });
    return { offset: 0 };
  }

  /** Starts the child and returns promptly, so the runner can receive cancellation over RPC. */
  async submitStructured(prompt: string): Promise<void> {
    const opts = this.opts;
    const launch = this.launchProfile;
    const identity = this.identity;
    if (
      !opts ||
      !launch ||
      !identity ||
      this.running ||
      this.controller.signal.aborted ||
      Buffer.byteLength(prompt) > MAX_PROMPT_BYTES
    )
      throw unavailable();
    const input = prompt;
    // Credentials are deliberately selected by the profile; never merge the general identity env.
    const scopedIdentity: StructuredChildIdentity = {
      wrap: (command, args) => identity.wrap(command, args),
      signalGroup: (pid, signal) => identity.signalGroup(pid, signal),
      release: () => this.release()
    };
    this.running = runConstrainedStructuredProcess({
      ...launch,
      cwd: opts.neutralDir,
      identity: scopedIdentity,
      input,
      signal: this.controller.signal,
      timeoutMs: 100_000,
      maxStdinBytes: 196_608,
      maxStdoutBytes: MAX_OUTPUT_BYTES,
      maxStderrBytes: 65_536
    })
      .then((result) => {
        this.reply =
          this.provider === "anthropic"
            ? parseConstrainedClaudeOutput(result.stdout)
            : parseConstrainedCodexOutput(result.stdout);
      })
      .catch((error: unknown) => {
        if (error instanceof ConstrainedProcessError && error.code === "termination")
          this.stopFailure = error;
        this.failure = unavailable();
      })
      .finally(() => {
        this.complete = true;
      });
  }

  async readStructured(
    afterOffset: number
  ): Promise<{ text?: string; offset: number; complete: boolean }> {
    if (this.failure) throw this.failure;
    return {
      ...(this.reply !== undefined && afterOffset === 0 ? { text: this.reply } : {}),
      offset: this.reply === undefined ? 0 : 1,
      complete: this.complete
    };
  }
  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    const result = await this.readStructured(afterOffset);
    return {
      records: result.text === undefined ? [] : [{ kind: "reply", text: result.text }],
      offset: result.offset,
      complete: result.complete
    };
  }
  async isAlive(): Promise<boolean> {
    return !this.complete && !this.controller.signal.aborted;
  }
  async interrupt(): Promise<void> {
    await this.kill();
  }
  async kill(): Promise<void> {
    this.controller.abort();
    if (this.running) await this.running;
    if (this.stopFailure) {
      if (!this.stopFailure.retryCleanup) throw this.stopFailure;
      await this.stopFailure.retryCleanup();
      this.stopFailure = undefined;
    }
    // A running request may have failed while preserving its refreshed login. Retain the
    // engine until that cleanup succeeds, just as we do for unconfirmed process termination.
    await this.release();
    this.complete = true;
  }
  async purgeTranscripts(): Promise<void> {
    /* No transcript file is created by this engine. */
  }
  private async release(): Promise<void> {
    if (this.released) return;
    this.releasing ??= Promise.resolve()
      .then(() => this.identity?.release())
      .then(() => {
        this.released = true;
      })
      .finally(() => {
        this.releasing = undefined;
      });
    await this.releasing;
  }
}
