import { lstat, realpath } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute } from "node:path";
import type { OutlookCleanupRuntime } from "./outlook-lifecycle-worker.js";
import type { OutlookRuntimeGeneration } from "./outlook-setup-repository.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUCCESS = Buffer.from('{"ok":true}\n');

export class OutlookRuntimeUnavailable extends Error {
  constructor() {
    super("Outlook browser runtime unavailable.");
    this.name = "OutlookRuntimeUnavailable";
  }
}

export interface OutlookLifecycleTransport {
  /** Trusted installation configuration, never browser request parameters. */
  readonly socketPath: string;
  readonly brokerUid: number;
  readonly socketGid: number;
  readonly timeoutMs?: number;
}

/** Internal lifecycle transport. Callers must resolve owner/generation before invoking it.
 * Installation must protect the mounted directory and its ancestors from replacement.
 * A timeout is uncertain completion; retry the same reference through durable lifecycle work.
 */
export class OutlookLifecycleClient implements OutlookCleanupRuntime {
  private readonly path: string;
  private readonly uid: number;
  private readonly gid: number;
  private readonly timeoutMs: number;

  constructor(config: OutlookLifecycleTransport) {
    const timeoutMs = config.timeoutMs ?? 45_000;
    if (
      !isAbsolute(config.socketPath) ||
      config.socketPath.includes("\0") ||
      Buffer.byteLength(config.socketPath) > 107 ||
      !Number.isSafeInteger(config.brokerUid) ||
      config.brokerUid < 0 ||
      !Number.isSafeInteger(config.socketGid) ||
      config.socketGid < 0 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000
    )
      throw new OutlookRuntimeUnavailable();
    this.path = config.socketPath;
    this.uid = config.brokerUid;
    this.gid = config.socketGid;
    this.timeoutMs = timeoutMs;
  }

  allocate(ref: OutlookRuntimeGeneration): Promise<void> {
    return this.request("allocate", ref);
  }

  remove(ref: OutlookRuntimeGeneration): Promise<void> {
    return this.request("remove", ref);
  }

  private async request(operation: "allocate" | "remove", ref: OutlookRuntimeGeneration) {
    try {
      const { runtimeId, generation } = ref;
      if (!UUID.test(runtimeId) || !Number.isSafeInteger(generation) || generation < 1)
        throw new OutlookRuntimeUnavailable();
      const parent = dirname(this.path);
      const [folder, socket, resolved] = await Promise.all([
        lstat(parent),
        lstat(this.path),
        realpath(parent)
      ]);
      if (
        resolved !== parent ||
        !folder.isDirectory() ||
        folder.uid !== this.uid ||
        folder.gid !== this.gid ||
        (folder.mode & 0o7777) !== 0o750 ||
        !socket.isSocket() ||
        socket.uid !== this.uid ||
        socket.gid !== this.gid ||
        (socket.mode & 0o7777) !== 0o660
      )
        throw new OutlookRuntimeUnavailable();
      // Reconstruct the fixed envelope: extra caller fields cannot extend the protocol.
      const request = JSON.stringify({ operation, runtimeId, generation });
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ path: this.path });
        let response = Buffer.alloc(0);
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          socket.destroy();
          if (ok) resolve();
          else reject(new OutlookRuntimeUnavailable());
        };
        const deadline = setTimeout(() => finish(false), this.timeoutMs);
        socket.once("connect", () => socket.write(request + "\n"));
        socket.on("data", (chunk: Buffer) => {
          if (response.length + chunk.length > 32) return finish(false);
          response = Buffer.concat([response, chunk]);
        });
        // Require EOF as well as the exact positive acknowledgment. A partial
        // reply, appended diagnostics or late data must never acknowledge removal.
        socket.once("end", () => finish(response.equals(SUCCESS)));
        socket.once("error", () => finish(false));
        socket.once("close", () => finish(false));
      });
    } catch {
      // Do not retain paths, request fields, raw socket errors or broker responses.
      throw new OutlookRuntimeUnavailable();
    }
  }
}
