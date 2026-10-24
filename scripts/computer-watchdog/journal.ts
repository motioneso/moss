import { sha256 } from "./trust.js";
import { constants, type Stats } from "node:fs";
import { lstat, open, opendir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { RootIdentity } from "../computer-host/config.js";
import { assertRoot, descriptorPath, openRoot } from "./linux-files.js";
import { supervisorError } from "./trust.js";
import type {
  WatchdogConfiguration,
  WatchdogProcessIdentity,
  WatchdogSample,
  WatchdogStopReason
} from "./policy.js";

export const JOURNAL_LIMIT = 512 * 1024;
const RESERVED = 4096;
const NAME = "observation.jsonl";
type Record =
  | { type: "start"; configuration: WatchdogConfiguration }
  | { type: "collector"; identity: WatchdogProcessIdentity }
  | { type: "sample"; sample: WatchdogSample }
  | {
      type: "stop";
      atMs: number;
      reason: WatchdogStopReason;
      collector: WatchdogProcessIdentity | null;
      collectorPid: number | null;
    };

async function entries(directory: FileHandle): Promise<string[]> {
  const iterator = await opendir(descriptorPath(directory), { bufferSize: 2 });
  const names: string[] = [];
  try {
    for (;;) {
      const entry = await iterator.read();
      if (!entry) return names;
      names.push(entry.name);
      if (names.length > 1) throw supervisorError();
    }
  } finally {
    await iterator.close();
  }
}
function safeMetadata(stat: Stats, root: RootIdentity): boolean {
  return (
    stat.isFile() &&
    stat.uid === root.uid &&
    (stat.mode & 0o7777) === 0o600 &&
    stat.nlink === 1 &&
    Number(stat.size) < JOURNAL_LIMIT
  );
}
/** The collector sees actual metadata only; parent additionally checks its open inode/byte count. */
export async function inspectJournal(root: RootIdentity): Promise<void> {
  const directory = await openRoot(root);
  try {
    if ((await entries(directory)).join(",") !== NAME) throw supervisorError();
    if (!safeMetadata(await lstat(`${descriptorPath(directory)}/${NAME}`), root))
      throw supervisorError();
    await assertRoot(root);
  } finally {
    await directory.close();
  }
}

/** Exclusive append-only run marker. Existing/crashed runs are never reopened or erased. */
export class ObservationJournal {
  #bytes = 0;
  #samples = 0;
  #collectors = 0;
  #terminal = false;
  #pending: Promise<void> | null = null;
  private constructor(
    readonly root: RootIdentity,
    private readonly directory: FileHandle,
    private readonly file: FileHandle
  ) {}

  static async create(
    root: RootIdentity,
    configuration: WatchdogConfiguration
  ): Promise<ObservationJournal> {
    const directory = await openRoot(root);
    let file: FileHandle | undefined;
    try {
      if ((await entries(directory)).length) throw supervisorError();
      file = await open(
        `${descriptorPath(directory)}/${NAME}`,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600
      );
      const journal = new ObservationJournal(root, directory, file);
      await journal.#append({ type: "start", configuration });
      return journal;
    } catch {
      await file?.close();
      await directory.close();
      throw supervisorError();
    }
  }
  get pending(): boolean {
    return this.#pending !== null;
  }
  async inspect(): Promise<void> {
    if (this.#pending) throw supervisorError();
    await inspectJournal(this.root);
    const [opened, actual] = await Promise.all([
      this.file.stat(),
      lstat(join(this.root.path, NAME))
    ]);
    if (
      opened.ino !== actual.ino ||
      opened.dev !== actual.dev ||
      opened.size !== this.#bytes ||
      !safeMetadata(opened, this.root)
    )
      throw supervisorError();
  }
  /** Start-only snapshot from this invocation's actual open descriptor, never a path reopen. */
  async startSnapshot(configuration: WatchdogConfiguration) {
    const current = () => {
      if (this.#pending || this.#terminal || this.#samples || this.#collectors)
        throw supervisorError();
    };
    current();
    await this.inspect();
    const expected = Buffer.from(`${JSON.stringify({ type: "start", configuration })}\n`);
    if (this.#bytes !== expected.length || expected.length > 4096) throw supervisorError();
    const buffer = Buffer.alloc(expected.length + 1);
    const { bytesRead } = await this.file.read(buffer, 0, buffer.length, 0);
    const stat = await this.file.stat();
    await this.inspect();
    current();
    if (bytesRead !== expected.length || !buffer.subarray(0, bytesRead).equals(expected))
      throw supervisorError();
    return { dev: stat.dev, ino: stat.ino, size: stat.size, hash: sha256(expected) };
  }
  collector(identity: WatchdogProcessIdentity): Promise<void> {
    if (this.#terminal || ++this.#collectors > 400) return Promise.reject(supervisorError());
    return this.#append({ type: "collector", identity });
  }
  sample(sample: WatchdogSample): Promise<void> {
    if (this.#terminal || ++this.#samples > 400) return Promise.reject(supervisorError());
    return this.#append({ type: "sample", sample });
  }
  stop(
    atMs: number,
    reason: WatchdogStopReason,
    collector: WatchdogProcessIdentity | null,
    collectorPid: number | null = collector?.pid ?? null
  ): Promise<void> {
    if (this.#terminal) return Promise.reject(supervisorError());
    this.#terminal = true;
    // Serialize behind the sole earlier append, even after its failure. Never wait for a child.
    const previous = this.#pending ?? Promise.resolve();
    return previous
      .catch(() => {})
      .then(() => this.#append({ type: "stop", atMs, reason, collector, collectorPid }));
  }
  #append(record: Record): Promise<void> {
    if (this.#pending) return Promise.reject(supervisorError());
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`);
    if (
      bytes.length > 4096 ||
      this.#bytes + bytes.length >= JOURNAL_LIMIT - (record.type === "stop" ? 0 : RESERVED)
    )
      return Promise.reject(supervisorError());
    const write = async () => {
      await assertRoot(this.root);
      const actual = await lstat(join(this.root.path, NAME));
      const opened = await this.file.stat();
      if (
        !safeMetadata(actual, this.root) ||
        actual.ino !== opened.ino ||
        actual.dev !== opened.dev ||
        actual.size !== this.#bytes
      )
        throw supervisorError();
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await this.file.write(bytes, offset, bytes.length - offset, null);
        if (!bytesWritten) throw supervisorError();
        offset += bytesWritten;
      }
      this.#bytes += bytes.length;
      await this.file.sync();
      await this.directory.sync();
    };
    const pending = write().finally(() => {
      if (this.#pending === pending) this.#pending = null;
    });
    this.#pending = pending;
    return pending;
  }
  async close(): Promise<void> {
    if (this.#pending) throw supervisorError();
    try {
      await this.file.close();
    } finally {
      await this.directory.close();
    }
  }
}
