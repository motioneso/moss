import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  createClaudeSourceLaunch,
  SOURCE_CLI_OUTPUT_BYTES,
  SOURCE_CLI_TIMEOUT_MS
} from "./claude-source-policy.js";
import {
  createGeminiSourceLaunch,
  type parseGeminiSourceCredential
} from "./gemini-source-policy.js";
import { CliChatUnavailableError } from "./errors.js";
import type { CliChatEngine, EngineLaunchOpts, TranscriptRecord } from "./types.js";

type SourceLaunch = Awaited<
  ReturnType<typeof createClaudeSourceLaunch | typeof createGeminiSourceLaunch>
>;
export type SourceCredentialRefresh = (
  version: string,
  credential: ReturnType<typeof parseGeminiSourceCredential>,
  isCurrent: () => boolean
) => Promise<void>;

/** One source call: direct spawn, bounded combined output, no partial response, private cleanup. */
export class CliSourceEngine implements CliChatEngine {
  private policy?: SourceLaunch;
  private preparation?: Promise<void>;
  private child?: ChildProcessWithoutNullStreams;
  private closed?: Promise<void>;
  private exited = false;
  private stopped = false;
  private groupStopped = false;
  private submitted = false;
  private failure?: string;
  private exitCode: number | null = null;
  private output = "";
  private result?: Promise<string>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly provider: "anthropic" | "google",
    private readonly credentialFile?: string,
    private readonly refresh?: SourceCredentialRefresh
  ) {}

  async launchStructured(
    opts: EngineLaunchOpts & { schema: Record<string, unknown>; sourceGeneration?: true }
  ): Promise<{ offset: number }> {
    if (this.preparation || this.stopped)
      throw new CliChatUnavailableError("Source generation already started or stopped");
    this.preparation = this.prepare(opts);
    await this.preparation;
    return { offset: 0 };
  }

  private async prepare(
    opts: EngineLaunchOpts & { schema: Record<string, unknown> }
  ): Promise<void> {
    const factory =
      this.provider === "google" ? createGeminiSourceLaunch : createClaudeSourceLaunch;
    this.policy = await factory(opts, this.credentialFile);
    try {
      if (this.stopped) throw new Error("Stopped during preparation");
      const { executable, args, cwd, env } = this.policy;
      const child = spawn(executable, args, {
        cwd,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.child = child;
      const decoder = new StringDecoder("utf8");
      let bytes = 0;
      this.timer = setTimeout(
        () => this.fail("Source generation timed out"),
        SOURCE_CLI_TIMEOUT_MS
      );
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > SOURCE_CLI_OUTPUT_BYTES)
            this.fail("Source generation output exceeded its limit");
          else if (stream === child.stdout) this.output += decoder.write(chunk);
        });
      child.stdin.on("error", () => this.fail("Source generation input failed"));
      child.once("error", () => this.fail("Source generation could not launch"));
      // Kill inherited-group descendants before waiting for their pipes to close, even on success.
      child.once("exit", () => this.killGroup());
      this.closed = new Promise((resolve) =>
        child.once("close", (code) => {
          if (this.timer) clearTimeout(this.timer);
          this.output += decoder.end();
          this.exitCode = code;
          this.exited = true;
          resolve();
        })
      );
    } catch {
      await this.policy.dispose();
      throw new CliChatUnavailableError("Source generation could not launch");
    }
  }

  async submitStructured(text: string): Promise<void> {
    if (
      !this.child ||
      !this.policy ||
      this.child.stdin.destroyed ||
      this.submitted ||
      this.stopped ||
      this.failure
    )
      throw new CliChatUnavailableError("Source generation input is unavailable");
    this.submitted = true;
    await new Promise<void>((resolve, reject) =>
      this.child!.stdin.end(this.policy!.encodePrompt(text), "utf8", (error?: Error | null) =>
        error ? reject(new CliChatUnavailableError("Source generation input failed")) : resolve()
      )
    );
  }

  async readStructured(
    _afterOffset: number
  ): Promise<{ text?: string; offset: number; complete: boolean }> {
    this.assertCurrent();
    if (!this.exited) return { offset: 0, complete: false };
    if (this.exitCode !== 0)
      throw new CliChatUnavailableError("Source generation exited unsuccessfully");
    this.result ??= this.validateResult();
    const text = await this.result;
    this.assertCurrent();
    return { text, offset: this.output.length, complete: true };
  }

  private async validateResult(): Promise<string> {
    const policy = this.policy!;
    const text = await policy.readResult(this.output);
    this.assertCurrent();
    if (this.refresh && "readRefreshedCredential" in policy) {
      const credential = await policy.readRefreshedCredential();
      this.assertCurrent();
      try {
        await this.refresh(
          policy.credentialVersion,
          credential,
          () => !this.stopped && !this.failure
        );
      } catch {
        throw new CliChatUnavailableError("Source generation credential update failed");
      }
    }
    return text;
  }

  private assertCurrent(): void {
    if (this.stopped || this.failure)
      throw new CliChatUnavailableError(this.failure ?? "Source generation stopped");
  }
  private fail(reason: string): void {
    this.failure ??= reason;
    this.killGroup();
  }
  private killGroup(): void {
    if (!this.child || this.groupStopped) return;
    this.groupStopped = true;
    try {
      if (this.child.pid) process.kill(-this.child.pid, "SIGKILL");
      else this.child.kill("SIGKILL");
    } catch {
      this.child.kill("SIGKILL");
    }
  }

  async kill(): Promise<void> {
    this.stopped = true;
    this.killGroup();
    await this.preparation?.catch(() => undefined);
    this.killGroup();
    await this.closed;
    await this.result?.catch(() => undefined);
    if (this.timer) clearTimeout(this.timer);
    await this.policy?.dispose();
    this.output = "";
  }
  async isAlive(): Promise<boolean> {
    return !!this.child && !this.exited && !this.stopped && !this.failure;
  }
  async interrupt(): Promise<void> {
    await this.kill();
  }
  async launch(_opts: EngineLaunchOpts): Promise<{ offset: number }> {
    throw new CliChatUnavailableError("Source generation requires structured launch");
  }
  async submit(_text: string): Promise<void> {
    throw new CliChatUnavailableError("Source generation requires structured input");
  }
  async readNew(
    _afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    throw new CliChatUnavailableError("Source generation requires structured output");
  }
}
