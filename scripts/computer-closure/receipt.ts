import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { sign } from "node:crypto";
import { assertRoot, descriptorPath, openRoot } from "../computer-watchdog/linux-files.js";
import { supervisorError } from "../computer-watchdog/trust.js";
import type { ClosureDeployment } from "./config.js";
import type { WatchdogProcessIdentity } from "../computer-watchdog/policy.js";

export interface ClosureObservations {
  readonly files: Readonly<Record<string, string>> | null;
  readonly collectors: readonly WatchdogProcessIdentity[] | null;
  readonly endpointsSha256: string | null;
  readonly lockPresent: boolean | null;
}

/** A signed observation is not a durability acknowledgement: native exit0 is also required. */
export class ClosureReceipt {
  #bytes = 0;
  #terminal = false;
  #published: { dev: number; ino: number; mtimeMs: number; ctimeMs: number } | undefined;
  private constructor(
    private readonly deployment: ClosureDeployment,
    private readonly directory: FileHandle,
    private readonly file: FileHandle,
    private readonly verifier: WatchdogProcessIdentity,
    private readonly startedAtMs: number
  ) {}

  static async create(
    deployment: ClosureDeployment,
    verifier: WatchdogProcessIdentity,
    startedAtMs: number
  ): Promise<ClosureReceipt> {
    const directory = await openRoot(deployment.configuration.receipt);
    let file: FileHandle | undefined;
    try {
      file = await open(
        `${descriptorPath(directory)}/closure.jsonl`,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600
      );
      return new ClosureReceipt(deployment, directory, file, verifier, startedAtMs);
    } catch {
      await file?.close();
      await directory.close();
      throw supervisorError();
    }
  }

  async append(
    type: "attempt" | "observed-closed" | "failed",
    atMs: number,
    observations: ClosureObservations
  ): Promise<void> {
    if (this.#terminal || (this.#bytes === 0) !== (type === "attempt")) throw supervisorError();
    // Latch before signing/writing: a partial terminal line is never retried or overwritten.
    if (type !== "attempt") this.#terminal = true;
    const { configuration: config } = this.deployment;
    const record = {
      domain: "moss-computer-independent-closure",
      version: 1,
      type,
      binding: config.supervisor.lifetime!.binding,
      verifier: this.verifier,
      expected: { runner: config.supervisor.runner, ...config.processes },
      startedAtMs: this.startedAtMs,
      atMs,
      configSha256: this.deployment.config.hash,
      artifactSha256: config.artifactSha256,
      publicKeySha256: config.publicKeySha256,
      observations,
      reason:
        type === "attempt"
          ? "observations-pending"
          : type === "observed-closed"
            ? "sampled-closure"
            : "verification-unavailable"
    };
    const body = Buffer.from(JSON.stringify(record));
    const bytes = Buffer.from(
      `${JSON.stringify({ record, signature: sign(null, body, this.deployment.signingKey).toString("base64") })}\n`
    );
    if (this.#bytes + bytes.length > 64 * 1024) throw supervisorError();
    await this.#assertCurrent();
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await this.file.write(bytes, offset, bytes.length - offset, null);
      if (!bytesWritten) throw supervisorError();
      offset += bytesWritten;
    }
    this.#bytes += bytes.length;
    await this.file.sync();
    await this.directory.sync();
    await this.#assertCurrent();
  }
  async #assertCurrent(): Promise<void> {
    await assertRoot(this.deployment.configuration.receipt);
    const actual = await lstat(`${descriptorPath(this.directory)}/closure.jsonl`);
    const opened = await this.file.stat();
    if (
      !actual.isFile() ||
      actual.dev !== opened.dev ||
      actual.ino !== opened.ino ||
      actual.uid !== this.deployment.configuration.receipt.uid ||
      actual.nlink !== 1 ||
      (actual.mode & 0o7777) !== 0o600 ||
      actual.size !== this.#bytes
    )
      throw supervisorError();
  }
  async close(): Promise<void> {
    try {
      await this.#assertCurrent();
      const { dev, ino, mtimeMs, ctimeMs } = await this.file.stat();
      this.#published = { dev, ino, mtimeMs, ctimeMs };
    } finally {
      try {
        await this.file.close();
      } finally {
        await this.directory.close();
      }
    }
  }

  async assertPublished(): Promise<void> {
    const root = this.deployment.configuration.receipt;
    await assertRoot(root);
    const stat = await lstat(`${root.path}/closure.jsonl`);
    if (
      !this.#published ||
      !stat.isFile() ||
      stat.uid !== root.uid ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size !== this.#bytes ||
      stat.dev !== this.#published.dev ||
      stat.ino !== this.#published.ino ||
      stat.mtimeMs !== this.#published.mtimeMs ||
      stat.ctimeMs !== this.#published.ctimeMs
    )
      throw supervisorError();
  }
}
