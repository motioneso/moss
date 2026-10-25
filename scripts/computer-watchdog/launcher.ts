import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { assertTrustedPath, boundedFile, processIdentity, supervisorError } from "./trust.js";
import type { WatchdogProcessIdentity } from "./policy.js";

const ACK_TIMEOUT_MS = 7000;
const NODE_LIMIT_BYTES = 512 * 1024 * 1024;
const BUNDLE_LIMIT_BYTES = 16 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export interface FileKey {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface LaunchOptions {
  readonly nodePath: string;
  readonly bundlePath: string;
  readonly configPath: string;
  /** Lowercase hex SHA-256 of the exact node binary and bundle file the launcher may start. */
  readonly nodeSha256: string;
  readonly bundleSha256: string;
  readonly ackTimeoutMs?: number;
  /** Test seams. Production uses the defaults. */
  readonly spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  readonly readIdentity?: (pid: number) => Promise<WatchdogProcessIdentity>;
  readonly assertTrusted?: (path: string) => Promise<void>;
  readonly onSpawn?: (pid: number) => void;
}

export interface HeldWatchdog {
  readonly identity: WatchdogProcessIdentity;
  /** Kills the watchdog's whole process group. */
  readonly kill: () => void;
}

/**
 * Starts the lifetime-free `hold` watchdog and accepts it only on one signal: a single 0x01 byte
 * on the channel this function created, within the time limit, from a child whose identity has not
 * changed. Every other outcome kills the child and refuses.
 *
 * The channel is a socket pair. The child gets one end on descriptor 3 and this function keeps the
 * other, so the byte is trusted because only the child and this process hold the two ends.
 */
export async function launchHold(options: LaunchOptions): Promise<HeldWatchdog> {
  const spawn = options.spawn ?? nodeSpawn;
  const readIdentity = options.readIdentity ?? processIdentity;
  const trusted = options.assertTrusted ?? ((path: string) => assertTrustedPath(path, false));
  const args = [options.bundlePath, "hold", options.configPath];
  // Both files are checked before anything starts. Root owns every ancestor and no one else can
  // write them, so the checked file is the file spawn opens.
  const nodeKey = await verifyFile(options.nodePath, options.nodeSha256, NODE_LIMIT_BYTES, trusted);
  await verifyFile(options.bundlePath, options.bundleSha256, BUNDLE_LIMIT_BYTES, trusted);
  const child = spawn(options.nodePath, args, {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe"]
  });
  const pid = child.pid;
  if (pid === undefined) throw supervisorError();
  options.onSpawn?.(pid);
  const kill = (): void => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  };
  try {
    const channel = child.stdio[3] as Socket | null | undefined;
    // The launcher must own its end. Without one nothing here can read the child's byte.
    if (!channel || typeof channel.on !== "function") throw supervisorError();
    const before = await readIdentity(pid);
    await assertRunningImage(pid, nodeKey, [options.nodePath, ...args]);
    await receiveSignal(child, channel, options.ackTimeoutMs ?? ACK_TIMEOUT_MS);
    const after = await readIdentity(pid);
    // An exec after spawn replaces the executable or the arguments, and this catches both.
    await assertRunningImage(pid, nodeKey, [options.nodePath, ...args]);
    if (
      before.pid !== after.pid ||
      before.startTicks !== after.startTicks ||
      before.processGroupId !== after.processGroupId ||
      before.processGroupId !== pid
    )
      throw supervisorError();
    // Nothing else may arrive once the signal is in.
    channel.removeAllListeners("data");
    channel.destroy();
    return Object.freeze({ identity: before, kill });
  } catch {
    kill();
    throw supervisorError();
  }
}

function receiveSignal(child: ChildProcess, channel: Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    let received = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel.removeAllListeners("data");
      if (error) reject(error);
      else resolve();
    };
    // A socket data event is not a message boundary. Observe the whole acknowledgement
    // window so a second byte cannot be hidden in a later event after the first resolves.
    const timer = setTimeout(() => finish(received ? undefined : supervisorError()), timeoutMs);
    channel.on("data", (chunk: Buffer) => {
      if (received || chunk.length !== 1 || chunk[0] !== 1) finish(supervisorError());
      else received = true;
    });
    channel.on("error", () => finish(supervisorError()));
    channel.on("close", () => finish(supervisorError()));
    child.on("exit", () => finish(supervisorError()));
  });
}

/** Hashes the file through one descriptor, so the bytes hashed are the bytes that were checked. */
async function verifyFile(
  path: string,
  sha256: string,
  limit: number,
  trusted: (path: string) => Promise<void>
): Promise<FileKey> {
  if (!SHA256.test(sha256)) throw supervisorError();
  await trusted(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw supervisorError();
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += (chunk as Buffer).length;
      if (size > limit) throw supervisorError();
      hash.update(chunk as Buffer);
    }
    const after = await file.stat({ bigint: true });
    if (
      hash.digest("hex") !== sha256 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    )
      throw supervisorError();
    return { dev: after.dev, ino: after.ino };
  } catch {
    throw supervisorError();
  } finally {
    await file.close();
  }
}

/** The child must still be the verified node binary running exactly the arguments it was given. */
export async function assertRunningImage(
  pid: number,
  node: FileKey,
  argv: readonly string[]
): Promise<void> {
  const exe = await stat(`/proc/${pid}/exe`, { bigint: true });
  const cmdline = (await boundedFile(`/proc/${pid}/cmdline`, 65536)).toString("utf8");
  if (exe.dev !== node.dev || exe.ino !== node.ino || cmdline !== `${argv.join("\0")}\0`)
    throw supervisorError();
}
