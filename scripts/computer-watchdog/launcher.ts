import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { Socket } from "node:net";
import { processIdentity, supervisorError } from "./trust.js";
import type { WatchdogProcessIdentity } from "./policy.js";

const ACK_TIMEOUT_MS = 7000;

export interface LaunchOptions {
  readonly nodePath: string;
  readonly bundlePath: string;
  readonly configPath: string;
  readonly ackTimeoutMs?: number;
  /** Test seams. Production uses the defaults. */
  readonly spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  readonly readIdentity?: (pid: number) => Promise<WatchdogProcessIdentity>;
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
  const child = spawn(options.nodePath, [options.bundlePath, "hold", options.configPath], {
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
    await receiveSignal(child, channel, options.ackTimeoutMs ?? ACK_TIMEOUT_MS);
    const after = await readIdentity(pid);
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
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      channel.removeAllListeners("data");
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(supervisorError()), timeoutMs);
    channel.on("data", (chunk: Buffer) => {
      if (chunk.length === 1 && chunk[0] === 1) finish();
      else finish(supervisorError());
    });
    channel.on("error", () => finish(supervisorError()));
    channel.on("close", () => finish(supervisorError()));
    child.on("exit", () => finish(supervisorError()));
  });
}
